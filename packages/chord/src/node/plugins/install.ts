// Installing (slice 7c §5, decision "Slice 7c's points" (3); slice 12 §5, decision "`chord.plugins` is a package's
// manifest of plugins"): a plugin's npm dependencies as coding-agent installs a package's (`npm install` in the
// plugin's real directory without dev dependencies, host peers or lifecycle scripts; the command overridable), and new
// plugins from git (a shallow clone of a ref) or npm (a packed tarball extracted), each staged in a hidden directory of
// the root, checked as discovery sees it, then renamed into place. Nothing a source supplies reaches git or npm as an
// option: refs, URLs and names starting with `-` are refused, and positional arguments follow `--`.

// 本文件负责安装：给已有插件安装 npm 依赖，或把 git/npm 上的新插件装进某个根目录。
// 上游是 Plugins 组件的 installDependencies/installPlugin（应用的管理命令调用），以及安装完成后重新发现并构建；
// 下游是 discover.ts（用与运行时相同的规则检查包）和 node:child_process（npm、git、tar）。
// 安全边界：来源提供的 ref、URL、包名和版本不能变成命令行选项——以 - 开头的值被拒绝，位置参数前加 `--`；
// 安装不运行生命周期脚本，也不等待任何凭据输入。
// 文件导读
// 所属模块：packages/chord/src/node/plugins 的安装层，对应 slice 7c §5 与 slice 12 §5。
// 职责边界：运行 npm 安装插件依赖，或把 git/npm 来源的新插件放进根目录；不发现已有插件（除了冲突检查）、不构建、
// 不加载。所有解包先进入根内隐藏暂存目录，检查通过后才原子重命名到最终位置。
// 上游入口：Plugins 组件的 installDependencies/installPlugin 方法，通常由应用的管理命令或开发服务器调用。
// 下游依赖：discover.ts（discoverPackage 检查暂存包、discoverPlugins 检查名字冲突）、node:child_process 的 npm/git/tar、
// 文件系统的 mkdir/mkdtemp/rename/rm。
// 结果与错误流向：installDependencies 成功无返回，失败拒绝并带命令输出；installPlugin 成功返回插件名数组，失败拒绝，
// 且只回滚本次创建的目标/暂存/空 scope 目录。来源值若可能被解析成命令行选项，在启动任何进程前就拒绝。
// 能力清单：
// - InstallOptions：可替换的 npm 命令（默认 ["npm"]）。
// - InstallPluginOptions：额外的 facet kinds 与用于冲突检查的全部 roots。
// - PluginSource：git(URL,ref) 或 npm(name,version) 的可辨识联合。
// - installDependencies(plugin, context, options)：在插件真实目录安装生产依赖。
// - installPlugin(source, root, context, options)：暂存、检查、放入并安装新插件，返回名字。
// 组合与顺序：installPlugin -> targetName 校验 -> removeStaleStaging -> claim 占位 -> mkdtemp 暂存 -> clone/unpack ->
// checkPackage -> rename -> discoverPackage -> 对每个插件 installDependencies。依赖安装使用 --ignore-scripts，且 Git 禁止
// 终端凭据提示。
// 示例：const names = await installPlugin(
//   { git: "https://example.com/acme/notes.git", ref: "v1.2.0" }, "/app/plugins", context);
// 真实调用会把仓库浅克隆到 /app/plugins/notes 并返回 ["notes"]；示例 URL 不是实际可访问地址。
// 建议阅读顺序：PluginSource/选项类型 -> installPlugin 主流程 -> targetName/claim 的安全与并发控制 ->
// checkPackage -> run 子进程封装 -> clone/unpack。
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Context } from "../../context/index.ts";
import { isPluginName } from "../../host/staging.ts";
import { discoverPackage, discoverPlugins, type Plugin, type PluginRoot } from "./discover.ts";

