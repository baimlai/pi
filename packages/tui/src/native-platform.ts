// 按平台/架构加载可选原生扩展，给 terminal 与剪贴板调用方提供接口。
// .node 是 native/ 下手写 C/ObjC 经各平台 build 脚本生成的产物，不能逐行注释二进制。
// ESM 借 createRequire 加载 .node，真正 require 时可能执行原生模块初始化代码。
import { createRequire } from "node:module";
// 命名空间导入把路径操作收在 path 名下。
import * as path from "node:path";
// 复用安装包/源码/standalone 的候选位置顺序。
import { getNativeModuleCandidates } from "./native-module-path.ts";

// 以本模块为解析基准；此刻还没有加载平台扩展。
const cjsRequire = createRequire(import.meta.url);

// 字符串字面量联合只约束编译期；option 对应 Alt，command 对应 macOS Command/Windows 键。
export type ModifierKey = "shift" | "command" | "control" | "option";

// JS 与 native 的接口契约；Promise 声明不排除原生入口在创建异步任务前同步抛错。
export interface NativeClipboard {
	/** Undefined means unavailable, null means no text; transfer failures reject. */
	// 异步取文本：undefined 是能力/显示连接暂不可用，null 是没有文本，字符串含空串则为读到的内容。
	getText(): Promise<string | null | undefined>;
	/** Undefined means unavailable, null means no image; transfer failures reject. */
	// 异步取图片字节；实际返回的 Buffer 也满足 Uint8Array，不在本接口中保存文件。
	getImage(): Promise<Uint8Array | null | undefined>;
	/** POSIX paths of file URLs on the clipboard. Undefined means unsupported, null means no files. */
	// ? 表示方法可缺；目前 macOS 读取剪贴板 file URL 为本地 POSIX 路径数组，不读取那些文件的内容。
	getFilePaths?(): Promise<string[] | null | undefined>;
	/** Linux uses command-line tools to retain clipboard ownership instead. */
	// 可选写文本，会改变系统剪贴板；Linux helper 不提供，上层可选命令行后备。
	setText?(text: string): Promise<void>;
}

// & 交叉类型要求剪贴板必需方法，再加两个可选平台能力；不是 JS 类继承。
type NativePlatformHelper = NativeClipboard & {
	// Windows 设置 raw mode 后用它打开 VT 输入，返回配置是否成功；其他平台可缺。
	enableVirtualTerminalInput?: () => boolean;
	// 同步查当前系统修饰键，不是解析终端输入报文。
	isModifierPressed?: (name: ModifierKey) => boolean;
};

// Cache module loading, not display availability: a disconnected display can recover.
// 按 native 相对路径缓存成功对象或失败的 undefined；has 可区别“尚未试过”和“已经失败”。
const helpers = new Map<string, NativePlatformHelper | undefined>();

// 按平台、后缀及 process.arch 依次尝试 .node，返回 helper 或 undefined；例：linux + -x11。
// 首次调用同步加载并缓存成功或失败，以后不自动重试缺失模块；不调用读方法，所以此处不主动打开显示连接。
// 加载异常/缺必需方法则继续下个位置；只验证两个字段为函数，as 不验证返回类型或其他导出。
function loadNativePlatformHelper(platform: string, suffix = ""): NativePlatformHelper | undefined {
	// 取运行进程架构，不是根据机器硬件尝试交叉架构模块。
	const arch = process.arch;
	// 包只提供 x64、arm64 构建，其他架构直接不可用。
	if (arch !== "x64" && arch !== "arm64") return undefined;
	// 拼包内相对路径，随后由候选函数放到不同资源根目录下。
	const nativePath = path.join(
		// native 是原生资源顶层目录。
		"native",
		// 平台名选择 darwin/win32/linux 实现目录。
		platform,
		// prebuilds 放构建脚本生成的二进制；源码和生成器在相邻 src/、build 脚本。
		"prebuilds",
		// 平台及进程架构决定子目录，例如 darwin-arm64。
		`${platform}-${arch}`,
		// suffix 仅作文件名后缀，Linux 的 -x11 区分实现。
		`${platform}-platform${suffix}.node`,
	);
	// 缓存 undefined 也返回，避免每个按键都重复进行失败加载。
	if (helpers.has(nativePath)) return helpers.get(nativePath);

	// 按候选顺序逐个尝试，首个形状合格者胜出。
	for (const modulePath of getNativeModuleCandidates(nativePath)) {
		// 本路径缺文件、格式不符、初始化失败均由 catch 接住。
		try {
			// Partial 让字段可缺，| null 允许空值；类型断言不会检查 require 的真实返回类型。
			const helper = cjsRequire(modulePath) as Partial<NativePlatformHelper> | null;
			// 这是 native 信任边界的最小形状检查，不验证 Promise/图片格式/其他可选导出。
			if (typeof helper?.getText === "function" && typeof helper.getImage === "function") {
				// 缓存同一对象引用，不包装、复制或冻结。
				helpers.set(nativePath, helper as NativePlatformHelper);
				// 返回该 helper 并停止搜索，后面的候选不加载。
				return helper as NativePlatformHelper;
			}
			// 忽略这一候选的加载错误，继续循环尝试其他包装位置。
		} catch {
			// Try the next possible packaging location.
		}
	}
	// 所有位置失败也缓存；以后把文件装回来不会触发本进程自动重试。
	helpers.set(nativePath, undefined);
	// undefined 交给上层决定是否启用其他实现。
	return undefined;
}

// 取 macOS/Windows 平台 helper，其他系统 undefined；例：terminal 查 Shift 或打开 Windows VT。
// 复用加载缓存，不识别 SSH/终端品牌/显示会话；这些限制由调用方决定。
export function getNativePlatformHelper(): NativePlatformHelper | undefined {
	// Linux 剪贴板走下方独立入口，不经这个平台能力入口。
	if (process.platform !== "darwin" && process.platform !== "win32") return undefined;
	// 用空后缀加载；返回原对象引用。
	return loadNativePlatformHelper(process.platform);
}

/** Load a clipboard helper without opening the display until a read is requested. */
// 取可选剪贴板接口；例：Linux 必须有 DISPLAY，只有 WAYLAND_DISPLAY 不够。
// 每次重查 DISPLAY，但缓存模块结果；恢复显示后可重用同一 helper，每次读取是否成功仍由 native 决定。
// 本函数不读写剪贴板，也不运行 wl-paste 等后备命令；模块加载本身仍同步。
export function getNativeClipboard(): NativeClipboard | undefined {
	// 非 Linux 委托普通平台入口；类型缩窄不会运行时删除额外方法。
	if (process.platform !== "linux") return getNativePlatformHelper();
	// 空串/缺省都视为无 X11 显示，不将这一情况记作模块加载失败。
	if (!process.env.DISPLAY) return undefined;
	// 选择 X11 构建；真正显示连接在读请求时建立，不保证 DISPLAY 指向可用服务。
	return loadNativePlatformHelper("linux", "-x11");
}
