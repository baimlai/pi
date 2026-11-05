// A client kind's published scripts (slice 11 §1, decisions "Slice 11, P3" and "P5"): what the server serves of the
// kind's plugins, as files under the surface's prefix, and the set its scripts object shows. Each plugin's facet is a
// script that registers itself (`<prefix>plugin/<plugin>.<digest>.js`, its stylesheet beside it), the whole set one
// combined file named by its hash (`<prefix>plugins.<hash>.js`), assets under `<prefix>assets/`; all named by their
// content, served forever. A rollout shipping the kind publishes a new set (a plugin whose new build failed keeps its
// last script) without waiting for clients; the files of the last few sets stay served for clients that still load
// them.
// 所属：node/surfaces 的插件脚本发布器；把插件管理器的构建结果变成内容寻址的内存文件。
// 职责：包装注册脚本、计算合并文件哈希、保留最近几代文件、生成 rollout step 与 ScriptSet。
// 边界：只在内存生成文件，不写盘/不发 HTTP；新构建失败的插件保留旧稿，失败列表交 rollout 汇报。
// 上游：webSurface/tuiSurface 构造并 start；下游：plugins.scripts/current、registeredSource、publishTo。
// 导出：PublishedScripts 类；KEPT_SETS/Published/SOURCE_MAP 是内部实现细节。
// 组合：start → #publish → #files → set/file；step → reload → #publish + publishTo。
// 示例：const published = new PublishedScripts("web", "web", WEB_PREFIX, base.hash, plugins, server); await published.start(ctx);
// 阅读顺序：KEPT_SETS → Published → PublishedScripts 字段/构造 → start/file → step → #publish → #files。

import { createHash } from "node:crypto";
import type { Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host, PluginFailure } from "../../host/index.ts";
import { registeredSource, type ScriptSet } from "../../surfaces/index.ts";
import type { Built, PluginScript, Plugins, RolloutStep } from "../plugins/index.ts";
import { publishTo, type SurfaceName } from "./current.ts";
import { CSS, JAVASCRIPT, mimeOf, type ServedFile } from "./served.ts";

/** How many sets' files stay served: the current one and the few before it, for clients loading them meanwhile. */
// 保留当前代和之前三代文件：已打开但尚未刷新的页面仍能按旧 URL 取脚本；不做单文件 LRU。
const KEPT_SETS = 4;

/** One plugin's published script: its digest, its registered text, its stylesheet. */
/**
 * One plugin's published script: its digest, its registered text, its stylesheet and assets (kept with the script: a
 * plugin whose next build fails keeps all three).
 */
// 一个插件的发布稿：摘要、包装后的注册文本、可选 CSS 和资产；失败时整组沿用，避免版本错配。
type Published = {
	// readonly 约束调用者不重新赋值；assets 是只读数组类型，字节仍共享，按约定不修改。
	readonly digest: string;
	readonly text: string;
	readonly css: string | undefined;
	readonly assets: readonly { readonly name: string; readonly bytes: Uint8Array }[];
};

/** A script's inline source map comment. */
// 合并文件会去掉每个注册脚本末尾的内联 source map：浏览器每个文件只读一个 map，多个反而浪费字节。
const SOURCE_MAP = /\n\/\/# sourceMappingURL=data:[^\n]*/g;

/** A client kind's published scripts. */
export class PublishedScripts<P extends Principal> {
	// # 前缀是真正的JavaScript私有字段；readonly 仅禁止构造后替换字段引用，不阻止 Map 内容更新。
	// #surface 决定将集合发布给哪个 current 对象；#kind 选择插件管理器中的脚本种类；#prefix 是 URL 前缀。
	// #base 是基础包摘要，原样放进 ScriptSet.base；#plugins 提供构建结果；#host 用于 publishTo。
	// #current 是当前每个插件的发布稿；#sets 是最近几代文件表（最新在末尾）；#set 是对外公开的 JSON 集合。
	readonly #surface: SurfaceName;
	readonly #kind: string;
	readonly #prefix: string;
	readonly #base: string;
	readonly #plugins: Plugins;
	readonly #host: Host<P>;
	/** The published script of each plugin now. */
	readonly #current = new Map<string, Published>();
	/** The files of the last `KEPT_SETS` sets, newest last, each by path. */
	readonly #sets: ReadonlyMap<string, ServedFile>[] = [];
	#set: ScriptSet | undefined;