// 安装选项：只允许替换 npm 命令（例如 pnpm），git 和 tar 固定按程序名从 PATH 调用。
// npmCommand 是数组，第一项是命令，其余是前缀参数（例如 ["corepack", "pnpm"]）。
/** What installs take: the npm command (`["npm"]` by default, e.g. `["pnpm"]`); git and tar are run as `git`, `tar`. */
export type InstallOptions = { readonly npmCommand?: readonly string[] };

/** What `installPlugin` takes besides the source and the root. */
export type InstallPluginOptions = InstallOptions & {
	/** The app's facet kinds: a package whose top has a facet file is one plugin (`[]` by default). */
	// kinds 用于判断一个包顶层是否有 facet 文件；默认空数组表示不按 facet 文件识别，只认 chord.plugins 或子目录。
	readonly kinds?: readonly string[];
	/** Every root of the app: a new plugin named like one in any of them is refused (`[root]` by default). */
	// roots 是应用的全部根目录，安装前用来检查名字冲突；默认只检查本次目标根。
	readonly roots?: readonly PluginRoot[];
};

/** Where `installPlugin` installs from: a git repository at a ref (a branch, tag or commit), or an npm package. */
// 安装来源的可辨识联合：git 需要 URL 和 ref（分支、标签或提交），npm 需要包名和版本。
// 两者的字段名不同，函数里用 `"git" in source` 在运行时区分并收窄类型。
export type PluginSource =
	| { readonly git: string; readonly ref: string }
	| { readonly npm: string; readonly version: string };

/** The install's arguments: production dependencies only, no host peers, no scripts, no audit or funding notes. */
// 固定安装参数：只装生产依赖，忽略 peer 解析冲突，不执行 prepare/install 等脚本，不输出审计和赞助信息。
// --ignore-scripts 是供应链安全措施：插件依赖不能在安装时执行任意代码。
const INSTALL_ARGS = ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"];

/**
 * Installs `plugin`'s `dependencies` into its own `node_modules` (`npm install --omit=dev --legacy-peer-deps
 * --ignore-scripts --no-audit --no-fund` in its real directory; git dependencies with a ref are npm's). Rejects with
 * the command's output when it fails, and when `context` aborts (the command is killed). A single-file plugin has
 * nothing to install.
 */
// 在插件自己的目录安装它的 dependencies。
// 输入：plugin（必须有目录布局）、context（可中止）、options（npm 命令）；输出：安装完成的 Promise<void>。
// 副作用：启动外部 npm 进程并写插件的 node_modules；错误：单文件插件、命令非零退出或 context 中止时拒绝。
// 主要流程：拒绝单文件插件 -> 拆出命令和前缀参数 -> 在 plugin.dir 运行固定参数。
// 例子：installDependencies(plugin, context) 等价于在该插件目录执行 npm install 的固定参数版本；
// 真实错误消息会带上插件名、命令和子进程输出。
export async function installDependencies(
	plugin: Plugin,
	context: Context,
	options: InstallOptions = {},
): Promise<void> {
	// 单文件插件没有 package.json 和依赖声明，安装依赖没有意义；这是调用顺序错误，直接抛出。
	if (plugin.layout === "file") throw new Error(`plugin "${plugin.name}": a single-file plugin has no package.json`);
	// 数组解构：第一项是命令，...prefix 收集其余参数；npmCommandOf 保证命令非空且返回值是元组类型。
	const [command, ...prefix] = npmCommandOf(options);
	// 前缀参数在固定安装参数之前；run 的最后一个字符串只用于错误消息，不参与命令行。
	await run(command, [...prefix, ...INSTALL_ARGS], plugin.dir, context, `plugin "${plugin.name}": ${command} install`);
}

/**
 * Installs new plugins into `root` from `source`, then their dependencies: from git, a shallow clone of the ref into
 * `<root>/<repository name>`; from npm, the packed package extracted into `<root>/<name>`. The package's plugins are
 * its `chord.plugins` folders, else by convention (discovery's rules). Returns their names. Refused: a source option
 * (`-…`), an invalid name, an existing directory (no updating in place: install another ref, or delete and install), a
 * package discovery reports a problem in or finds no plugin in, a plugin name another plugin of `options.roots` has.
 * Only what this install created is removed on failure.
 */
