/**
 * DOOM Engine - WebAssembly wrapper for doomgeneric
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

// 管理一份 WASM 引擎及其帧缓冲；init 有磁盘读取、动态执行生成 JS 和 WASM 初始化副作用。
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

	// 构造只保存 WAD 路径，无读取或启动；例：new DoomEngine("./doom1.wad") 后仍须 await init()。
	constructor(wadPath: string) {
		// 把参数保存到实例供异步 init 使用。
		this.wadPath = wadPath;
	}

	// 只读访问器返回当前宽，无副作用；例：engine.width 初始化前为640。
	get width(): number {
		// 读取实例字段；get 让调用方用属性语法访问。
		return this._width;
	}

	// 只读访问器返回当前高，无副作用；例：engine.height 初始化前为400。
	get height(): number {
		// 返回缓存的像素高。
		return this._height;
	}

	// 无参数，异步加载生成 JS/WASM 并把 WAD 放进虚拟文件系统；成功返回 Promise<void>。
	// 依次读取文件、执行模块工厂、初始化 C 参数、缓存帧信息；文件/执行/工厂错误向调用者传播。
	// 例：await engine.init() 成功后 tick() 才实际推进；此方法没有重复初始化门禁。
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

	// 将固定命令参数编码成 C 的 argc/argv，调用创建函数，再释放临时内存；无返回。
	// 例：虚拟命令相当于 doom -iwad /doom/doom1.wad；只编码这里的 ASCII 参数，不是通用 UTF-8 编码器。
	// C 调用抛错时无 finally，因此本函数不保证异常路径释放已申请内存。
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
			// 按 JS 字符索引遍历这个 ASCII 字符串。
			// 把各字符串地址写进数组对应槽。
			for (let i = 0; i < arg.length; i++) {
				// 每个字符写一个 i8 字节，地址按字节递增。
				// 写零字节，标识字符串结束。
				this.module.setValue(ptr + i, arg.charCodeAt(i), "i8");
			}
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
			// 释放当前字符串内存。
			// 最后释放指针数组本身。
			this.module._free(ptr);
		}
		this.module._free(argvPtr);
	}

	/**
	 * Run one game tick
	 */
	// 无参数、无返回；已初始化时推进一次逻辑，异常向上传播；例：组件定时约每1/35秒调用。
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
	// 无参数，返回新分配 RGBA 字节数组，不返回 WASM 原内存视图；无初始化时返回全零数组。
	// 逐像素读取32位 ARGB 并拆色，alpha 固定255；例：0x00ff0000 转为 [255,0,0,255]。
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
	// 输入按下/松开布尔值和键码，入 C 队列，无返回；未初始化则忽略。
	// 例：pushKey(true, 13) 排入回车按下；C 队列满时静默丢弃，调用方收不到成功标记。
	pushKey(pressed: boolean, key: number): void {
		// 模块和初始化标记都就绪才发送输入。
		if (!this.module || !this.initialized) return;
		// 三元表达式把 boolean 转成 C 接口的1或0，键码由 C unsigned char 截为单字节。
		this.module._DG_PushKeyEvent(pressed ? 1 : 0, key);
	}

	// 无参数，返回初始化标记，无副作用；例：新建后为false，init成功后为true。
	isInitialized(): boolean {
		// 只读取标记，不再次检查 WASM 状态。
		return this.initialized;
	}
}
