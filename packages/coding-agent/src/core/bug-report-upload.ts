// 把已构建的故障报告上传到Radius网关；交互确认和离线模式限制在上游/bug流程处理。
// bundle是纯类型，只说明有哪些报告材料。
import type { BugReportBundle } from "./bug-report.ts";
// ZIP与上传共享同一文件清单，避免两个出口包含内容不同。
import { bugReportFiles } from "./bug-report.ts";
// 从配置入口读取当前网关，允许环境覆盖。
import { getRadiusGatewayUrl } from "./radius.ts";

// 非导出选项类型；所有字段都可选，省略token即匿名上传。
interface UploadBugReportOptions {
	// 认证信息会作为Bearer头发送，函数不在此登录/刷新token。
	token?: string;
	// 调用者取消信号传给fetch；不是本函数创建的超时器。
	signal?: AbortSignal;
	// 可覆写网关地址；这里不执行URL来源策略校验。
	gatewayUrl?: string;
}

/** Upload a report as multipart form data, anonymously or attributed to a Radius account. */
/**
 * 将bundle的文件逐项组成multipart POST，返回服务端报告id；网络/编码/取消或失败响应会拒绝Promise。
 * 例：传token就携带Authorization，没传也可提交。这里不再次脱敏或请求用户确认，调用方须先准备获准发送的材料。
 * 路径/v1/bug-reports会替换网关原路径；成功同时要求HTTP ok、JSON ok=true及字符串id。
 */
export async function uploadBugReport(
	// 已经收集的元信息/诊断及可选原文或摘要。
	bundle: BugReportBundle,
	// ={}仅在省略/undefined时提供新对象，不改变调用方原配置。
	options: UploadBugReportOptions = {},
): Promise<{ id: string }> {
	// 使用平台FormData，让fetch生成multipart边界，不手写Content-Type。
	const body = new FormData();
	// 清单顺序与ZIP一致；此步骤并不读取会话文件路径。
	for (const file of bugReportFiles(bundle)) {
		// 以文件名作为表单键和上传文件名；Blob负责UTF-8文本编码与媒体类型。
		body.append(file.name, new Blob([file.data], { type: file.contentType }), file.name);
	}
	// await等待HTTP响应头；读取/解析响应体在后面，fetch失败不在这里吞掉。
	const response = await fetch(new URL("/v1/bug-reports", options.gatewayUrl ?? getRadiusGatewayUrl()), {
		// POST有外部写入副作用，不是一次只读查询。
		method: "POST",
		// 空串token也按匿名处理；不自动加其他应用凭据。
		headers: options.token ? { Authorization: `Bearer ${options.token}` } : undefined,
		// 属性简写传递刚构建的表单。
		body,
		// 若signal已取消，fetch通常直接拒绝；signal本身不序列化进报告。
		signal: options.signal,
	});
	// 外部响应边界：JSON解析失败回退null；as只提供局部字段视图，不是完整schema校验。
	const json = (await response.json().catch(() => null)) as {
		// 可选成功标志，下面精确要求true。
		ok?: boolean;
		// 嵌套id也可能缺失，后续用可选链访问。
		bug_report?: { id?: string };
		// 失败码/描述仅作为错误文字来源。
		error?: string;
		description?: string;
	} | null;
	// 在不可信响应处实际检查id类型；非空性没有检查，所以空字符串id也满足条件。
	if (response.ok && json?.ok === true && typeof json.bug_report?.id === "string") {
		// 返回新小对象，不把服务端其他字段公开给调用者。
		return { id: json.bug_report.id };
	}
	// 只有JSON的ok是假值时才取描述/错误；HTTP失败但JSON ok=true不会选这份detail。
	const detail = json && !json.ok ? json.description || json.error : undefined;
	// 优先服务端说明，然后HTTP文字，再状态码；没有保证错误文本已脱敏。
	throw new Error(`Bug report upload failed: ${detail || response.statusText || response.status}`);
}
