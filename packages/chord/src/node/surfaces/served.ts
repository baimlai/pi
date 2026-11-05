// The files the surfaces serve (slice 11 §1, §4): base bundles, plugin scripts, stylesheets and assets, each named by
// its content and so cached by clients forever; their types.
// 所属：node/surfaces 的 HTTP 资源适配层；把内存文件转成 Chord 的 HttpResponse 描述。
// 职责：404 处理、bytes 响应、缓存头、脚本/样式 MIME 常量与按扩展名查表。
// 边界：不读磁盘、不写网络、不校验内容摘要；immutable 缓存依赖调用方保证 URL 含内容哈希。
// 上游：web/tui 路由的 serve 回调；下游：Http 组件的 bytes 响应（范围读取由该层调用 read）。
// 导出清单：ServedFile 类型；served 响应工厂；JAVASCRIPT/CSS MIME 常量；mimeOf 扩展名查询。
// 组合：路由 → file(path) 查找 → served(file) → HTTP 层读取字节；插件发布器复用同一 ServedFile。
// 示例：const response = served(files.get("/_chord/web/base.abc.js"));
// 阅读顺序：ServedFile → served → MIME 常量 → mimeOf → ASSET_TYPES。

import { extname } from "node:path";
import type { HttpResponse } from "../http/index.ts";

/** A file the server serves: its type and bytes. */
// ServedFile 是值对象：mime 用于响应头，bytes 是共享的 Uint8Array；没有文件名/修改时间/磁盘路径。
export type ServedFile = { readonly mime: string; readonly bytes: Uint8Array };

/** A served file's response, cached by the browser forever (its path names its content); 404 for none. */
// 把内存文件转换成 HTTP 响应描述；undefined 返回404，有文件则提供按偏移读取的 bytes 响应。
// 例如三个字节的文件 read(1,2) 返回后两个字节的视图；本函数不打开文件、不直接写网络。
// 缓存头假定 URL 已包含内容摘要；这不是对任意路径内容不变的运行时校验。
export function served(found: ServedFile | undefined): HttpResponse {
	// 联合类型的 undefined 分支在返回后被排除，后面可安全解构文件字段。
	if (found === undefined) return { kind: "error", status: 404 };
	// 对象解构只取引用，不复制字节。
	const { mime, bytes } = found;
	// kind 是 HttpResponse 判别字段，HTTP 层负责状态、范围请求及分块读取。
	return {
		kind: "bytes",
		mime,
		size: bytes.length,
		// async 让返回值成为 Promise；subarray 是共享底层内存的视图，结束偏移不包含在结果中。
		read: async (offset, length) => bytes.subarray(offset, offset + length),
		// Overrides the baseline's `no-store` for these files only.
		headers: { "Cache-Control": "private, max-age=31536000, immutable" },
	};
}

/** The type of a script. */
// 脚本 MIME 包含 charset；基础包、插件脚本和合并文件都用它，浏览器按 UTF-8 解码。
export const JAVASCRIPT = "text/javascript; charset=utf-8";

/** The type of a stylesheet. */
// 样式 MIME；页面插入 <link> 时由浏览器按此类型解析。
export const CSS = "text/css; charset=utf-8";

/** The type of a built asset, by extension. */
// 仅按 path 的最后扩展名查 MIME；返回字符串、无 I/O，例如 photo.JPG 得 image/jpeg。
// 未知扩展名回退二进制类型，不读取文件内容判断格式；?? 只在查表结果为空值时采用回退。
export function mimeOf(path: string): string {
	// extname 取 .JPG，slice(1) 去点，转小写后查只读类型表；Readonly 是静态约束。
	return ASSET_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** The types of the assets builds collect, by extension. */
// 只覆盖构建常见资产；键是不带点的扩展名。未列出的类型回退 application/octet-stream。
const ASSET_TYPES: Readonly<Record<string, string>> = {
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	wasm: "application/wasm",
	json: "application/json",
	css: CSS,
	js: JAVASCRIPT,
};
