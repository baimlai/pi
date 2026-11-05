/**
 * DOOM Engine - WebAssembly wrapper for doomgeneric
 */

/**
 * 文件导读（doom-overlay 的 WASM 引擎包装）
 *
 * 所属与用途：本文件属于 `doom-overlay` 示例，封装 Emscripten 编译出的 doomgeneric WASM 模块：
 * 读取 WAD、在虚拟文件系统中注入 WAD、初始化 C 引擎、逐帧推进、拷贝 RGBA 帧、推入按键。
 * 它不负责终端渲染或覆盖层布局。
 *
 * 上游如何进入：`index.ts` 构造 `DoomEngine(wadPath)` 并 `await init()`；`doom-component.ts`
 * 之后定时调用 `tick()`、读取 `getFrameRGBA()`、通过 `pushKey()` 发送按键。
 * 下游产物：`doom/build/doom.js`（Emscripten 生成的 JS 胶水，不要手改）和同目录 `doom.wasm`，
 * 由 `doom/build.sh` 从 `doomgeneric` 上游 C 源码与 `doomgeneric_pi.c` 构建。
 *
 * 能力清单：
 * - `DoomModule`：生成模块的预期导出接口（仅编译期描述）。
 * - `DoomEngine.init`：读 WAD + 动态执行生成的 JS + 创建模块 + 初始化 C 引擎。
 * - `initDoom`：构造 argc/argv 并调用 `_doomgeneric_Create`。
 * - `tick`：推进一帧；`getFrameRGBA`：把 ARGB 帧转成 RGBA；`pushKey`：入键盘队列。
 * - `width`/`height`/`isInitialized`：只读状态。
 *
 * 典型运行顺序：
 *   1. 先运行 `doom/build.sh`（需要 emcc），确认 `doom/build/doom.js` 与 `doom.wasm` 存在；
 *   2. `new DoomEngine("/path/doom1.wad")`；
 *   3. `await engine.init()`；
 *   4. 循环 `engine.tick()` + `engine.getFrameRGBA()`，按键调用 `engine.pushKey(true/false, key)`。
 *
 * 示例（真实签名）：
 *   const engine = new DoomEngine("./doom1.wad");
 *   await engine.init();
 *   engine.tick();
 *   const rgba = engine.getFrameRGBA(); // 长度 = width * height * 4
 * 初始化前 `tick`/`pushKey` 静默无操作，`getFrameRGBA` 返回全零数组。
 *
 * 建议阅读顺序：先看 `DoomModule` 了解可调用的 C 导出，再读 `init` 的加载流程，
 * 然后看 `initDoom` 的内存布局，最后看帧转换与按键。
 *
 * 失败行为：缺少 `doom.js`、WAD 不可读、生成 JS 抛错、工厂未返回模块，都会让 `init()` 的
 * Promise 拒绝；`init` 没有重复调用保护，重复调用会重新加载并覆盖模块。
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 接口只描述生成模块的预期形状，TS 编译时检查使用方式，不会运行时验证加载结果。
// 以 _ 开头的是导出的 C/WASM 函数；数字指针是 WASM 线性内存的字节偏移，不是 JS 对象引用。
export interface DoomModule {
	// argc 是参数个数，argv 指向一组32位指针；初始化 C 引擎。
	_doomgeneric_Create: (argc: number, argv: number) => void;
	// 推进一次游戏逻辑；其余 DG 导出由 doomgeneric_pi.c 提供。
	_doomgeneric_Tick: () => void;
	// 返回像素区起始地址。
	_DG_GetFrameBuffer: () => number;
	// 返回构建时的像素宽。
	_DG_GetScreenWidth: () => number;
	// 返回构建时的像素高。
	_DG_GetScreenHeight: () => number;
	// 把按下标记与单字节键码入 C 环形队列。
	_DG_PushKeyEvent: (pressed: number, key: number) => void;
	// 在 WASM 内存中申请字节数并返回地址。
	_malloc: (size: number) => number;
	// 释放先前 malloc 得到的地址。
	_free: (ptr: number) => void;
	// 同一线性内存的无符号8位视图；本包装器实际主要通过 getValue/setValue 访问。
	HEAPU8: Uint8Array;
	// 同一内存的无符号32位视图。
	HEAPU32: Uint32Array;
	// 把 JS 数字数组写入 Emscripten 虚拟文件系统，末两参数是读写权限。
	FS_createDataFile: (parent: string, name: string, data: number[], canRead: boolean, canWrite: boolean) => void;
	// 在虚拟文件系统内创建路径；不等同于在宿主磁盘 mkdir。
	FS_createPath: (parent: string, path: string, canRead: boolean, canWrite: boolean) => string;
	// 按给定 C 类型把数字写入线性内存。
	setValue: (ptr: number, value: number, type: string) => void;
	// 按给定 C 类型读取数字。
	getValue: (ptr: number, type: string) => number;
}

/**
 * 一份 DOOM WASM 引擎实例。
 *
 * 生命周期：构造只保存 WAD 路径；`init()` 完成磁盘读取、动态执行生成 JS、WASM 实例化和 C 初始化；
 * 之后才能 `tick`/`pushKey`。类没有清理方法，WASM 内存随实例或进程回收。
 * 状态字段不是并发安全的：不要在 `init()` 进行中调用其他方法。
 * 示例：`const e = new DoomEngine("./doom1.wad"); await e.init(); e.tick();`
 */