	// 记住一个界面的发布上下文，不构建或发布；surface选对象，kind选插件脚本，prefix/base决定URL与版本。
	// 例如 web + 自定义kind "browser" 仍发布WebScripts，但读取插件管理器的browser脚本。随后须调用start。
	constructor(surface: SurfaceName, kind: string, prefix: string, base: string, plugins: Plugins, host: Host<P>) {
		// 显式赋值保留这些对象引用；没有复制host或plugins，也没有建立网络连接。
		this.#surface = surface;
		this.#kind = kind;
		this.#prefix = prefix;
		this.#base = base;
		this.#plugins = plugins;
		this.#host = host;
	}

	/** The set published now (after `start`). */
	// 读取最近构造的集合，不做I/O；要求调用方已await start。例：start后set.combined是合并脚本URL。
	get set(): ScriptSet {
		// ! 是非空断言，只让TypeScript相信已初始化；若提前读取，运行时仍可能得到undefined。
		return this.#set!;
	}

	/**
	 * Takes the kind's current set as the first one (its plugins' facets of the kind built on first use), before the
	 * server's load (the scripts object starts with it). The plugins whose build failed.
	 */
	// 初始化发布：向插件管理器取得此kind的完整脚本并生成首代文件，返回构建失败的插件列表。
	// 例如一个插件失败且无旧稿时它不会入set；start不调用publishTo，因为对应对象还要随服务器load创建。
	// scripts 可能首次构建，context取消或获取失败会拒绝；成功的发布会修改本实例的Map、历史和set。
	async start(context: Context): Promise<readonly PluginFailure[]> {
		// 先await完整脚本集合，再同步更新发布状态；readonly失败数组是静态只读返回类型。
		return this.#publish(await this.#plugins.scripts(this.#kind, context));
	}

	/** A published file by its path, from the last few sets. */
	// 由发布URL查保留的文件，从最新代往旧代找；返回共享文件对象或undefined，无额外I/O。
	// 例如上一代URL在最近4个set之内仍可找到，超出保留窗口则可能404。
	file(path: string): ServedFile | undefined {
		// 倒序for每次减1，优先使用最近代中相同路径的记录。
		for (let index = this.#sets.length - 1; index >= 0; index--) {
			const found = this.#sets[index]!.get(path);
			// index范围由循环控制，!仅为类型提示；找到即返回，不继续扫描旧代。
			if (found !== undefined) return found;
		}
		// 所有保留代都缺少该URL时明确返回空值，served将它转换为404。
		return undefined;
	}

