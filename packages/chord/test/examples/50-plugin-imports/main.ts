// 文件导读
// 所属：packages/chord/test/examples/50-plugin-imports，Chord v2 的插件导入示例（slice 12 §2、§3；决策
// "Contracts come from where the plugin's code came from"）。
// 演示什么：同一 root（同一仓库、同一提交）内的插件如何用相对路径互相导入契约文件，构建时把文件复制进调用方脚本；
// 另一个仓库的插件如何把契约作为依赖（npm 版本或 git ref）内联到安装时的提交；按种类文件（`contract.web.ts`）只允许
// 该种类的 facet 导入。本例还演示 required 根目录：app 的 `plugins/` 根里 peek 插件构建失败，`load` 在宿主加载完成后
// 以 `PluginError` 拒绝；`user/` 是非必选根，其中 reach 的失败只出现在报告的 `failed` 列表。
// 上下游：Node 直接运行本文件；本文件调用 `createPlugins` 扫描 `plugins/`、`user/`（`words/` 只作为 git 依赖的源），
// 再调用 `createHost` 加载插件。构建走 esbuild，依赖安装走 git 与 npm。结果来自宿主里的对象和构建结果；错误分两类：
// required 根失败用 PluginError 拒绝，其余失败留在报告里。
// 副作用：把三个目录复制到系统临时目录，初始化并提交一个本地 git 仓库，运行 npm install（`git+file:` 依赖，离线），
// 结束时删除临时目录；不访问网络。若中途抛错，临时目录会保留，便于排查。
// 运行（在 packages/chord 目录下；需要本机有 git 和 npm，Node 支持 --experimental-strip-types）：
//   node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// 预期输出：四组编号行。加载那一步先打印 `2. the load rejects: PluginError for @acme/peek`，随后列出 peek 与
// reach 的构建错误；最后一行打印 search 两个 facet 各自从 notes 复制了哪些文件。
// 能力清单（按本文件步骤）：
// - 1：建立 `@bob/words` 的两次提交，把第一次提交的哈希写进 user/stats/package.json 的依赖。
// - 2：`createPlugins` 配置两个根、应用 API `@acme/app` v3、server/web 两个种类和错误出口。
// - 3：`installDependencies` 在插件目录里运行 npm，把 git 依赖装进 node_modules。
// - 4：`load` 加载 server 种类，捕获 required 根的 PluginError，再从宿主 get 两个对象。
// - 5：`build` 只构建 `@acme/search`，读取 `BuiltFacet.copied` 验证复制规则。
// 示例（真实签名；配置对象省略了部分字段，完整配置见下方第 2 步）：
//   const plugins = createPlugins({ roots: [{ path: appRoot, required: true }, userRoot], api: { name: "@acme/app", versions: ["v3"] }, kinds: { server: { platform: "node", hostPackages: ["@acme/app/v3"] } }, onError: (e) => console.log(e.kind) }, context);
//   const host = createHost({ onError: () => {} });
//   await plugins.load(host, { kind: "server", core: [], modules }, context);
// 建议阅读顺序：先读下面四步的中文行注释；再按 notes -> search -> peek -> stats/words 的顺序读插件文件；最后回看
// 第 5 步的 copied 输出，把它与“同根相对导入被复制、跨仓库依赖被内联”的规则对应起来。
// Imports between plugins (slice 12 §2, §3; decision "Contracts come from where the plugin's code came from"). A plugin
// carries the contract it was written against: plugins of one root (one repository, one commit) import each other's
// contract files by relative path, copied into the importer's script; a plugin of another repository takes them as a
// dependency pinned by an npm version or a git ref, inlined at the installed commit. Per-kind contract files
// (`contract.web.ts`) are for their kind only. Here: the app's root (`plugins/`, required) with notes, search (its server
// facet using notes' shared contract, its web facet notes' web file) and peek (a server facet reaching the web file
// through a helper: refused); the user's root (`user/`) with Bob's stats plugin, whose `@bob/words` dependency is pinned
// to the first commit of a local git repository (`words/` committed twice; no network), and reach (a relative path
// out of its root: refused).
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/50-plugin-imports/main.ts
// Node 内置模块：execFileSync 同步运行 git；fs/promises 负责复制、读写和删除；os 提供临时目录；path 拼接路径；url 把
// import.meta.url 转成本地路径。
import { execFileSync } from "node:child_process";
// cp 递归复制目录，mkdtemp 创建唯一临时目录，readFile/writeFile 读写文本，rm 删除目录树。
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
// tmpdir() 返回系统临时目录；join 按平台拼接路径。
import { tmpdir } from "node:os";
import { join } from "node:path";
// fileURLToPath 把 file:// URL 转换成 fs 能使用的本地路径。
import { fileURLToPath } from "node:url";
// BACKGROUND_CONTEXT 是没有取消信号、没有 telemetry 的根上下文，适合后台工作；示例全程复用它。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 契约构建器：local 声明本地对象，int/str 声明状态成员的 schema。
import { int, local, str } from "../../../src/contracts/index.ts";
// createHost 创建宿主，宿主负责服务对象并管理引用生命周期。
import { createHost } from "../../../src/host/index.ts";
// createPlugins 是插件组件的入口；PluginError 是 required 根目录失败时 load 的拒绝类型。
import { createPlugins, PluginError } from "../../../src/node/plugins/index.ts";
// `import * as v3server` 是命名空间导入：把示例 49 的 app API 模块整体作为对象拿到。两个命名空间对象随后按
// 说明符放进 modules 表，插件脚本求值时 require("@acme/app/v3") 得到的正是这些实例（宿主包不复制进插件脚本）。
import * as v3server from "../49-plugin-api/app/v3/server.ts";
import * as v3 from "../49-plugin-api/app/v3.ts";

