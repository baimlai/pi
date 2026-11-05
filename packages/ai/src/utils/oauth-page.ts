// OAuth本地回调/登录流程返回给浏览器的成功或失败页面；先转义动态文字，再插入固定HTML模板。
// 固定内嵌标志图形，页面无需再请求图片资源；字符串内容属于页面资源，不在内部插入源码注释。
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" aria-hidden="true"><path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z"/><path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z"/><path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z"/></svg>`;

// 用途：动态文字转HTML安全文本。例 <b>变&lt;b&gt;，不会变成标签；顺序先转&再转其他字符，避免二次转义生成的实体。
function escapeHtml(value: string): string {
	// 依次生成替换后的新字符串，不修改调用方原字符串。
	return (
		value
			// 先转义原输入中的&，否则后面新增的&lt;等可能再被转一次。
			.replaceAll("&", "&amp;")
			// 阻止动态文字开启HTML标签。
			.replaceAll("<", "&lt;")
			// 转义标签结束符。
			.replaceAll(">", "&gt;")
			// 双引号转换成实体，使文字不会意外闭合属性。
			.replaceAll('"', "&quot;")
			// 单引号也转义，完整覆盖本模板使用的常见HTML特殊字符。
			.replaceAll("'", "&#39;")
	);
}

// 用途：生成完整HTML文档。输入标题/主标题/说明和可选详情，输出字符串，无HTTP副作用。例失败详情含<html>也只显示文字；下方长模板含CSS布局和HTML，不是TS语句。
function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	// 浏览器标签页标题先做HTML转义。
	const title = escapeHtml(options.title);
	// 页面大标题同样先转义。
	const heading = escapeHtml(options.heading);
	// 调用方/错误源提供的说明文字不能直接拼进HTML。
	const message = escapeHtml(options.message);
	// 可选详情有真值才处理，空字符串不会渲染详情区域。
	const details = options.details ? escapeHtml(options.details) : undefined;

	// 返回整个页面模板：head声明编码/视口，CSS控制居中深色样式，body插入已经转义的变量。模板原文必须保持不变。
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    main {
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <div class="logo">${LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

// 用途：生成登录成功页。例OAuth回调成功后把“可以关闭此页”传入；返回HTML供HTTP响应层发送，本函数不发送响应。
export function oauthSuccessHtml(message: string): string {
	// 复用同一页面结构，选择对应成功/失败标题。
	return renderPage({
		// 浏览器标签页显示固定成功标题。
		title: "Authentication successful",
		// 正文主标题使用相同成功文字。
		heading: "Authentication successful",
		// 对象简写，将调用者说明交给模板内部转义。
		message,
	});
}

// 用途：生成登录失败页，可附调试详情。例 message="登录失败"、details=服务器原因；详情也会转义，不执行其中HTML。
export function oauthErrorHtml(message: string, details?: string): string {
	// 复用同一页面结构，选择对应成功/失败标题。
	return renderPage({
		// 浏览器标签页显示固定失败标题。
		title: "Authentication failed",
		// 正文主标题说明失败。
		heading: "Authentication failed",
		// 对象简写，将调用者说明交给模板内部转义。
		message,
		// 可选详情原样传给统一模板，由模板决定是否显示并转义。
		details,
	});
}
