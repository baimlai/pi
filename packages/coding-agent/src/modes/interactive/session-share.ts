// 按设置分享会话：Radius上传当前分支JSONL，Gist上传全历史HTML；还负责等待界面、取消提示与临时文件清理。分享内容未在本文件做脱敏。
// spawn异步运行gh创建gist，spawnSync同步检查gh登录；这些是真实外部命令入口，导入本身不会启动命令。
import { spawn, spawnSync } from "node:child_process";
// 命名空间导入crypto，生成分享尾项的随机短id。
import * as crypto from "node:crypto";
// 命名空间fs用于临时目录、导出内容读取和删除，后面均为同步文件操作。
import * as fs from "node:fs";
// os.tmpdir读取操作系统配置的临时目录，不以process.cwd为选择依据。
import * as os from "node:os";
// path.join只拼接本机路径，不验证文件是否存在。
import * as path from "node:path";
// Radius上传地址使用这个固定默认网关常量；下面并不从已找到provider里读取自定义baseUrl。
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
// Container/EditorComponent/TUI只导入类型，hyperlink是运行函数，把文字包成终端OSC8链接串，不自动打开浏览器。
import { type Container, type EditorComponent, hyperlink, type TUI } from "@earendil-works/pi-tui";
// 从已解析认证中取非空apiKey或Authorization Bearer文本；它不验证服务端是否真的接受该凭证。
import { getAuthCredential } from "../../cli/auth-command.ts";
// Gist id转分享查看器URL，支持环境变量基址；只是拼文字，不上传或打开页面。
import { getShareViewerUrl } from "../../config.ts";
// AgentSession仅作为上下文类型，运行时擦除，不在这里新建会话。
import type { AgentSession } from "../../core/agent-session.ts";
// 复用当前分支JSONL导出，保留条目id、按导出次序重连parentId，可额外添加不写回原会话的尾项。
import { exportSessionToJsonl } from "../../core/session-export.ts";
// 带边框的可取消等待组件，构造即启动动画；dispose只停动画，不等同取消网络/进程。
import { BorderedLoader } from "./components/bordered-loader.ts";
// 当前主题为模块导出的实时绑定，导出HTML时读取theme.name，动画也用其颜色。
import { theme } from "./theme/theme.ts";

// 宿主提供会话、编辑器和UI回调的结构契约；接口只约束TS，不在运行时校验传入对象。
interface SessionShareContext {
	// 会话提供分支、当前工具/提示词、设置和模型认证运行时。
	session: AgentSession;
	// TUI宿主负责焦点及重画请求。
	ui: TUI;
	// 当前编辑区域容器，上传时清空并换成Loader。
	editorContainer: Container;
	// 原编辑组件引用，恢复时重新挂载，不在本函数复制编辑内容。
	editor: EditorComponent;
	// 普通状态提示函数，返回void；具体如何显示由宿主决定。
	showStatus: (message: string) => void;
	// 失败提示函数，不等同Promise reject或自动弹登录界面。
	showError: (message: string) => void;
}