// 全文件共用的根上下文；示例没有取消需求，所以直接复用同一个实例。
const context = BACKGROUND_CONTEXT;

// The example installs into a plugin: it works on a copy of its directories, removed at the end.
// 临时目录名由 mkdtemp 加随机后缀生成，避免并行运行时互相覆盖；末尾的 rm 会删除整棵树。
const copy = await mkdtemp(join(tmpdir(), "chord-example-50-"));
// 逐个复制示例自带的 plugins/、user/、words/ 目录；后面的 git、npm 和文件改写只作用于副本。
for (const dir of ["plugins", "user", "words"]) {
	// import.meta.url 是当前模块的 file:// URL；new URL(相对路径, 基准) 解析出子目录 URL，再转成本地路径。
	// cp 的 { recursive: true } 允许复制目录树；await 保证复制完成后再进入下一轮。
	await cp(fileURLToPath(new URL(`./${dir}/`, import.meta.url)), join(copy, dir), { recursive: true });
}

// 1. `@bob/words` in its own git repository: version 1 committed, then version 2. Bob pinned the first commit.
// 示例内部的 git 辅助函数：cwd 指定仓库目录，...args 收集任意个命令参数；-c user.* 让提交在未配置 git 身份的
// 机器上也能成功，且不修改全局配置；encoding: "utf8" 让 execFileSync 返回字符串而不是 Buffer。
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=bob@example.com", "-c", "user.name=bob", ...args], { cwd, encoding: "utf8" });
// words 是临时副本里的依赖包目录，下一步要把它变成独立仓库。
const words = join(copy, "words");
git(words, "init", "--quiet");
// 暂存目录下的全部文件，然后创建第一个提交；--quiet 只抑制进度输出。
git(words, "add", "--all");
git(words, "commit", "--quiet", "--message", "words 1");
// rev-parse HEAD 输出当前提交哈希；trim 去掉末尾换行。这个哈希就是依赖要钉住的 ref。
const pinned = git(words, "rev-parse", "HEAD").trim();
// 读取 words.ts 的全文，把版本字面量从 1 改成 2，再写回并提交第二次。
const source = await readFile(join(words, "words.ts"), "utf8");
await writeFile(join(words, "words.ts"), source.replace('VERSION = "1"', 'VERSION = "2"'));
git(words, "commit", "--quiet", "--all", "--message", "words 2");
// --bare 克隆一个没有工作树的仓库；npm 之后从该路径按提交哈希取包，整个过程不访问网络。
git(copy, "clone", "--quiet", "--bare", words, join(copy, "words.git"));
// 改写临时副本里的 stats 清单，把依赖指向本地裸仓库的第一个提交。
const stats = join(copy, "user", "stats", "package.json");
// JSON.parse 返回 any；`as { dependencies: Record<string, string> }` 只是编译期断言，不校验 JSON 形状。
// 运行时若缺少 dependencies 字段，下一行的属性访问会抛 TypeError。
const manifest = JSON.parse(await readFile(stats, "utf8")) as { dependencies: Record<string, string> };
// git+file:// 是 npm 支持的 git 依赖写法；# 后面是分支、标签或提交哈希。
manifest.dependencies["@bob/words"] = `git+file://${join(copy, "words.git")}#${pinned}`;
// 第二、三个参数让 JSON 带制表符缩进；写回的是临时副本，源目录不受影响。
await writeFile(stats, JSON.stringify(manifest, null, "\t"));
// replace(copy, "…") 把长临时路径缩短成省略号，便于阅读输出；这里只影响显示。
console.log("1. @bob/stats depends on", manifest.dependencies["@bob/words"].replace(copy, "…"));