// 把 source 安装为 root 下的新插件，并安装其依赖。
// 输入：source（git 或 npm）、目标根、上下文、选项；输出：新插件名字数组（按发现顺序）。
// 副作用：创建隐藏暂存目录、运行 git/npm/tar、把目录重命名到最终位置、可能运行依赖安装。
// 错误：来源像选项、名字非法、目标已存在、包内发现问题、找不到插件、与其他根重名、命令失败或中止都会拒绝；
// 失败时只删除本次创建的目标、暂存目录和空的 scope 目录。
// 主要流程：算目标名 -> 清理陈旧暂存 -> 原子占位目标目录 -> 解到暂存目录 -> 按发现规则检查 ->
// 重命名到目标 -> 再发现一次并安装各插件依赖 -> 返回名字。
// 例子：installPlugin({ git: "https://host/acme/notes", ref: "v1.2.0" }, "/app/plugins", context)
// 把仓库浅克隆到 /app/plugins/notes 并安装依赖，返回 ["notes"]。
export async function installPlugin(
	source: PluginSource,
	root: string,
	context: Context,
	options: InstallPluginOptions = {},
): Promise<readonly string[]> {
	// 先从来源推导目录名并在推导过程中拒绝危险值；此时还没有触碰文件系统。
	const name = targetName(source);
	// 清除一小时前崩溃安装留下的隐藏暂存目录；不删除新鲜的暂存目录，避免干扰并发安装。
	await removeStaleStaging(root);
	// 用非递归 mkdir 占住 <root>/<name>：已存在则立刻失败，两个并发安装只有一个能成功。
	const made = await claim(root, name);
	// staging 在 try 外声明，finally 才能清理；undefined 表示还没创建，跳过清理。
	let staging: string | undefined;
	try {
		// Hidden: discovery skips it while it is staged; in the root: the rename stays on one file system.
		// mkdtemp 在根内创建以 .chord-install- 开头的唯一隐藏目录：发现逻辑会跳过点开头目录，
		// 放在同一个根内又保证最后 rename 不跨文件系统。
		staging = await mkdtemp(join(root, STAGING));
		// 包内容统一解到暂存目录下的 package 子目录，git 与 npm 两条路径因此共用后面的检查与重命名。
		const staged = join(staging, "package");
		// `"git" in source` 是运行时属性检查，同时让 TypeScript 把联合收窄到 git 分支。
		if ("git" in source) await clone(source.git, source.ref, staged, context);
		// 非 git 分支即 npm 分支；unpack 需要 options 才能使用自定义 npm 命令。
		else await unpack(source.npm, source.version, staged, context, options);
		// 按真实根目录的发现规则检查暂存内容；错误消息里的暂存路径会被换成最终路径。
		await checkPackage(staged, made.target, root, context, options);
		// The claimed directory is empty: renaming onto it moves the package into place in one step. Windows renames onto
		// no existing directory: there the claim is released first (a concurrent install of the name may then win).
		// Windows 的 rename 不能覆盖已存在目录，所以先删掉自己刚占位的空目录；
		// 这留下一个短暂窗口，另一个并发安装可能抢先占住该名字。
		if (process.platform === "win32") await rmdir(made.target);
		// 把暂存包目录整体重命名到目标位置；同一根内同一文件系统，通常是原子操作。
		await rename(staged, made.target);
		// 放到最终位置后再发现一次，是为了得到以最终路径为基准的 Plugin 记录（依赖安装需要它们的 dir）。
		const { plugins } = await discoverPackage(made.target, atRoot(root, options), context);
		// 每个新插件都在自己的真实目录安装生产依赖；逐个 await，任一失败会进入下面的回滚。
		for (const plugin of plugins) await installDependencies(plugin, context, options);
		// 只返回名字，调用方通常随后触发一次重新发现/构建；插件对象本身不在这里暴露。
		return plugins.map((plugin) => plugin.name);
		// 安装失败的回滚只处理本次创建的东西：目标目录、可能需要删除的 scope 目录、暂存目录。
	} catch (error) {
		// recursive 删除整个目标；force 忽略不存在，其他文件系统错误仍会抛出。
		await rm(made.target, { recursive: true, force: true });
		// scope 目录（<root>/@scope）只有在本次创建时才记录；rmdir 是非递归的，
		// 若并发安装已把另一个包放进去，删除失败被忽略，不会破坏别人的目录。
		if (made.scope !== undefined) await rmdir(made.scope).catch(() => {});
		// 原样重抛安装错误，保留 cause 和调用方看到的上下文。
		throw error;
	} finally {
		// 无论成功失败都删除暂存目录；它在根内且隐藏，失败时也不应留下半成品。
		if (staging !== undefined) await rm(staging, { recursive: true, force: true });
	}
}

