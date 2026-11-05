// 手工图片显示程序：读取命令行指定的本地文件，按 PNG 头部取尺寸，交 Image 组件生成图片协议或文字回退，最后启动真实主屏 TUI。
// 它不是自动化断言；模块顶层会读盘、输出日志、可能冷探测终端能力并接管 stdin/stdout，所以静态审阅不能证明真实终端已显示出图片。
// 导入同步文件读取函数，原 fs 写法保留；读取错误在下面捕获，不会自动下载或创建示例图片。
import { readFileSync } from "fs";
// 图片组件只保存 base64/尺寸/主题；render 时根据终端能力返回图片控制序列或回退文本，由 TUI 真正写出。
import { Image } from "../src/components/image.ts";
// Spacer 用空字符串行预留垂直间隔，不是图片像素边距。
import { Spacer } from "../src/components/spacer.ts";
// Text 渲染标题、失败说明与操作提示。
import { Text } from "../src/components/text.ts";
// 真实进程终端适配器，start 后会监听 stdin、协商协议并写 stdout。
import { ProcessTerminal } from "../src/terminal.ts";
// getCapabilities 可初始化共享能力缓存，tmux分支可能做同步只读查询；getImageDimensions 仅从支持格式头部读取宽高，不完整解码验证图像。
import { getCapabilities, getImageDimensions } from "../src/terminal-image.ts";
// type TUI 只约束宿主接口，运行时擦除。
import type { TUI } from "../src/tui.ts";
// 实际选择主屏 TUI，不进入全屏备用屏布局。
import { TuiMainScreen } from "../src/tui-main-screen.ts";

// argv[2] 是脚本后的第一个参数；|| 让缺失或空串使用 /tmp/test-image.png。只是选路径，不检查扩展名或文件是否存在。
const testImagePath = process.argv[2] || "/tmp/test-image.png";

// 立即获取并打印能力对象；冷缓存可能按环境识别/查询 tmux，并非只登记一个未来回调。
console.log("Terminal capabilities:", getCapabilities());
// 打印即将读取的实际路径，尚未读文件。
console.log("Loading image from:", testImagePath);

// 先声明可重赋的 Buffer 变量，类型只用于 TS；后面的 try 成功时才给它赋字节数据。
let imageBuffer: Buffer;
// 用 try 捕获本次同步读取失败，下面 catch 处理路径无效或权限等异常。
try {
	// 实际同步读取整份本地文件到内存 Buffer；未传编码所以得到字节，不是字符串。
	imageBuffer = readFileSync(testImagePath);
	// 捕获读取异常但不使用 _e 的错误详情；只输出统一失败信息。
} catch (_e) {
	// 向 stderr 报告失败路径，没有把原异常堆栈打印出来。
	console.error(`Failed to load image: ${testImagePath}`);
	// 输出手工运行用法，提示可传图片路径，不负责生成默认文件。
	console.error("Usage: node test/image-test.ts [path-to-image.png]");
	// 立即以退出码1结束进程，不再继续构造 TUI；Node 的 process.exit 返回类型为 never，TS 据此知道成功路径会给 imageBuffer 赋值。
	process.exit(1);
}

// 把读入字节编码成 base64 字符串，不改变原 Buffer，也不上传文件。
const base64Data = imageBuffer.toString("base64");
// 明确按 image/png 解析头部尺寸，即使传入路径扩展名不是 PNG 也不会自动按扩展名选择格式；返回尺寸对象或 null，不证明整个文件有效。
const dims = getImageDimensions(base64Data, "image/png");

// 打印解析到的像素宽高或 null，尚未启动 TUI。
console.log("Image dimensions:", dims);
// 输出一个空行分隔前面的诊断信息与后面的界面。
console.log("");

// 创建 ProcessTerminal，构造时尚未启用 raw 输入。
const terminal = new ProcessTerminal();
// 创建主屏 TUI 并以 TUI 接口标注，实际实例仍是 TuiMainScreen。
const tui: TUI = new TuiMainScreen(terminal);

// 添加标题，Text 的两个1分别是左右各1列和上下各1行边距。
tui.addChild(new Text("Image Rendering Test", 1, 1));
// 在标题后增加一条空白占位行。
tui.addChild(new Spacer(1));

// 只有 PNG 头部尺寸解析成功才创建图片组件；这里没有另外检查尺寸正数、完整载荷或终端真的支持图片。
if (dims) {
	// 把下面创建的 Image 追加到组件树，不在 addChild 时立刻发送图片。
	tui.addChild(
		// 传 base64、声明 PNG MIME、黄色文字回退函数、最多60列布局及已解析像素尺寸。回调 s 由接口推断为字符串，返回 SGR33/0 包裹文本；真实图片像素不会被这个函数染黄。
		new Image(base64Data, "image/png", { fallbackColor: (s) => `\x1b[33m${s}\x1b[0m` }, { maxWidthCells: 60 }, dims),
	);
	// 尺寸不可解析时走文本说明分支，不创建 Image 对象，也不会尝试别的文件格式。
} else {
	// 添加左右1列、上下0行边距的失败说明。
	tui.addChild(new Text("Could not parse image dimensions", 1, 0));
}

// 图片或失败说明后都预留一个空白行。
tui.addChild(new Spacer(1));
// 添加退出提示；真正的退出输入处理写在下面焦点对象里。
tui.addChild(new Text("Press Ctrl+C to exit", 1, 0));

// 构造最小输入接收对象，只有 handleInput，没有完整 Component 的 render/invalidate；它不作为可见子组件加入树。
const editor = {
	// 输入方法接已分好的字符串，返回 void：只检查首码元是否原始 Ctrl+C，满足时先停 TUI 再退出；例如单字符0x03可触发，Kitty编码的 Ctrl+C 不会通过这个首码元检查。
	handleInput(data: string) {
		// charCodeAt(0) 比较数字3；这不是 matchesKey 协议识别，也未要求整个输入字符串恰好一个字符。
		if (data.charCodeAt(0) === 3) {
			// 请求主屏正常停止，解除适配器监听并尝试复原终端模式；若 stop 抛错，下一行退出不会保证执行。
			tui.stop();
			// stop 正常返回后立即以0退出，不等待尚未完成的其他异步任务。
			process.exit(0);
		}
	},
};

// 原有 as any 绕过缺少 render/invalidate 的类型检查，只把对象传给焦点 API，不补出这些方法；它不因此成为完整可渲染组件。
tui.setFocus(editor as any);
// 在模块顶层启动真实终端与首帧，实际可发送图片控制串/能力查询；本文件没有自动化测试隔离或浏览器预览步骤。
tui.start();