// 2. The component: the app's root required, the user's not; the app's API (example 49's) for both kinds.
// createPlugins 的第二个参数是 Context；创建时暂不使用，但签名要求必传。
const plugins = createPlugins(
	{
		// roots 的元素是 PluginRoot 联合类型：字符串表示非必选根，对象形式可加 required: true。
		// 第一个根是 app 自己的插件（必选），第二个是用户根（非必选）。
		roots: [{ path: join(copy, "plugins"), required: true }, join(copy, "user")],
		// api.versions 按从新到旧列出应用提供的 API 版本；插件导入未列出的版本会被构建拒绝。
		api: { name: "@acme/app", versions: ["v3"] },
		// 每个种类配一个平台和一组宿主包。web 的 hostPackages 不含 /server，所以 web facet 导入服务器模块会被拒绝。
		kinds: {
			server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server"] },
			web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web"] },
		},
		// onError 接收组件级错误（监视失败、监听器异常等）；error.kind 是可辨识联合的标签。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 3. Bob's dependencies, installed by npm into his plugin's node_modules (a git dependency at a ref is npm's own).
// installDependencies 在插件自己的目录执行固定参数的 npm install（--omit=dev --ignore-scripts 等），
// 把 git 依赖克隆到 node_modules；失败时以命令输出拒绝。
await plugins.installDependencies("@bob/stats", context);

// 4. The server loads both roots. The peek plugin of the app's root fails: so the required root's load rejects (a
//    `PluginError`, after the load settled: the others are loaded), and the app decides (here: it reports and goes on).
// modules 把说明符映射到本进程里的真实模块实例；core 是应用自己的 facet，这里为空。
const modules = { "@acme/app/v3": v3, "@acme/app/v3/server": v3server };
// 只提供 onError、不提供 store：宿主不需要持久化，未设置的存储不影响本示例。
// onError 回调为空表示示例忽略后台错误；真实应用应记录或上报。
const host = createHost({ onError: () => {} });
try {
	// load 会先加载成功插件；只有必选根失败时才在最后拒绝，所以成功插件仍可用。
	await plugins.load(host, { kind: "server", core: [], modules }, context);
} catch (error) {
	// error 的静态类型是 unknown；instanceof 把它收窄成 PluginError。其他错误原样抛出。
	if (!(error instanceof PluginError)) throw error;
	// required 只列必选根里失败的插件；map 解构出 plugin 名字段再拼成逗号分隔的字符串。
	console.log("2. the load rejects:", error.name, "for", error.required.map(({ plugin }) => plugin).join(", "));
	// failed 是整份加载报告：解构时把 error 字段重命名为 cause，避免遮蔽外层 catch 的 error。
	for (const { plugin, error: cause } of error.failed) {
		// cause 的类型是 unknown，这里断言成 Error 只为读取 message；split("\n").slice(1) 去掉第一行（文件头），
		// 再把剩余明细用分号连接成一行。
		console.log(`   ${plugin}: ${(cause as Error).message.split("\n").slice(1).join("; ")}`);
	}
}
// 下面两个契约由本进程按相同的名字、版本和 schema 重新声明；契约是数据，声明相同即可与插件里的声明绑定。
const Search = local("acme.search", { version: 1, params: {}, members: { hits: int() } });
const Stats = local("bob.stats", { version: 1, params: {}, members: { text: str() } });
// host.get 等待对象 live 后返回引用；.hits 是状态成员 Watchable，.value 读当前值。
console.log("3. search hits:", (await host.get(Search, {}, context)).hits.value);
console.log("   stats:", (await host.get(Stats, {}, context)).text.value);

// 5. The search plugin's builds: what each copied from the notes plugin (its server facet the shared file, its web
//    facet the web file too).
// build 返回普通数据 Built：facets 是本次构建的每个 facet，plugins 是发现记录；它不改变当前集合，发布由 rollout/reload 做。
const built = await plugins.build(["@acme/search"], context);
// BuiltFacet 是可辨识联合；kind 为 "failed" 的构建没有 copied 字段。
for (const facet of built.facets) {
	// 跳过失败构建后，TypeScript 把 facet 收窄到 script 分支，下面才能安全读取 copied。
	if (facet.kind !== "script") continue;
	// copied 是绝对路径数组；slice(copy.length + 1) 去掉临时根目录和分隔符，只留下相对路径。
	const copied = facet.copied.map((file) => file.slice(copy.length + 1));
	console.log(`4. @acme/search ${facet.facet} copied: ${copied.join(", ")}`);
}

// 先关闭宿主（结束对象、释放引用），再停止 watcher；最后删除临时目录，force 让目录已不存在时也不报错。
await host.close(context);
plugins.close();
await rm(copy, { recursive: true, force: true });