export class DoomEngine {
	// private 由 TS 限制类外访问；| null 表示尚未加载，运行时仍是普通字段。
	private module: DoomModule | null = null;
	// 缓存 C 返回的帧缓冲字节地址；尚未初始化时为0。
	private frameBufferPtr: number = 0;
	// 成功完成初始化后才允许 tick 和输入。
	private initialized = false;
	// 构造函数保存的宿主 WAD 路径。
	private wadPath: string;
	// 加载前使用默认宽；init 之后用 WASM 的实际导出值覆盖。
	private _width = 640;
	// 默认高也不是运行时分辨率校验。
	private _height = 400;

	/**
	 * 保存 WAD 路径，不加载任何文件。
	 *
	 * 输入：宿主 WAD 路径；存在性/格式不在这里验证。
	 * 输出：实例。副作用：只写 `this.wadPath`。
	 * 错误路径：无（空字符串也会接受）。
	 * 示例：`const e = new DoomEngine("./doom1.wad");` 之后必须 `await e.init()`。
	 */
	constructor(wadPath: string) {
		// 把参数保存到实例供异步 init 使用。
		this.wadPath = wadPath;
	}

	/**
	 * 当前帧宽（像素）。
	 *
	 * 输入/输出：无参数，返回 `_width`。副作用：无。
	 * 初始化前是默认 640，init 成功后是 WASM 导出的实际宽。
	 * 示例：`engine.width` 可作为 `getFrameRGBA` 返回数组的宽度依据。
	 */
	get width(): number {
		// 读取实例字段；get 让调用方用属性语法访问。
		return this._width;
	}

	/**
	 * 当前帧高（像素）。
	 *
	 * 输入/输出：无参数，返回 `_height`。副作用：无。
	 * 初始化前是默认 400，init 成功后是 WASM 导出的实际高。
	 * 示例：`engine.height` 与 `width` 相乘再乘 4 得到 RGBA 数组长度。
	 */
	get height(): number {
		// 返回缓存的像素高。
		return this._height;
	}