/** Trailing `pi.share` entry carrying the system prompt and tool schemas for the session viewer. */
// 创建供会话查看器读取的单条pi.share尾项，返回object[]；例原分支末id为abc，尾项parentId就用abc。
// 读取当前系统正文/工具schema并生成8位随机id，不写磁盘、不改原树，也不执行工具；parameters保留原引用，后续导出才JSON序列化，不能因此声称已脱敏或可序列化。
export function createShareTrailingEntries(
	// 输入当前会话，读取其此刻的state。
	session: AgentSession,
	// 父节点id可为null，空分支时尾项直接接在会话头之后。
	parentId: string | null,
	// 时间戳由导出器提供，字符串不在此解析或改成本机当前时间。
	timestamp: string,
	// 返回普通对象数组，object类型本身不保证字段符合任意会话schema。
): object[] {
	// 虽然本次只有一条，仍用数组以符合尾项工厂接口。
	return [
		{
			// 标准custom条目标记，不伪造assistant对话。
			type: "custom",
			// customType为pi.share，供查看器辨认展示元数据。
			customType: "pi.share",
			// 取UUID开头8个十六进制字符，随机空间比完整UUID小；没有在此检查与现有条目id是否碰撞。
			id: crypto.randomUUID().slice(0, 8),
			// 属性简写使用导出器给的最后节点id。
			parentId,
			// 沿用此次导出的统一时间。
			timestamp,
			// 展示元数据放data子对象，不插入正文内容块。
			data: {
				// 读取当前state的系统提示词文本，包含什么由会话当前状态决定，不在此裁剪或脱敏。
				systemPrompt: session.state.systemPrompt,
				// map将当前工具逐个变成只带下面三字段的新对象；箭头后圆括号表示返回对象字面量。
				tools: session.state.tools.map((tool) => ({
					// 保留工具匹配名。
					name: tool.name,
					// 保留完整用途描述。
					description: tool.description,
					// 保留参数schema原引用，不携带工具execute，但也不递归清理schema内部敏感信息。
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for Radius. */
// 把当前分支与pi.share展示尾项写成JSONL，返回void；例给临时session.jsonl供Radius读取。
// 委托导出器解析路径/建目录，在序列化时调用尾项工厂，再同步覆盖写文件；原树不追加分享记录，IO或JSON序列化失败可向上抛，不在本层捕获。
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	// 传入当前sessionManager和目标路径，并给一个尾项回调；本函数不返回导出器实际解析后的文件路径。
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		// 导出器给出最后id与统一时间时才创建展示尾项，并捕获外层session引用。
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

/** Share the current session through Radius, falling back to a private gist. */
// 按auto/gist/radius设置分享会话，返回Promise<void>；成功通过showStatus链接展示，部分失败通过showError后返回，也有异常继续reject。
// 流程：独立临时目录→先导当前分支JSONL→可选Radius→必要时检查gh并导全历史HTML→Gist→finally删临时目录。例auto缺Radius凭证才尝试Gist；Radius已尝试但上传失败/取消不再fallback。
// 实际副作用包括认证解析可能刷新/保存凭证、网络上传、gh命令、UI替换及文件写删。本入口没有额外分享确认或脱敏，临时目录创建及部分认证/UI错误不在内部catch范围。
export async function shareSession(context: SessionShareContext): Promise<void> {
	// 创建独立pi-share临时目录，避免并发分享共用文件；位于try之前，创建失败直接拒绝，尚无后面的finally清理。
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
	// 本次JSONL固定文件名放在独立临时目录内。
	const jsonlFile = path.join(tempDir, "session.jsonl");
	// Gist用的HTML路径也位于同一临时目录，此刻尚未写入。
	const htmlFile = path.join(tempDir, "session.html");

	// 从导出流程开始建立外层finally保障，内部return也会尝试删除目录。
	try {
		// 第一层内try只捕获JSONL导出失败，不包住后面的设置/认证读取。
		try {
			// 即使明确选择gist，也先导出一份JSONL；Radius路径稍后直接读取它。
			exportSessionForShare(jsonlFile, context.session);
			// 捕获导出抛出的任意值，unknown需先收窄才能取message。
		} catch (error: unknown) {
			// 显示导出错误；非Error只给Unknown error，不直接String展开未知值。宿主showError自身若抛错仍可传播。
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			// 导出失败不再继续上传，但外层finally仍清临时目录。
			return;
		}
		// 读取目的地设置，SettingsManager只返回auto/gist/radius；不在此写设置。
		const destination = context.session.settingsManager.getSessionShareDestination();
		// 明确gist才完全跳过Radius provider及认证检查。
		if (destination !== "gist") {
			// true表示Radius路径已处理（成功、取消或上传失败皆可），立即结束，不代表分享一定成功；false仅表示无provider/token可再考虑gist。
			if (await tryShareViaRadius(jsonlFile, context)) return;
			// 若强制radius却拿不到可用provider/token，不能自动改分享渠道。
			if (destination === "radius") {
				// 提示先手动登录，代码不在此启动登录交互。
				context.showError("Radius authentication is not configured. Run '/login radius' first.");
				// 强制Radius且不可用时结束；仍会执行清理。
				return;
			}
		}

		// 进入Gist前单独检查gh认证状态，try捕获同步抛错，不会捕获所有CLI失败为异常。
		try {
			// 同步执行gh auth status，编码utf-8使输出为字符串；等待期间阻塞Node事件循环，且未设超时。
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			// 只有退出状态严格0才继续；启动失败常通过返回status:null/error报告，也会进此分支，不一定走catch。
			if (authResult.status !== 0) {
				// 所有非零/null状态统一显示未登录，包括某些启动失败；不在此细分authResult.error。
				context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				// 检查未通过就结束，不继续导HTML或创建gist。
				return;
			}
			// 只处理同步调用本身抛出的异常；不按异常类型确定确实未安装。
		} catch {
			// 此catch固定显示安装提示，实际异常也可能有其他原因。
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			// 提示后结束，外层finally仍执行。
			return;
		}

		// 单独捕获HTML导出失败。
		try {
			// 异步导出HTML到临时路径，使用当时theme.name；实际HTML导出器读取getEntries保存全部分支，leafId只指定默认分支，与上面仅当前分支JSONL不同。
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
			// HTML导出拒绝或同步抛错会在await处捕获。
		} catch (error: unknown) {
			// 以和JSONL相同的错误前缀提示，非Error仍用Unknown error。
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			// HTML失败不尝试创建gist。
			return;
		}
		// 把HTML文件交给真实gh创建gist流程并等待；本行不是上传刚才那份JSONL。
		await shareViaGist(htmlFile, context);
		// 流程正常结束、内部return或异常离开都尝试清临时文件，但不是保证清理必定成功。
	} finally {
		// 清理错误单独捕获，避免用rm失败覆盖原流程结果。
		try {
			// 递归删除本次独立目录，force忽略路径不存在；权限等错误仍可能抛出。
			fs.rmSync(tempDir, { recursive: true, force: true });
			// 吞掉清理异常，不报告目录是否仍残留。
		} catch {
			// Ignore cleanup errors
		}
	}
}

// 尝试Radius分享，false仅指未注册provider或解析不到token；其他已处理结果返回true，认证阶段异常也可能直接reject。
// 流程：查provider→解析认证→挂可取消Loader→POST JSONL→检查响应并恢复编辑器。例HTTP失败显示错误且返回true阻止Gist兜底；取消只是发信号，不能撤回服务端已经保存的分享。
async function tryShareViaRadius(tmpFile: string, context: SessionShareContext): Promise<boolean> {
	// 按id查已注册Radius provider；这里仅用其是否存在，不使用该对象的网关配置。
	const provider = context.session.modelRuntime.getProvider("radius");
	// 没注册就返回false，让auto模式考虑Gist，不尝试认证读取。
	if (!provider) return false;

	// 把认证解析结果交getAuthCredential提取字符串，优先apiKey再看Bearer头。
	const token = getAuthCredential(
		// 请求OAuth最少再有效5分钟，认证器可能刷新并写凭证；不是本函数保证令牌一定有效5分钟。此await在上传try之前，也未接loader取消信号。
		await context.session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }),
	);
	// 没有非空凭证返回false；存在字符串还不代表服务端认证必定成功。
	if (!token) return false;

	// 创建并启动可取消上传动画；这一行及下面UI切换在try外，异常不会由上传catch统一处理。
	const loader = new BorderedLoader(context.ui, theme, "Uploading to Radius...");
	// 清空编辑区域布局，原editor对象仍由context保存。
	context.editorContainer.clear();
	// 将上传Loader挂进编辑区域。
	context.editorContainer.addChild(loader);
	// 焦点交Loader，让其收到可配置取消键。
	context.ui.setFocus(loader);
	// 请求TUI重画，不是同步保证终端已经显示。
	context.ui.requestRender();
	// 注册取消通知：内部Loader先abort信号，再同步调用这里恢复UI/显示状态；不等待fetch退出。
	loader.onAbort = () => {
		// 停动画并重新挂原编辑器，UI回调异常仍可能抛出。
		restoreEditor(loader, context);
		// 显示取消提示，不宣称远端对象已删除。
		context.showStatus("Share cancelled");
	};

	// 只从文件读取和上传开始统一捕获，前面的provider/auth/Loader构造不在此保护范围。
	try {
		// 同步把临时JSONL完整读成Buffer，不是逐行流式上传。
		const body = fs.readFileSync(tmpFile);
		// 以固定默认网关组装/v1/artifacts；绝对路径会覆盖基址原路径，不采用provider自定义URL。
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		// 请求visibility为organization，实际权限由服务端决定，本代码不额外验证组织访问控制。
		url.searchParams.set("visibility", "organization");
		// 上传标题固定Pi session，而非从用户输入或会话名称取值。
		url.searchParams.set("title", "Pi session");
		// 发真正HTTP POST并await响应；本文件没有额外重试循环或请求超时器。
		const response = await fetch(url, {
			// 使用POST提交内容，不是只生成链接。
			method: "POST",
			// 上传认证和内容元数据放请求头。
			headers: {
				// 把解析到的凭证作为Bearer传给Radius。
				Authorization: `Bearer ${token}`,
				// 声明正文是一行一条JSON的NDJSON，不是HTML。
				"Content-Type": "application/x-ndjson",
				// Content-Length使用Buffer字节数，区别于JS字符串length。
				"Content-Length": String(body.byteLength),
			},
			// 属性简写发送刚读出的Buffer，上传整份导出内容。
			body,
			// 把可取消信号实际交fetch，取消是协作中止等待/传输，不保证服务端停止处理。
			signal: loader.signal,
		});
		// 若响应回来时已取消，视作本渠道已处理并返回true；通常UI已由onAbort恢复，不再显示成功。
		if (loader.signal.aborted) return true;
		// 解析JSON失败用null兜底；as只声明响应可能形状，不验证远端字段类型或canonical_url真实性。
		const json = (await response.json().catch(() => null)) as {
			// artifact字段可省，存在时TS声称含canonical_url字符串；运行时仍是未完整校验的服务端数据。
			artifact?: { canonical_url: string };
			// 服务端可给错误文字，?表示可缺省。
			error?: string;
			// |null同时包含上面解析失败的兜底值，不是把任何坏字段自动变null。
		} | null;
		// 解析响应期间也可能取消，再次检查并避免显示完成链接。
		if (loader.signal.aborted) return true;
		// 收到响应后先恢复编辑区域，然后才判断HTTP/响应artifact；没有finally统一恢复所有路径。
		restoreEditor(loader, context);
		// HTTP非2xx或artifact缺失均显示失败；这里只检查artifact truthy，不是验证其完整schema。
		if (!response.ok || !json?.artifact) {
			// 调用宿主错误提示，说明上传失败。
			context.showError(
				// 错误内容按服务端error、HTTP状态文字、数字状态依次用truthy值回退，不包括完整响应体。
				`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			);
			// 失败仍true，auto模式不会接着再上传gist。
			return true;
		}
		// 取服务端给的canonical_url，不在此编码/限制协议/验证它是可信链接。
		const shareUrl = json.artifact.canonical_url;
		// 只显示OSC8链接状态，不复制剪贴板或自动打开浏览器；hyperlink不会清理嵌入控制字符。
		context.showStatus(`Share URL: ${hyperlink(shareUrl, shareUrl)}`);
		// 成功路径也用true表示渠道处理完。
		return true;
		// 捕获此try内的文件/请求/解析/UI异常，并非所有认证错误都能来到这里。
	} catch (error: unknown) {
		// 已取消则不重复恢复/报错，避免覆盖onAbort显示；取消未必表示请求从未上传。
		if (!loader.signal.aborted) {
			// 非取消异常时尝试恢复原编辑器；如果恢复本身再抛错，仍会离开本函数。
			restoreEditor(loader, context);
			// 将普通上传异常显示给宿主。
			context.showError(
				// 只有Error读取message，其余未知抛出值统一Unknown error。
				`Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		// 异常已提示或取消后返回true，阻止自动Gist兜底；不等同上传成功。
		return true;
	}
}

// 用gh将给定临时HTML创建gist，返回Promise<void>，链接经showStatus展示；例gh退出0并输出末段id时构造查看器URL。
// 流程：替换编辑区为Loader→spawn并收集stdout/stderr→等close→检查状态/取id→恢复UI并提示。真实命令/上传及UI动画均为副作用；取消只kill直接子进程不等退出，未单独监听child的error事件，外层try不能兜底所有异步启动错误。
async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	// 创建会立即启动动画的等待组件，构造及初始UI切换仍在try之前。
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	// 清空编辑区域容器布局。
	context.editorContainer.clear();
	// 添加创建gist的等待组件。
	context.editorContainer.addChild(loader);
	// 焦点给Loader以接收取消键。
	context.ui.setFocus(loader);
	// 请求重画显示等待状态。
	context.ui.requestRender();

	// ReturnType<typeof spawn>复用子进程返回类型，初始null代表尚未启动；let允许Promise执行器稍后赋值。
	let proc: ReturnType<typeof spawn> | null = null;
	// Loader取消回调同步尝试终止进程、恢复UI并提示，不会await进程close。
	loader.onAbort = () => {
		// 有proc才发默认终止信号，忽略kill布尔结果；不保证子进程已退出或远端gist没创建，也不杀进程树。
		proc?.kill();
		// 先恢复原编辑器，后面的子进程Promise仍可能在等close。
		restoreEditor(loader, context);
		// 显示取消状态，不自动删除可能已生成的gist。
		context.showStatus("Share cancelled");
	};

	// try包住启动与等待流程；Promise执行器同步抛错会变reject，稍后EventEmitter未处理error不自动变为这份Promise拒绝。
	try {
		// 等待返回stdout/stderr与可为null的退出码；这里的resolve不带reject处理器，也没加独立超时。
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			// 启动真实gh gist create并传--public=false与文件路径，默认stdio为管道；本代码不额外验证服务端可见性/访问权限。
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			// 累计标准输出的字符串，稍后按URL文本解析。
			let stdout = "";
			// 累计错误输出，非零退出时优先展示它。
			let stderr = "";
			// 有stdout管道才监听data，回调在未来数据到达时执行。
			proc.stdout?.on("data", (data) => {
				// 逐块toString后追加，没设输出大小上限；不是专门的跨字节UTF8流解码器。
				stdout += data.toString();
			});
			// 对标准错误管道同样监听数据块。
			proc.stderr?.on("data", (data) => {
				// 错误输出追加到累计字符串，不立即showError。
				stderr += data.toString();
			});
			// 只在close解析Promise；code可null（如信号退出）。这里只取code未保留signal，也未给error事件注册监听。
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		// 已取消就直接返回，onAbort负责当时的UI恢复；即使gh随后退出0也不再显示链接。
		if (loader.signal.aborted) return;
		// 正常等待close后先恢复编辑区，然后再解释结果。
		restoreEditor(loader, context);

		// 只有严格退出码0算成功；非零和null均失败。
		if (result.code !== 0) {
			// 优先用去首尾空白后的stderr提示，空串回退Unknown error。
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			// 失败不解析gist链接。
			return;
		}

		// 去掉标准输出两端空白，假定其是可用gist URL；不校验确为单行或HTTP地址。
		const gistUrl = result.stdout?.trim();
		// 按斜杠拆并取最后一段为id，没有验证主机/路径格式，尾斜杠会得到空串。
		const gistId = gistUrl?.split("/").pop();
		// 空/缺id就走解析失败提示。
		if (!gistId) {
			// 显示无法从gh输出提取id的错误。
			context.showError("Failed to parse gist ID from gh output");
			// 无id就结束，不构造查看器地址。
			return;
		}

		// 将id附在查看器基址fragment后，基址可被环境变量覆盖；这里只拼URL。
		const previewUrl = getShareViewerUrl(gistId);
		// 同时展示查看器与原gist链接，以换行分隔；不进行剪贴板、浏览器或额外网络操作。
		context.showStatus(`Share URL: ${hyperlink(previewUrl, previewUrl)}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
		// 捕获等待Promise拒绝或本try内同步异常，不能当成对子进程所有异步error的完整兜底。
	} catch (error: unknown) {
		// 取消时不再覆盖取消提示。
		if (!loader.signal.aborted) {
			// 非取消异常尝试恢复编辑区，恢复回调再抛错仍可能使本Promise拒绝。
			restoreEditor(loader, context);
			// 把Error.message或Unknown error交宿主显示，不重试创建gist。
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

// 停Loader动画并把原editor重新挂回编辑区，返回void；例上传完成或取消时恢复输入焦点。
// 修改布局/焦点，不修改编辑正文、不abort网络/进程，也没有直接requestRender；重绘是否发生由宿主组件和后续流程决定，各步骤异常可传播。
function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	// dispose只停内部Loader动画，保持其信号已取消/未取消状态。
	loader.dispose();
	// 移除等待组件布局，不销毁context保存的编辑器对象。
	context.editorContainer.clear();
	// 重新加入原编辑器引用，不创建空白新编辑器。
	context.editorContainer.addChild(context.editor);
	// 焦点回到原编辑器，后续输入再由它处理。
	context.ui.setFocus(context.editor);
}