/** The prefix of an install's staging directory in a root (hidden: discovery skips it). */
// 暂存目录前缀；点开头使常规发现跳过它，避免安装过程中的半成品被当成插件。
const STAGING = ".chord-install-";

/** How old a staging directory must be to count as left over by a crashed install. */
// 一小时的宽限期：比正常安装长得多，避免把另一个正在进行的安装的暂存目录删掉。
const STALE_MS = 60 * 60 * 1000;

/** Removes staging directories in `root` an install crashed out of (older than an hour). */
// 删除崩溃安装遗留的暂存目录。
// 输入：根目录；输出：无；副作用：可能递归删除旧目录。
// 错误：根目录不可读时当作没有内容（catch 返回空数组）；单个目录 stat 失败也跳过。
// 例：一个两小时前的 .chord-install-xxxx 会被删除，五分钟前的保留。
async function removeStaleStaging(root: string): Promise<void> {
	// 只扫描根的直接子项；catch 的返回类型断言把失败转成空列表，隐藏安装前的只读问题。
	const names = await readdir(root).catch(() => [] as string[]);
	// filter 先按前缀缩小范围，再逐个 stat 读取修改时间。
	for (const name of names.filter((each) => each.startsWith(STAGING))) {
		const path = join(root, name);
		// stat 跟随符号链接；失败（例如正好被别的进程删除）当作 undefined，不阻止本次安装。
		const info = await stat(path).catch(() => undefined);
		// 只删除足够旧的目录；mtimeMs 与 Date.now 都是毫秒。
		if (info !== undefined && Date.now() - info.mtimeMs > STALE_MS) await rm(path, { recursive: true, force: true });
	}
}

/** The directory name a source installs into: the repository's name, or the package's (validated) name. */
// 由来源得到目标目录名，并在此拒绝所有可能被解释成命令行选项的值。
// git：去掉末尾斜杠和 .git 后取路径最后一段作为仓库名；npm：包名必须符合 npm 包名规则。
// 错误：空值、以 - 开头的 URL/ref/包名/版本、推导出的仓库名为空或以 . 或 - 开头、非法 npm 名。
// 例：{git:"https://host/a/notes.git", ref:"main"} -> "notes"；{npm:"@acme/notes", version:"1.2.3"} -> "@acme/notes"。
function targetName(source: PluginSource): string {
	// 局部检查函数：空字符串或 - 开头的值会被下游命令当成选项，因此统一在此拒绝。
	// what 只用于错误消息，标明是 repository、ref、package 还是 version。
	const option = (value: string, what: string) => {
		if (value === "" || value.startsWith("-")) throw new Error(`installPlugin: ${what} "${value}" is refused`);
	};
	if ("git" in source) {
		option(source.git, "repository");
		option(source.ref, "ref");
		// 去掉末尾的 / 再取 basename，然后去掉 .git 后缀；例如 .../notes.git/ -> notes。
		const name = basename(source.git.replace(/\/+$/, "")).replace(/\.git$/, "");
		// 隐藏目录（.开头）和选项式名字都不接受；空名字说明 URL 没有可用的最后一段。
		if (name === "" || name.startsWith(".") || name.startsWith("-")) {
			throw new Error(`installPlugin: "${source.git}" names no repository directory`);
		}
		return name;
	}
	// npm 分支同样先拒绝空值和 - 开头的包名/版本。
	option(source.npm, "package");
	option(source.version, "version");
	// 作用域包名也必须满足 isPluginName；这避免 ../x 之类的名字逃出根目录。
	if (!isPluginName(source.npm)) throw new Error(`installPlugin: "${source.npm}" is not an npm package name`);
	return source.npm;
}