	/**
	 * 加载并初始化 WASM 引擎。
	 *
	 * 输入：无（使用构造时保存的 `wadPath`）。
	 * 输出：`Promise<void>`，成功即表示 `tick`/`pushKey` 可用。
	 * 副作用：同步读取 WAD 与生成的 `doom.js`；动态执行该 JS；创建 WASM 实例；在 Emscripten
	 * 虚拟文件系统中创建 `/doom/doom1.wad`；调用 C 初始化。不写宿主文件。
	 * 错误路径：JS 文件缺失时抛带构建提示的错误；WAD 读取、生成 JS 执行、模块工厂拒绝、
	 * 工厂返回空值时错误向调用方传播（后两者会让 Promise 拒绝）。
	 * 主要流程：定位 build 目录 -> 检查 doom.js -> 读 WAD -> 读 JS -> 执行 CommonJS 包装 ->
	 * 准备 locateFile/preRun -> await 工厂 -> initDoom -> 缓存帧地址与尺寸 -> 标记 initialized。
	 * 注意：没有“已初始化”门禁；重复调用会重新创建模块并覆盖 `this.module`。
	 *
	 * 示例：`await engine.init()` 成功后 `engine.isInitialized()` 返回 true；
	 * 若缺少 `doom/build/doom.js`，会得到 `WASM not found at ... Run ./doom/build.sh first`。
	 */
	async init(): Promise<void> {
		// Locate WASM build
		// 把当前模块 URL 转成本机目录，用于相对定位示例构建输出。
		const __dirname = dirname(fileURLToPath(import.meta.url));
		// 拼出 doom/build，不创建目录。
		const buildDir = join(__dirname, "doom", "build");
		// 定位 Emscripten 的 JS 胶水文件。
		const doomJsPath = join(buildDir, "doom.js");

		// 只先检查 JS 存在；WASM 缺失等问题由后面的加载过程报错。
		if (!existsSync(doomJsPath)) {
			// 提示构建命令并拒绝 init 的 Promise。
			throw new Error(`WASM not found at ${doomJsPath}. Run ./doom/build.sh first`);
		}

		// Read WAD file
		// 同步读取宿主 WAD，找不到/无权限会直接抛错。
		const wadData = readFileSync(this.wadPath);
		// 把字节视图复制为普通 number[]，符合 FS_createDataFile 的接口。
		const wadArray = Array.from(new Uint8Array(wadData));

		// Load WASM module - eval to bypass jiti completely
		// 将生成 JS 全文读成字符串。
		const doomJsCode = readFileSync(doomJsPath, "utf-8");
		// 声明 exports 可装任意值；unknown 强制后面显式决定其预期类型。
		const moduleExports: { exports: unknown } = { exports: {} };
		// 创建以生成文件为基准的 Node require。
		const nativeRequire = createRequire(doomJsPath);
		// new Function 动态编译本地生成 JS，显式提供 CommonJS 环境参数；不是静态 import。
		const moduleFunc = new Function("module", "exports", "__dirname", "__filename", "require", doomJsCode);
		// 立即执行生成 JS，让其填充 module.exports。
		moduleFunc(moduleExports, moduleExports.exports, buildDir, doomJsPath, nativeRequire);
		// as 是 TS 类型断言，不检查 exports 真是异步工厂；不符合时调用仍会失败。
		const createDoomModule = moduleExports.exports as (config: unknown) => Promise<DoomModule>;

		// 配置生成工厂；以下回调由 Emscripten 加载过程中调用。
		const moduleConfig = {
			// 输入待定位文件名，返回 WASM 的完整路径，其他资源名原样返回；如 doom.wasm 定位到 build 目录。
			locateFile: (path: string) => {
				// 只对 .wasm 后缀改写路径。
				if (path.endsWith(".wasm")) {
					// 把 WASM 与 JS 固定在同一构建目录查找。
					return join(buildDir, path);
				}
				// 非 WASM 资源交还生成器的原路径。
				return path;
			},
			// 空回调丢弃引擎标准输出，没有写终端。
			print: () => {},
			// 空回调同样丢弃引擎错误输出；JS 异常仍可抛出。
			printErr: () => {},
			// 初始化前钩子数组；模块加载器会在运行 C 初始化前执行。
			preRun: [
				// 参数是加载器传来的模块；创建虚拟目录并注入 WAD，不写宿主文件。
				(module: DoomModule) => {
					// Create /doom directory and add WAD
					// 创建虚拟 /doom 目录且允许读写。
					module.FS_createPath("/", "doom", true, true);
					// 以统一名称 doom1.wad 提供刚读到的内容，允许读取而禁止写入。
					module.FS_createDataFile("/doom", "doom1.wad", wadArray, true, false);
				},
			],
		};

		// 等待模块加载成功后保存到实例；拒绝时后续步骤不执行。
		this.module = await createDoomModule(moduleConfig);
		// 保留现有加载结果判空分支；接口描述本身不保证第三方运行时结果。
		if (!this.module) {
			// 工厂没有返回模块时显式报错。
			throw new Error("Failed to initialize DOOM module");
		}

		// Initialize DOOM
		// 在虚拟文件准备好之后调用 C 初始化。
		this.initDoom();

		// Get framebuffer info
		// 取得帧缓冲起始地址用于以后逐像素读取。
		this.frameBufferPtr = this.module._DG_GetFrameBuffer();
		// 用构建时导出的宽覆盖默认值。
		this._width = this.module._DG_GetScreenWidth();
		// 同样缓存导出的高。
		this._height = this.module._DG_GetScreenHeight();
		// 所有步骤成功才开放游戏操作。
		this.initialized = true;
	}

