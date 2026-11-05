// 按10种入口打包为浏览器ESM并统计压缩代码/gzip字节，不是整个npm包安装体积；导入即启动esbuild打包工作，打印表格并可选导出JSON。
// Bundle size of what a validator needs from each library, as a browser app ships it: esbuild bundles and minifies the
// import for the browser platform (one file, no code splitting), then gzip -9.
// Run: node test/bench/size.ts [--json <file>]

// 同步写仅用于最后可选--json结果，不用于每份bundle写盘。
import { writeFileSync } from "node:fs";
// gzipSync在本机同步压缩内存中的输出字节，不计算运行时校验速度。
import { gzipSync } from "node:zlib";
// 真实esbuild build可能启动其本机打包服务并读取模块依赖；它分析/打包输入源码，不是在这里运行这些验证器检查样本。
import { build } from "esbuild";

// 基于模块URL取src路径文字，但用的是URL.pathname而非fileURLToPath；含URL转义或Windows路径时不自动还原成本机规范文件名。
const src = new URL("../../src/", import.meta.url).pathname;

// 入口名→虚拟TS源码字典，里面字符串是交给esbuild的完整源文，不在本模块eval执行。
const entries: Record<string, string> = {
	// 只重新导出Pi compile，JSON.stringify给路径加合法JS字符串引号/转义，不负责把URL路径解码。
	"pi-schema": `export { compile } from ${JSON.stringify(`${src}index.ts`)};`,
	// Pi另加formats导出，测量这两个API共同被打包的大小。
	"pi-schema + formats": `export { compile } from ${JSON.stringify(`${src}index.ts`)}; export { formats } from ${JSON.stringify(`${src}formats/index.ts`)};`,
	// TypeBox仅导出Compile入口，不把所有TypeBox API强制都保留。
	typebox: `export { Compile } from "typebox/compile";`,
	// CfWorker选择Validator导出，不代表实际启动Worker。
	cfworker: `export { Validator } from "@cfworker/json-schema";`,
	// Ajv选择2020-12实现的default导出。
	ajv: `export { default } from "ajv/dist/2020.js";`,
	// 此入口同时保Ajv和格式插件导出，区别单独Ajv，不在这里调用插件注册。
	"ajv + ajv-formats": `export { default } from "ajv/dist/2020.js"; export { default as addFormats } from "ajv-formats";`,
	// ATA只导出Validator；browser平台包映射影响实际包含模块，不在本脚本加载native addon作校验。
	"ata-validator": `export { Validator } from "ata-validator";`,
	// Zod's documented `import * as z` (a named `{ z }` import keeps every locale, about 90 KB gzipped). Its core with
	// native schemas, and with z.fromJSONSchema for JSON Schema.
	// Zod写一个原生object的safeParse布尔函数以保相关代码，v:unknown在这里是待打包字符串里的TS语法，非本脚本的参数声明。
	zod: `import * as z from "zod"; export const check = (v: unknown) => z.object({ a: z.string() }).safeParse(v).success;`,
	// 另测Zod的JSON Schema导入API，和原生schema路径分开统计。
	"zod + fromJSONSchema": `import * as z from "zod"; export const fromJSONSchema = z.fromJSONSchema;`,
	// omptype选择fromJsonSchema导出，不在测量入口预建某个大schema。
	omptype: `export { fromJsonSchema } from "@oh-my-pi/omptype";`,
};

/** Minified and gzipped bytes by entry. */
// 结果按入口名记录minified/gzip的原始字节数；只是TS类型约束，不自动压缩或校验输出文件数量。
export type SizeResults = Record<string, { minified: number; gzip: number }>;

// 逐入口保存结果的可变字典，const仍允许写属性。
const results: SizeResults = {};
// Object.entries保持对象已有键顺序，逐份await打包，非并发创建10项任务。
for (const [name, contents] of Object.entries(entries)) {
	// 顶层await等本次build成功；失败会中断模块执行，没有catch把失败伪装成0字节。
	const output = await build({
		// stdin不是读取系统标准输入，而是esbuild虚拟入口：contents给源码，resolveDir给依赖解析基准，loader=ts识别其中类型语法。
		stdin: { contents, resolveDir: src, loader: "ts" },
		// bundle=true把可解析依赖合入产物，不只测这段入口文字自身大小。
		bundle: true,
		// minify=true启用代码压缩，统计的是压缩后的输出，而非原始源码行数。
		minify: true,
		// ESM输出格式，保导出供应用引用，不构造成Node CommonJS入口。
		format: "esm",
		// browser影响内置模块/包条件/解析，结果不直接代表Node平台bundle。
		platform: "browser",
		// write=false把产物放outputFiles内存，不写bundle文件；不代表esbuild完全不读取磁盘或不启动服务。
		write: false,
		// silent抑制自动日志，不使build错误消失；返回warnings等字段未在本脚本另外展示。
		logLevel: "silent",
	});
	// 只取第一个输出文件的Uint8Array内容，没有求所有文件总和；write:false让TS可取得outputFiles，本脚本仍依赖确有首项。
	const code = output.outputFiles[0].contents;
	// Uint8Array.length是字节数；gzip level9同步压同份字节并取压缩字节数，不用JS字符串length，也不把两个数相加当包大小。
	results[name] = { minified: code.length, gzip: gzipSync(code, { level: 9 }).length };
}

// 打印表头，统计已在前面的循环完成。
console.log("| library | minified | gzip |");
// Markdown对齐线不是压缩内容的一部分。
console.log("|---|---:|---:|");
// 逐入口读已算结果，输出不重新打包。
for (const [name, r] of Object.entries(results)) {
	// 除1024、保1位打印KB标签，实际是KiB换算；舍入文字不改变JSON里的原始字节统计。
	console.log(`| ${name} | ${(r.minified / 1024).toFixed(1)} KB | ${(r.gzip / 1024).toFixed(1)} KB |`);
}
// 只找第一个--json开关，未做缺路径等完整CLI校验。
const out = process.argv.indexOf("--json");
// 有标记才同步写下一项路径，tab缩进JSON；写失败直接抛，无标记则只有console表格。
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