	/**
	 * The rollout step publishing the kind's current set as the rollout applied its build: one "host" named `name`, its
	 * report the plugins whose new build failed (they keep their last script, and stay dirty). Clients are not waited for.
	 */
	// 生成名为name的rollout步骤；创建时不发布，reload回调执行时读取管理器已应用的当前脚本集合。
	// 回调同步构造新文件再调用publishTo更新host状态，返回added/changed/removed及失败列表；错误向外拒绝。
	// 例如插件摘要a变b被列为changed；客户端是否下载完成不在该步骤的等待范围内。
	step(name: string): RolloutStep {
		return {
			name,
			kinds: [this.#kind],
			// _built 表示此回调不用参数正文，依赖rollout预先更新plugins.current；context约束对象调用等待。
			reload: async (_built: Built, context: Context) => {
				// 展开Map为键值对数组，解构只取旧digest；构造快照以便与后续状态比较。
				const before = new Map([...this.#current].map(([plugin, { digest }]) => [plugin, digest]));
				// 没有kind当前集合时采用空数组，会移除旧集合；构建失败的条目由#publish保留旧稿。
				const failed = this.#publish(this.#plugins.current(this.#kind) ?? []);
				await publishTo(this.#host, this.#surface, this.set, context);
				// 新集合已经写入本实例；发布失败会在await处拒绝，不回滚这里生成的文件。
				const after = [...this.#current];
				const plugins = {
					// filter选择新增项，map只取插件名；before.has区别首次出现和旧项更新。
					added: after.filter(([plugin]) => !before.has(plugin)).map(([plugin]) => plugin),
					changed: after
						// 只有原来存在且摘要不同才算changed；相同摘要表示内容未变。
						.filter(([plugin, { digest }]) => before.has(plugin) && before.get(plugin) !== digest)
						.map(([plugin]) => plugin),
					removed: [...before.keys()].filter((plugin) => !this.#current.has(plugin)),
				};
				// 此步骤只发布脚本，无服务端对象的reload fate，因此objects为空数组。
				return { hosts: [{ host: name, report: { plugins, failed, objects: [] } }] };
			},
		};
	}

	/**
	 * Takes `scripts` (the kind's complete set) as the current one: a failed build keeps its plugin's last script; its
	 * files kept with the last few sets'. The plugins whose build failed.
	 */
	// 将完整scripts集合变成当前发布稿，返回失败项；成功稿替换旧稿，失败稿有旧版本时沿用，没有时略去。
	// 例如传入A成功/B失败会发布A新稿与B旧稿；完全没出现在scripts中的C被删除。
	// 同步修改当前Map、最多4代文件历史与set；包装/哈希失败会抛出，不是事务式回滚。
	#publish(scripts: readonly PluginScript[]): readonly PluginFailure[] {
		// 分开积累失败报告和下一代脚本，避免一边遍历旧状态一边删改。
		const failed: PluginFailure[] = [];
		const next = new Map<string, Published>();
		// 每项带插件元信息与判别联合built；kind判断后TS知道成功分支存在source/css/assets。
		for (const { plugin, built } of scripts) {
			if (built.kind === "script") {
				const text = registeredSource(plugin.name, built.digest, built.source);
				// ?. 在无CSS时给undefined；资产与脚本文本一起保留，失败后可完整沿用。
				next.set(plugin.name, { digest: built.digest, text, css: built.css?.text, assets: built.assets });
				continue;
			}
			// 失败分支把多个构建诊断拼成Error；不会把旧脚本也当作新成功稿。
			failed.push({ plugin: plugin.name, error: new Error(built.errors.join("\n")) });
			const kept = this.#current.get(plugin.name);
			// 只有确实发布过的旧版本可保留，新插件首次失败就没有可用稿。
			if (kept !== undefined) next.set(plugin.name, kept);
		}
		// 清空后按插件名排序插入，Map遍历顺序即后面set与合并脚本的确定顺序。
		this.#current.clear();
		for (const [name, each] of [...next].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			this.#current.set(name, each);
		const { set, files } = this.#files();
		// 最新文件表放末尾，超过固定代数时移走最老一代；并非按单文件LRU缓存。
		this.#sets.push(files);
		if (this.#sets.length > KEPT_SETS) this.#sets.shift();
		this.#set = set;
		// 返回报告供start或rollout使用；失败插件仍会被上层保留dirty标记。
		return failed;
	}

	/**
	 * The set of the current scripts and its files: each script (its source map inline), stylesheet and asset, and the
	 * combined file (without source maps: a browser reads only one per file, so they would be bytes for nothing).
	 */
	// 从当前有序脚本Map生成一代URL文件表与ScriptSet；不写磁盘，只UTF-8编码并计算合并脚本摘要。
	// 例如@scope/name以@scope~name作为URL单段；单插件文件保留其source map，合并文件移除内联map。
	// 返回新对象，调用者负责保存历史；摘要是合并JavaScript正文的前16位SHA-256十六进制字符。
	#files(): { set: ScriptSet; files: Map<string, ServedFile> } {
		const files = new Map<string, ServedFile>();
		// 索引访问类型 ScriptSet["plugins"][number] 表示plugins数组的单个元素类型，后面的[]再组成数组。
		const entries: ScriptSet["plugins"][number][] = [];
		const combined: string[] = [];
		// Map条目与对象属性双层解构，直接拿到发布稿的所有组成部分。
		for (const [name, { digest, text, css, assets }] of this.#current) {
			// A plugin name (`@scope/name`) as one path segment, its slash a tilde: the set's URLs are looked up as they
			// are, never parsed back.
			const stem = `${this.#prefix}plugin/${name.replace("/", "~")}.${digest}`;
			// TextEncoder将JS文本编码为UTF-8；样式缺失时不创建.css文件。
			files.set(`${stem}.js`, { mime: JAVASCRIPT, bytes: new TextEncoder().encode(text) });
			if (css !== undefined) files.set(`${stem}.css`, { mime: CSS, bytes: new TextEncoder().encode(css) });
			// 条件展开对象只在确有CSS时添加css属性，避免把undefined字段混入JSON集合。
			entries.push({ name, digest, url: `${stem}.js`, ...(css === undefined ? {} : { css: `${stem}.css` }) });
			combined.push(text.replace(SOURCE_MAP, ""));
			// 资产使用构建时给出的内容文件名和原字节，按扩展名取MIME。
			for (const asset of assets) {
				files.set(`${this.#prefix}assets/${asset.name}`, { mime: mimeOf(asset.name), bytes: asset.bytes });
			}
		}
		// 不加额外分隔符合registeredSource每稿自带结尾换行的约定。
		const body = combined.join("");
		const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
		// 合并文件也按内容命名，旧页面可继续取其原来的集合URL。
		const url = `${this.#prefix}plugins.${hash}.js`;
		files.set(url, { mime: JAVASCRIPT, bytes: new TextEncoder().encode(body) });
		// set仅含摘要和URL等JSON数据，文件字节留在files，通过HTTP按需读取。
		return { set: { base: this.#base, combined: url, plugins: entries }, files };
	}
}