	/**
	 * 把固定命令行参数编码进 WASM 内存并调用 C 初始化。
	 *
	 * 输入：无；使用 `this.module`。
	 * 输出：无返回值。副作用：用 `_malloc` 分配临时内存、`setValue` 写入、`_doomgeneric_Create`
	 * 初始化引擎，最后 `_free` 释放临时内存。不会写宿主文件。
	 * 错误路径：模块为空时静默返回；`_malloc`/`setValue`/C 调用抛错时异常直接传播，且没有
	 * `finally`，已分配内存可能泄漏。
	 * 主要流程：为每个 ASCII 参数字符串分配 `length+1` 字节并写 NUL 结尾 -> 分配 argv 指针数组
	 * （WASM32 每个指针 4 字节）-> 调用 Create -> 释放所有字符串与 argv。
	 *
	 * 示例：参数为 `["doom","-iwad","/doom/doom1.wad"]`，虚拟引擎看到的 argc=3，
	 * argv[0] 指向 "doom"。这不是通用 UTF-8 编码器，只适用于当前的 ASCII 路径。
	 */
	private initDoom(): void {
		// 还没有模块时不做任何事。
		if (!this.module) return;

		// 固定三个命令参数；路径位于虚拟文件系统。
		const args = ["doom", "-iwad", "/doom/doom1.wad"];
		// number[] 保存每个 C 字符串的首地址。
		const argPtrs: number[] = [];

		// 逐个参数申请内存并写入。
		for (const arg of args) {
			// 额外一个字节给 C 字符串结尾的零。
			const ptr = this.module._malloc(arg.length + 1);
			// 按 JS 字符索引遍历这个 ASCII 字符串；每个字符写一个 i8 字节，地址按字节递增。
			for (let i = 0; i < arg.length; i++) {
				this.module.setValue(ptr + i, arg.charCodeAt(i), "i8");
			}
			// 写零字节，标识字符串结束（C 字符串的 NUL 终止符）。
			this.module.setValue(ptr + arg.length, 0, "i8");
			// 记录地址供 argv 指针数组使用。
			argPtrs.push(ptr);
		}

		// 每个 WASM32 指针占4字节，申请连续指针数组。
		const argvPtr = this.module._malloc(argPtrs.length * 4);
		for (let i = 0; i < argPtrs.length; i++) {
			// ! 是非空断言，TS 不再把索引结果视为 undefined；没有额外运行时检查。
			this.module.setValue(argvPtr + i * 4, argPtrs[i]!, "i32");
		}

		// 传入参数数量和指针数组地址；C 引擎在此实际初始化。
		this.module._doomgeneric_Create(args.length, argvPtr);

		// 初始化返回后逐个释放临时 C 字符串。
		for (const ptr of argPtrs) {
			// 释放当前函数分配的字符串内存；这里假定 C 侧不会在返回后继续保留这些指针。
			// 若上游实现保存了 argv 指针，后续使用会变成悬空引用，JS 层无法验证这一约定。
			this.module._free(ptr);
		}
		// 最后释放指针数组本身。
		this.module._free(argvPtr);
	}

	/**
	 * Run one game tick
	 */
	/**
	 * 推进一帧游戏逻辑。
	 *
	 * 输入/输出：无参数、无返回值。
	 * 副作用：调用 C 的 `_doomgeneric_Tick`，可能改写 WASM 内部帧缓冲和游戏状态。
	 * 错误路径：未初始化时静默返回；C 内部抛出的 WASM 异常会向上传播（组件据此退出）。
	 * 示例：组件每约 28.6ms 调用一次；手动调用 `engine.tick()` 也只会推进一帧，
	 * 不会自动重绘终端。
	 */
	tick(): void {
		// 缺模块或未完成初始化便静默忽略。
		if (!this.module || !this.initialized) return;
		// 调用 C 引擎的一帧逻辑，可能改写帧缓冲和游戏状态。
		this.module._doomgeneric_Tick();
	}