/**
 * Creates `<root>/<name>` (and a scope directory `<root>/@scope` it needs) without `recursive`, so an existing one
 * refuses the install and a concurrent install of the same name loses here; returns what it created.
 */
// 原子占位最终目录，返回本次创建的目标（以及为作用域包创建的 scope 目录）。
// 输入：根和经过校验的名字；输出：{target, scope?}。
// 错误：目标已存在时抛错；遇到其他 mkdir 错误也抛错，并尽量清理自己刚创建的 scope。
// 非递归 mkdir 是并发控制：谁先创建成功，谁拥有这个名字。
async function claim(root: string, name: string): Promise<{ readonly target: string; readonly scope?: string }> {
	// join 对作用域包会得到 <root>/@scope/name；dirname 在下面取出 scope 目录。
	const target = join(root, name);
	let scope: string | undefined;
	if (name.startsWith("@")) {
		const dir = dirname(target);
		try {
			// 先尝试创建作用域目录；成功时记录为本次创建，失败回滚时才有权删除。
			await mkdir(dir);
			scope = dir;
		} catch (error) {
			// EEXIST 表示另一个同名作用域的包已经存在，可以共用目录；其他错误继续抛。
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	// 目标目录本身必须由本次创建；成功即占位完成。
	try {
		await mkdir(target);
	} catch (error) {
		// 目标创建失败：如果 scope 是本次创建的且现在为空，删除它；catch 忽略“非空/已不存在”等情况，
		// 不删除可能属于并发安装的包。
		if (scope !== undefined) await rmdir(scope).catch(() => {});
		// EEXIST 转成用户可读的“已存在”，而不是暴露系统错误码。
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(`installPlugin: ${target} exists already`);
		}
		throw error;
	}
	// scope 是可选字段：只有作用域包且本次创建了 scope 时才包含它；返回类型与上面的对象字面量一致。
	return scope === undefined ? { target } : { target, scope };
}

/** The root a package is discovered as part of. */
// 构造 discoverPackage 需要的根上下文：安装目标不属于必选根，kinds 默认空数组。
function atRoot(root: string, options: InstallPluginOptions) {
	return { root, required: false, kinds: options.kinds ?? [] };
}

/**
 * Checks the package staged at `staged` (going to `target`): discovery reports no problem in it, finds a plugin, and
 * none of its plugins' names is taken in the app's roots.
 */
// 在移动前检查暂存包。
// 输入：staged 暂存路径、target 最终路径、root、context、options。
// 输出：通过时正常返回；错误：发现到第一条问题、没有任何插件、或插件名已被应用其他根占用。
// 副作用：读取文件系统和现有根；不执行插件代码、不安装依赖。
// 例：包里有非法 package.json 时，错误消息把 staged 前缀替换成 target，让用户看到将来位置。
async function checkPackage(
	staged: string,
	target: string,
	root: string,
	context: Context,
	options: InstallPluginOptions,
): Promise<void> {
	// 以最终根为上下文发现暂存目录：这样 facet 文件路径和 root 字段都按部署后的位置计算。
	const { plugins, problems } = await discoverPackage(staged, atRoot(root, options), context);
	// 数组解构取第一条问题即可；安装以“全有或全无”处理，不尝试部分安装。
	const [problem] = problems;
	if (problem !== undefined)
		// replace 只替换路径前缀，让错误指向安装后的位置，而不是稍后会被删除的暂存目录。
		throw new Error(`installPlugin: ${problem.path.replace(staged, target)}: ${problem.error}`);
	// 一个包可以合法地只含契约，但安装新插件时要求至少有一个能被发现的插件，否则 rename 后没有意义。
	if (plugins.length === 0) throw new Error(`installPlugin: ${target} holds no plugin`);
	// 发现应用现有根中的插件；options.roots 未提供时默认只查目标根。
	// 这里重新扫描磁盘，而不是复用组件缓存，因为安装可能发生在组件生命周期之外。
	const installed = await discoverPlugins(options.roots ?? [root], { kinds: options.kinds ?? [] }, context);
	// 对暂存包里的每个插件名，查找现有根中的同名插件；find 找到即冲突。
	for (const plugin of plugins) {
		const other = installed.plugins.find((each) => each.name === plugin.name);
		if (other !== undefined) throw new Error(`installPlugin: plugin "${plugin.name}" is in ${other.dir} already`);
	}
}

/** The npm command of `options`. */
// 拆出 npm 命令与前缀参数。
// 返回值标成 readonly [string, ...string[]]（非空元组），让调用处知道第一项一定存在。
// 错误：配置了空数组时抛出，属于编程错误。
function npmCommandOf(options: InstallOptions): readonly [string, ...string[]] {
	// ?? 只在 npmCommand 为 undefined 时使用默认 ["npm"]；空数组是合法输入，会在下一行被拒绝。
	const [command, ...prefix] = options.npmCommand ?? ["npm"];
	if (command === undefined) throw new Error("npmCommand is empty");
	return [command, ...prefix];
}

/** Runs `command` in `cwd`; rejects naming `what` with its output when it fails, and when `context` aborts. */
// 运行一个外部命令并收集输出。
// 输入：命令、参数数组、工作目录、context、what（错误前缀）；输出：stdout 文本。
// 副作用：启动子进程；context 中止时通过 signal 终止它。
// 错误：启动失败（找不到命令）通过 error 事件拒绝；非零退出码以包含合并输出的错误拒绝；中止时也拒绝。
// 主要流程：先检查已中止 -> spawn -> 同时收集 stdout/stderr -> 等待 close -> 检查退出码。
// 例子：run("git", ["init","--quiet"], dir, context, what) 成功返回空字符串。
async function run(
	command: string,
	args: readonly string[],
	cwd: string,
	context: Context,
	what: string,
): Promise<string> {
	// spawn 之前先响应中止，避免不必要地启动进程；throwIfAborted 在未中止时什么也不做。
	context.abortSignal?.throwIfAborted();
	const child = spawn(command, args, {
		cwd,
		// stdin 忽略：安装不应等待输入；stdout/stderr 用管道，便于收集进错误消息和返回 stdout。
		stdio: ["ignore", "pipe", "pipe"],
		// signal 让 Node 在 context 中止时向子进程发送终止信号；Promise 会因中止而拒绝。
		signal: context.abortSignal,
		// Never a prompt for credentials: an install runs unattended.
		// 合并当前环境并强制关闭 Git 的终端凭据提示：无人值守安装不能卡在交互输入上。
		// 展开 process.env 保留 PATH、HOME 等必需变量。
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	// output 合并两路输出用于错误消息；stdout 单独保存，因为 npm pack --json 的调用方要从标准输出解析结果。
	let output = "";
	let stdout = "";
	// data 事件的块类型标注为 Buffer；toString 默认按 UTF-8 解码。两个流可能分多块到达，因此用 += 累积。
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		stdout += chunk.toString();
	});
	// stderr 只进入合并输出；命令失败时用户能看到 npm/git 的具体原因。
	child.stderr.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	// 用 Promise 把事件式子进程适配成 await：close 给出退出码（被信号杀死时为 null），error 表示根本没跑起来。
	// 两者只可能先发生其一；Promise 只采用第一次 settle。
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	// 0 才是成功；null（信号终止）或非零都拒绝，消息包含去除首尾空白的合并输出。
	if (code !== 0) throw new Error(`${what} failed (exit ${code}): ${output.trim()}`);
	// 成功时只返回 stdout；installDependencies 忽略它，unpack 用它解析 npm 的 JSON。
	return stdout;
}

/** A shallow clone of `ref` (a branch, tag or commit) of `url` into `dir` (made), detached at it. */
// 浅克隆 URL 的某个 ref 到 dir，并检出为分离 HEAD。
// 输入：url、ref、已创建的空目录、context；输出：无。
// 错误：git 非零退出时 run 拒绝，错误前缀写明 URL 和 ref。
// 不用 `git clone`，而是 init+fetch+checkout，便于把 url/ref 放在 `--` 之后并只取一个提交。
async function clone(url: string, ref: string, dir: string, context: Context): Promise<void> {
	// 目录已由调用方的暂存流程预留；git init 需要它存在且为空。
	await mkdir(dir);
	const what = `git clone of ${url} at ${ref}`;
	// 在目标目录初始化空仓库；--quiet 抑制提示。
	await run("git", ["init", "--quiet"], dir, context, what);
	// --depth 1 只取一个提交；`--` 终止选项解析，即使 URL 或 ref 以 - 开头也不会变成 git 选项
	// （targetName 已拒绝这类值，这里是第二道防线）。
	await run("git", ["fetch", "--quiet", "--depth", "1", "--", url, ref], dir, context, what);
	// FETCH_HEAD 指向刚取回的提交；checkout 到分离 HEAD，不创建本地分支。
	// -c advice.detachedHead=false 关闭“分离 HEAD”提示；末尾 `--` 表示后面没有路径参数。
	await run("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", "FETCH_HEAD", "--"], dir, context, what);
}

