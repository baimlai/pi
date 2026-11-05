// 读取剪贴板图片的跨平台适配：Linux命令/WSL PowerShell/原生后端分流，必要时转PNG；界面粘贴时调用，不在模块导入时读取。
import { getNativeClipboard } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runClipboardCommand } from "./clipboard-command.ts";
import { detectSupportedImageMimeType } from "./mime.ts";
import { loadPhoton } from "./photon.ts";
import { isWSL } from "./wsl.ts";

// 成功读到的原字节及类型，尚不包含给模型用的base64或尺寸限制结果。
export type ClipboardImage = {
	// 可能是Buffer（Uint8Array子类）或普通视图，不保证总是独立复制。
	bytes: Uint8Array;
	// 来自后端声明/魔数探测，转换后更新PNG。
	mimeType: string;
};

// 优先顺序同时用于可直接接受的MIME名单；as const只保留只读字面量类型，不freeze运行时数组。
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

// 列举类型/路径转换尽量短等，获取完整图片命令未覆写时用共享3秒默认。
const DEFAULT_LIST_TIMEOUT_MS = 1000;
// WSL PowerShell加载程序集/取图允许5秒。
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;

// 输入可选环境（默认当前环境），返回Wayland特征是否存在，无I/O；例如WAYLAND_DISPLAY非空或XDG_SESSION_TYPE恰好wayland。
// 不探测服务是否可连接，值"0"仍是非空display；也不要求当前process.platform是linux。
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

// 输入MIME文字，取分号前主类型、trim并转小写，无I/O；例如image/png;charset=x变image/png。
function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

// 输入MIME返回不带点的后缀或null，不探测字节；例如image/jpeg→jpg，image/jpg未列为别名而返回null。
// 界面把成功剪贴板图片另写临时文件时用它选后缀，本函数本身不创建文件。
export function extensionForImageMimeType(mimeType: string): string | null {
	// switch按主类型精确匹配四种格式。
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

// 输入后端公布的类型列表，返回应请求的原MIME文字或null，无I/O；按PNG/JPEG/WebP/GIF顺序找，均无则取首个其他image/类型。
// 例如image/png;参数保留原文字用于wl-paste请求，比较时只看其小写主类型；不是始终按后端给出的第一项选。
function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	// 先整理空白/空项，再同时保留原请求写法raw和比较用base。
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	// 外层为本程序优先级，内层find为同类在后端列表里的首次出现。
	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	// 没有已支持类型也允许读取其他图像类型，后面尝试Photon转PNG。
	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	// 可选链没找到时返回null，不误当后端执行失败的undefined。
	return anyImage?.raw ?? null;
}

// 输入MIME返回其主类型是否在四格式名单，无I/O；这是声明匹配，不是图片内容解码。
function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * Convert unsupported image formats to PNG using Photon.
 * Returns null if conversion is unavailable or fails.
 */
// 输入未知图片格式字节，懒加载Photon后返回PNG字节/null；例如Windows DIB包装BMP可在这里转换，不做自动缩尺寸。
// 与image-convert核心不同，这个本地帮助函数没有主动applyExifOrientation；常见解码失败转null，加载补丁异常仍可拒绝。
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	// 首次可能读WASM，已有加载结果复用模块Promise。
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		// Photon按字节解码，不依赖后端给的MIME名称。
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			// 该API返回PNG文件字节，非RGBA数组。
			return image.get_bytes();
		} finally {
			// 已成功取得的句柄无论编码成功与否都释放。
			image.free();
		}
	} catch {
		return null;
	}
}

// Undefined means the backend failed; null means it has no image. An empty
// Wayland clipboard must not fall through to stale X11 clipboard contents.
// 无输入，实际调用wl-paste列类型再取图片，返回图片/null无图/undefined后端失败三态；不直接转码。
// 例如列表成功但只有text/plain返回null，上层不再试X11旧内容；WSL仍有额外Windows取图回退，不能泛化为停止所有后端。
async function readClipboardImageViaWlPaste(): Promise<ClipboardImage | null | undefined> {
	// 列类型用1秒上限，命令不可用/非零等由共享执行器转undefined。
	const list = await runClipboardCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (list === undefined) return undefined;

	// 成功Buffer按UTF8解析，每行一个可请求的MIME。
	const types = list
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	// 按受支持格式优先，其余image/也可读后转码。
	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		return null;
	}

	// 用原始公布MIME作为单独argv，不经shell拼接；无换行补充适合二进制数据。
	const data = await runClipboardCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	// 失败与成功空图保持不同状态。
	if (data === undefined) return undefined;
	if (data.length === 0) return null;

	// 返回字节和主MIME，不在这里验魔数是否与声明相符。
	return { bytes: data, mimeType: baseMimeType(selectedType) };
}

/**
 * On WSL, the Linux clipboard (Wayland/X11) does not receive image data from
 * Windows screenshots (Win+Shift+S). PowerShell can access the Windows clipboard
 * directly, so we use it as a fallback.
 */