	/**
	 * Get current frame as RGBA pixel data
	 * DOOM outputs ARGB, we convert to RGBA
	 */
	/**
	 * 把当前帧复制成 RGBA 字节数组。
	 *
	 * 输入：无。输出：新分配的 `Uint8Array`，长度 `width*height*4`，顺序为 R/G/B/A。
	 * 副作用：逐像素读取 WASM 线性内存；不修改帧缓冲。未初始化时返回全零数组（alpha 也是 0）。
	 * 错误路径：不抛错；帧缓冲地址无效时会读到意外值，但不会由 JS 层校验。
	 * 主要流程：遍历每个像素 -> 读有符号 32 位 ARGB -> 掩码提取 RGB -> alpha 固定 255。
	 *
	 * 示例：一个 ARGB 值 `0x00ff0000` 会写成 `[255, 0, 0, 255]`。
	 * 真实 DOOM 帧是 640x400（默认构建），数组约 1MB；每帧调用都会重新分配。
	 */
	getFrameRGBA(): Uint8Array {
		// 尚无可读引擎时使用默认/缓存尺寸分配空帧。
		if (!this.module || !this.initialized) {
			// 新数组初始字节全为0，包括 alpha。
			return new Uint8Array(this._width * this._height * 4);
		}

		// 像素总数是宽乘高。
		const pixels = this._width * this._height;
		// 每像素四个字节，一次调用分配一份输出。
		const buffer = new Uint8Array(pixels * 4);

		// 按连续像素顺序转换整帧。
		for (let i = 0; i < pixels; i++) {
			// 从字节首地址加 i*4 读取有符号32位值，后面掩码会截出无符号通道。
			const argb = this.module.getValue(this.frameBufferPtr + i * 4, "i32");
			// 计算该像素在输出 RGBA 数组中的首字节位置。
			const offset = i * 4;
			// 右移16位并与255按位与，得到红色通道。
			buffer[offset + 0] = (argb >> 16) & 0xff; // R
			// 右移8位提取绿色。
			buffer[offset + 1] = (argb >> 8) & 0xff; // G
			// 低8位是蓝色。
			buffer[offset + 2] = argb & 0xff; // B
			// 有效帧一律写成完全不透明。
			buffer[offset + 3] = 255; // A
		}

		// 交还独立数组，调用者修改它不改 C 帧缓冲。
		return buffer;
	}

	/**
	 * Push a key event
	 */
	/**
	 * 向 DOOM 的 C 按键队列推入一个事件。
	 *
	 * 输入：`pressed` 为 true 表示按下、false 表示松开；`key` 是 DOOM 键码（见 doom-keys.ts）。
	 * 输出：无。副作用：写入 WASM 里的固定大小环形队列；未初始化时静默忽略。
	 * 错误路径：不抛错；队列满时 C 代码丢弃事件，调用方无法得知。
	 * 示例：`pushKey(true, 13)` 排入回车按下，`pushKey(false, 13)` 排入回车松开；
	 * 键码超出 unsigned char 范围时由 C 截断，不在这里校验。
	 */
	pushKey(pressed: boolean, key: number): void {
		// 模块和初始化标记都就绪才发送输入。
		if (!this.module || !this.initialized) return;
		// 三元表达式把 boolean 转成 C 接口的1或0，键码由 C unsigned char 截为单字节。
		this.module._DG_PushKeyEvent(pressed ? 1 : 0, key);
	}

	/**
	 * 查询引擎是否已完成初始化。
	 *
	 * 输入/输出：无参数，返回缓存的布尔标记。
	 * 副作用/错误：无；只读标记，不重新检查 WASM 模块是否仍有效。
	 * 示例：新建后返回 false，`await init()` 成功后返回 true；WASM 内部崩溃不会自动把它改回 false。
	 */
	isInitialized(): boolean {
		// 只读取标记，不再次检查 WASM 状态。
		return this.initialized;
	}
}