/** npm package `name` at `version` packed (`npm pack`) and extracted into `dir` (made). */
// 用 npm pack 把包打成 tarball，再解到 dir。
// 输入：包名、版本、目标目录、context、npm 命令选项；输出：无。
// 副作用：在暂存目录旁创建临时目录、运行 npm pack 和 tar；错误由 run 拒绝。
// 例：unpack("@acme/notes", "1.2.3", staged, context) 最终把 tarball 的 package/ 内容解到 staged。
async function unpack(
	name: string,
	version: string,
	dir: string,
	context: Context,
	options: InstallOptions,
): Promise<void> {
	const [command, ...prefix] = npmCommandOf(options);
	// pack 临时目录放在 dir 的父目录（即本次安装的隐藏暂存目录）内，finally 清理暂存时一起删除。
	const packed = await mkdtemp(join(dirname(dir), "pack-"));
	const what = `${command} pack ${name}@${version}`;
	// --json 让 npm 输出机器可读结果；--pack-destination 指定落地目录；`--` 后才是 name@version，
	// 防止版本字符串被解析成选项。
	const args = [...prefix, "pack", "--json", "--pack-destination", packed, "--", `${name}@${version}`];
	// npm's own output: a list of the packed tarballs.
	// 信任边界：解析 npm 自己的 JSON 输出。as 只描述预期形状，运行时未校验 filename 是否存在或为字符串。
	// 数组解构取第一个 tarball；没有输出时 tarball 为 undefined。
	const [tarball] = JSON.parse(await run(command, args, packed, context, what)) as { readonly filename: string }[];
	// 空数组意味着 npm 没有打包任何东西，属于失败而不是解一个不存在的文件。
	if (tarball === undefined) throw new Error(`${what}: packed nothing`);
	// 目标目录必须存在；tar 不会替我们创建。
	await mkdir(dir);
	// basename 去掉 npm 可能返回的路径成分，确保 tar 读取的是 pack 目录内的文件名。
	const file = join(packed, basename(tarball.filename));
	await run("tar", ["-xzf", file, "--strip-components=1", "-C", dir], packed, context, `extracting ${name}`);
	// -xzf 解压 gzip tarball；--strip-components=1 去掉 npm 包的顶层 package/ 目录；-C 指定目标目录。
	// 命令在 pack 临时目录中运行，file 是绝对路径。
}