// WSL专用Windows取图回退，无输入，返回PNG或null；用wslpath转换临时路径，再PowerShell取图保存，最后本地读回并尽力删除。
// 例如Linux后端没有Windows截图时，可跨interop读取Windows剪贴板；命令/读文件失败均null，不把失败细分成undefined。
async function readClipboardImageViaPowerShell(): Promise<ClipboardImage | null> {
	// 随机名降低冲突，不在这里预先排他创建；真正文件由PowerShell保存。
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		// 转换WSL路径为Windows能读取的位置，启动目录由共享命令执行器设为根。
		const winPathResult = await runClipboardCommand("wslpath", ["-w", tmpFile], {
			timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
		});
		if (winPathResult === undefined) {
			return null;
		}

		// 命令成功仍可能输出空白，下一步需拒绝空路径。
		const winPath = winPathResult.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		// PowerShell单引号字面量中以两个单引号表示一个，防止路径里的撇号提前结束该字面量。
		const psQuotedWinPath = winPath.replaceAll("'", "''");
		// 这些字符串是实际PowerShell脚本，不在其内容中插入解释注释。
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		// 显式让PowerShell解释脚本，NoProfile避免加载用户profile，不等于沙箱。
		const result = await runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (result === undefined) {
			return null;
		}

		// 脚本只有ok说明确实保存了图片；empty或其他输出都不读文件。
		const output = result.toString("utf-8").trim();
		if (output !== "ok") {
			return null;
		}

		// 同步读本机临时PNG，async函数内的同步文件读取仍会阻塞当前线程。
		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		// 复制为普通Uint8Array，脚本已指定PNG格式。
		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		// 回退取图失败不抛给上层，允许保留Linux原先的空/不可用状态。
		return null;
	} finally {
		try {
			// 不论是否成功都尝试删除随机临时路径，失败忽略。
			unlinkSync(tmpFile);
		} catch {
			// Ignore cleanup errors.
		}
	}
}

// 无输入，实际向X11 xclip列TARGETS，再读优先图片，返回图片/null/undefined三态；失败不会盲试未公布类型。
// 例如只公布image/bmp就读取该类型，后面统一转PNG；TARGETS成功但无图返回null，不能假装命令失败继续读旧后端。
async function readClipboardImageViaXclip(): Promise<ClipboardImage | null | undefined> {
	// 先从clipboard selection取类型列表，使用1秒列举超时。
	const targets = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	if (targets === undefined) return undefined;

	// 成功TARGETS文字按行trim，去掉空行，不把整个输出当一个MIME。
	const candidateTypes = targets
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);
	// 首选顺序与Wayland一致，找不到图像就明确无图。
	const preferred = selectPreferredImageMimeType(candidateTypes);
	if (!preferred) return null;

	// 单独读取已公布的目标类型；取图默认用共享执行器3秒超时/50MiB原字节预算。
	const data = await runClipboardCommand("xclip", ["-selection", "clipboard", "-t", preferred, "-o"]);
	if (data === undefined) return undefined;
	if (data.length === 0) return null;
	// MIME依据后端类型列表，不再验证每个文件格式。
	return { bytes: data, mimeType: baseMimeType(preferred) };
}

// 无输入，调用原生剪贴板图片API，返回图片/null无图/undefined不可用；原生传输拒绝会直接向上传播。
// 例如原生返回BMP字节，魔数探测可认image/bmp；认不出先标octet-stream，交后端尝试转换而非直接丢字节。
async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null | undefined> {
	// 可选链缺原生模块时得到undefined；实际原生后端仍按真实process环境选，不接上层options.env。
	const bytes = await getNativeClipboard()?.getImage();
	// undefined表示不可用，不与明确null/零长度“没有图片”合并。
	if (bytes === undefined) return undefined;
	if (!bytes?.length) return null;
	// 探测只检查头部，不保证完整解码有效；未识别时用通用二进制MIME。
	return { bytes, mimeType: detectSupportedImageMimeType(bytes) ?? "application/octet-stream" };
}

// 输入可选环境/平台覆盖，异步读取图片并必要时转PNG，返回图片/null；原生传输异常仍拒绝，不改剪贴板内容。
// Linux按Wayland/WSL→Xclip→WSL PowerShell→原生（仅undefined时）尝试；明确无图通常阻止读其他Linux后端，WSL Windows回退例外。
// 例如wl-paste无图且非WSL直接null，不去读X11旧图；Termux直接null。env/platform只选本函数策略，未作为命令环境或原生平台覆盖传入。
export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	// 覆盖便于宿主/测试指定策略，不会修改process.env。
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	// Termux图片后端不支持，跳过所有系统调用。
	if (env.TERMUX_VERSION) {
		return null;
	}

	// 三态变量把“无图”与“后端失败/尚未尝试”区别开。
	let image: ClipboardImage | null | undefined;

	// 仅Linux使用命令链，其他平台直接原生。
	if (platform === "linux") {
		// isWSL还可能读/proc/version，不是只由传入环境字典决定。
		const wsl = isWSL(env);
		// Wayland特征或WSL任一满足就先尝试wl-paste。
		if (isWaylandSession(env) || wsl) {
			image = await readClipboardImageViaWlPaste();
		}
		// 只在尚无可用后端结果时试X11，明确null不走这条。
		if (image === undefined) image = await readClipboardImageViaXclip();
		// Preserve Linux's empty/unavailable distinction if Windows has no image.
		// WSL对null/undefined都允许Windows回退；Windows也没图时??保留Linux原先三态。
		if (!image && wsl) image = (await readClipboardImageViaPowerShell()) ?? image;
		// 只有原状态仍undefined才试原生；原生错误不被外层catch掩盖。
		if (image === undefined) image = await readClipboardImageViaNativeClipboard();
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	// 最终无图/不可用统一对外null，不返回内部undefined。
	if (!image) {
		return null;
	}

	// Convert unsupported formats (e.g., Windows DIB data wrapped as BMP) to PNG
	// 这是MIME名单判断；已支持但字节损坏的图不会因此强制重解码。
	if (!isSupportedImageMimeType(image.mimeType)) {
		// 未支持格式可由Photon转换，成功时更新实际MIME。
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	// 已支持格式原对象返回，后续模型图片处理再决定缩放/体积限制。
	return image;
}
