// 本文件是 coding-agent 内置 read/write/edit/bash/grep/find/ls 工具的核心回归测试。
// 所属模块：packages/coding-agent/src/core/tools/*；被测契约是 execute 返回的 content、details、
// structuredContent、isError，以及工具对磁盘或子进程产生的可观察副作用。
// 上游入口：createXxxTool（经 ../src/index.ts 适配为 AgentTool）或 createXxxToolDefinition（直接工具定义，
// 测试在第五个参数传 ctx）；下游依赖：Node fs/promises、rg、fd、本机 bash 及其 shell 配置。
//
// 测试夹具与假实现：
// - 模块级 readTool/.../lsTool 以 process.cwd() 创建，供第一个大 describe 的普通文件用例复用。
// - 每个 describe 在 beforeEach 中创建 tmpdir 下唯一目录，afterEach 删除，避免用例共享磁盘状态。
// - fakeCtx(cwd) 只伪造 ExtensionToolContext 的 cwd 字段，用来验证“执行上下文目录覆盖工厂目录”。
// - createTinyBmp1x1Red24bpp 手工拼 58 字节 BMP，验证按内容识别图片以及 BMP 转 PNG。
// - createLocalBashOperations 使用真实本地 shell；createBashTool({operations}) 注入假后端。
// - vi.spyOn(shellModule, ...) 在模块边界替换 shell 解析，不改动被测工具代码。
// - applyPatch 来自 diff 库，用来证明工具生成的 unified patch 能重新应用到原文。
//
// 覆盖的主要行为分组：
// 1. read：行/字节上限、offset/limit、图片 magic 探测、BMP 转换、structuredContent。
// 2. write/edit：父目录创建、精确替换、唯一性/空 edits/重叠/原子性、BOM 与换行保留。
// 3. bash：非零退出码、1 MiB 结构化输出、信号退出码、超时/取消、stdin 传输、
//    WSL 识别、commandPrefix、输出节流、跨 chunk UTF-8、完整日志持久化。
// 4. grep/find/ls：单文件与上下文、limit、rg 配置隔离、flag-like 参数安全、.gitignore、点文件。
// 5. tool cwd resolution：七类工具优先使用 ctx.cwd，而不是创建工具时的 cwd。
// 6. edit fuzzy matching：尾随空白、全角标点、Unicode 兼容形式、智能引号、破折号、NBSP。
// 7. edit CRLF handling：LF oldText 匹配 CRLF 文件，写回保留 CRLF/LF 与 UTF-8 BOM。
//
// 导入能力清单：
// - createXxxTool：返回 AgentTool，execute(callId,args,signal,onUpdate,ctx)。
// - createXxxToolDefinition：返回 ToolDefinition；测试直接调用五参数 execute 验证 ctx.cwd。
// - createLocalBashOperations：返回 BashOperations.exec(command,cwd,{onData,signal,timeout,env})。
// - executeBashWithOperations：复用同一 shell 后端，并按完整执行管线做输出清理。
// - computeEditsDiff：只生成编辑预览/错误，不写文件。
// - applyPatch：独立验证统一 patch 的可应用性。
//
// 运行命令（在 packages/coding-agent 下执行）：
// node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/tools.test.ts
// 需要本机 bash；grep/find 用例通过 ensureTool 使用或补齐 rg/fd。
// 部分信号用例在 Windows 上通过 it.skipIf 跳过，平台差异不会被伪装成通过。
//
// 典型示例：read 读取 2500 行文件，返回前 2000 行并在正文末尾提示 Use offset=2001；
// details.truncation 记录 truncatedBy="lines"、totalLines=2500、outputLines=2000。
// 示例描述的是断言场景，不是额外执行步骤。
//
// 阅读顺序：辅助函数 → read/write/edit/bash/grep/find/ls 基础组 → ctx.cwd → fuzzy → CRLF。
// 先读每个 it 前的说明，再看断言；测试名描述契约，注释解释为什么这样断言。
import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// executeBashWithOperations 是共享 shell 后端的另一入口，单独验证输出清理和完整日志路径。
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
// 直接导入工具定义与本地 shell 后端，便于构造自定义 operations 和验证 ctx.cwd 覆盖。
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
// 从包入口导入 AgentTool 适配工厂，确保公开装配路径也可用。
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
// 以命名空间导入 shell 模块，方便在进程边界 spy getShellConfig 而不替换文件系统。
import * as shellModule from "../src/utils/shell.ts";

// 模块级工具用 process.cwd() 创建；具体读取/写入路径由每个用例的绝对 testDir 提供。
// 这些对象只保存工厂配置，真正 I/O 发生在 execute。
const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const findTool = createFindTool(process.cwd());
const lsTool = createLsTool(process.cwd());

// 把工具结果中的文本块拼成字符串；只用于断言，不会把图片块转成文字。
// Helper to extract text from content blocks
// getTextOutput：输入任意工具结果，收集 type=text 的内容块并用换行连接，返回给断言使用的纯文本。
// content 可选链避免失败结果没有 content 时崩溃；filter/map 中临时 any 反映测试不依赖内容块联合类型。
// 例如多文本块 ["a","b"] 得到 "a\nb"；空/无文本得到空串。
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

// createTinyBmp1x1Red24bpp：构造最小 24 位 BMP 字节，不进行文件 I/O。
// BMP 头固定 14 字节 + DIB 头 40 字节 + 4 字节像素行；宽高各 1，像素从偏移 54 开始。
// 返回 Buffer，调用者写入临时文件后再验证 read 工具能否按 magic 识别并转换为 PNG。
function createTinyBmp1x1Red24bpp(): Buffer {
	// Buffer.alloc(58) 分配零初始化字节；偏移常量来自 BMP 文件格式，不是业务配置。
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

// 第一个大组验证基础工具行为；所有用例共享模块级工具，但各用独立临时目录隔离文件。
describe("Coding Agent Tools", () => {
	let testDir: string;

	// beforeEach：为每个用例创建唯一临时目录。
	// recursive:true 允许目录已存在；Date.now() 只降低并发碰撞概率，并非全局唯一保证。
	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	// afterEach：恢复 vi.spyOn 替换并删除临时目录，防止 mock 泄漏到后续用例。
	// restoreAllMocks 不会删除磁盘，所以 rmSync 是独立清理步骤。
	afterEach(() => {
		vi.restoreAllMocks();
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	// read 组：重点验证输出上限、offset/limit 语义、图片探测和程序化返回结构。
	describe("read tool", () => {
		// 小文件完整读取：内容未触发上限时原样返回文字，details 应为 undefined，
		// structuredContent 对文本文件就是同一个字符串，不是额外包装对象。
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
			expect(result.structuredContent).toBe(content);
		});

		// 目标不存在：read 先做 access 检查，execute 应拒绝 Promise；
		// 断言同时接受 Node 的 ENOENT 码和上层 not found 文案，避免绑定单一错误措辞。
		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		// 行数上限：2500 行文件只展示前 2000 行，并提示下一次 offset=2001。
		// 断言不包含第 2001 行，确认提示文字没有把未展示内容混进正文。
		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		// 字节上限：500 行但每行约 200 字节，总大小超过 50KB，触发按字节裁剪。
		// 正则只校验提示形状和 limit 文案，具体展示行数由内容字节决定，避免写死平台相关数字。
		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		// offset 语义：输入行号从 1 开始；offset=51 应跳过前 50 行，读到第 100 行。
		// 未触发默认上限，因此不应出现续读提示。
		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		// 仅 limit：读取前 10 行，随后用“90 more lines”和 offset=11 提示剩余内容。
		// 这是用户主动提前停止，不属于默认截断，因此走独立的 more-lines 分支。
		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file. Use offset=11 to continue.]");
		});

		// offset 与 limit 组合：第 41 行开始读 20 行，到第 60 行停止。
		// 剩余 40 行提示 offset=61，验证两个参数先共同选段、再计算续读位置。
		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file. Use offset=61 to continue.]");
		});

		// offset 越界：起始行超过文件总行数应抛明确错误，而不是返回空成功结果。
		// 正则包含总行数 3，便于模型据此修正下一次调用。
		it("should show error when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			await expect(readTool.execute("test-call-8", { path: testFile, offset: 100 })).rejects.toThrow(
				/Offset 100 is beyond end of file \(3 lines total\)/,
			);
		});

		// details 是结构化展示信息：截断时保存 truncated、truncatedBy、总行数和实际输出行数。
		// 这些字段与 content 中的提示文字来自同一截断结果，但用途不同。
		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		// 图片探测依据文件 magic 而非扩展名：PNG 字节写进 .txt 文件仍应识别为 image/png。
		// 内容顺序固定为“文字说明 + 图片块”，text 块报告 MIME，image 块携带 base64 数据。
		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			// find 回调使用类型谓词 c is {...}，让 imageBlock 在后续断言中被收窄为图片块；
			// 这只是 TypeScript 编译期收窄，运行时仍由 find 的实际返回值决定。
			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
			// 程序化 structuredContent 必须与图片块一致，并带首段文字作为 note；
			// 这对应 issue #10251：调用脚本不能只拿到文字说明而丢失图片数据。
			// Programmatic callers get the same image as a block. https://github.com/earendil-works/pi/issues/10251
			expect(result.structuredContent).toEqual({
				type: "image",
				data: imageBlock?.data,
				mimeType: "image/png",
				note: getTextOutput(result),
			});
		});

		// BMP 输入：read 先按 magic 识别 image/bmp，再经 processImage 转成 PNG；
		// 提示文字记录转换来源，输出块 MIME 变为 image/png。
		it("should read BMP files from disk as PNG image attachments", async () => {
			const testFile = join(testDir, "image.bmp");
			writeFileSync(testFile, createTinyBmp1x1Red24bpp());

			const result = await readTool.execute("test-call-img-bmp", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");
			expect(getTextOutput(result)).toContain("[Image converted from image/bmp to image/png.]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			// base64 解码后的首字节应为 PNG 签名 0x89，确认不是原样回传 BMP 字节。
			expect(Buffer.from(imageBlock?.data ?? "", "base64")[0]).toBe(0x89);
		});

		// 扩展名是 .png 但内容是普通文本：magic 探测返回空，工具应走文本分支，
		// 不能因为文件名看起来像图片就构造 image 块。
		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "definitely not a png");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("definitely not a png");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	// write 组：验证成功返回值、父目录自动创建，以及 details 始终为空。
	describe("write tool", () => {
		// 完整写入：工具返回包含目标路径的成功文字；details 为 undefined，
		// 因为 write 没有截断或 diff 等额外展示数据。
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toBe(`Successfully wrote to ${testFile}`);
			expect(result.details).toBeUndefined();
		});

		// 多级父目录不存在时，write 内部递归 mkdir 后再写文件；断言只看成功结果，
		// 目录和文件的最终存在性由 execute 完成前的 await 链保证。
		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	// edit 组：验证精确匹配、唯一性、重叠检测、失败原子性和 patch 可回放。
	describe("edit tool", () => {
		// 单处替换：返回成功提示，details 同时包含终端 diff 和标准 unified patch。
		// applyPatch 把工具生成的 patch 重新应用在原始文本上，证明 patch 不只是“看起来像”。
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(result.details.patch).toContain("--- ");
			expect(result.details.patch).toContain("+++ ");
			expect(result.details.patch).toContain("@@");
			expect(result.details.patch).toContain("-Hello, world!");
			expect(result.details.patch).toContain("+Hello, testing!");
			// applyPatch 是外部实现，不是被测代码；用它独立验证 patch 的语义正确性。
			expect(applyPatch(originalContent, result.details.patch)).toBe("Hello, testing!");
		});

		// oldText 原文不存在：核心匹配器应抛错，execute 拒绝 Promise，文件保持原样。
		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});

		// 目标文件缺失：access 失败在错误信息中保留 Node 的 ENOENT 错误码和用户路径。
		// 这里断言完整字符串，避免把“文件不存在”和其他编辑错误混为一谈。
		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${missingFile}. Error code: ENOENT.`);
		});

		// 同一 oldText 出现 3 次：精确替换要求唯一位置，应报告 occurred 数量并拒绝修改。
		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		// 多处互不重叠的编辑在一批中完成；每项都针对同一份原文匹配，最后一次性写回。
		// 成功提示中的 2 block(s) 表示两项替换都实际应用，磁盘内容逐行验证。
		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		// 大间隔多编辑的展示 diff 不应把中间 600 行全部展开；
		// 断言包含省略号且不含中间行，同时 diff 总行数受限，防止 UI 被无关上下文淹没。
		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		// 关键语义：第二项 oldText 的 "bar\n" 是原始文件中的行，
		// 不能把第一项产生的 "foo bar\n" 当作匹配输入；最终结果证明两项独立作用于原文。
		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		// edits 空数组没有明确操作，validateEditInput 直接抛错，连文件 access 都不必进入。
		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		// 两项 oldText 覆盖重叠区域（one/two 与 two/three）；匹配器必须拒绝，
		// 否则按顺序应用会造成位置偏移或重复替换。
		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		// 原子性：第二项找不到时整批失败，第一项不能先写入磁盘。
		// 断言文件仍等于 originalContent，证明匹配与写回之间没有部分提交。
		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		// 只读文件（0o444）能读但不能写；默认操作以 R_OK|W_OK 做 access，
		// 错误信息应保留 EACCES，而不是笼统报“编辑失败”。
		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${testFile}. Error code: EACCES.`);
		});

		// 注入自定义 operations，让 access 抛出非系统码错误；
		// 工具应退化为 String(error) 或 Error.message，把原始 "disk offline" 带给调用者。
		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					// 这里故意提供可读可写实现，使 access 的异常成为唯一失败来源，隔离错误格式化逻辑。
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Could not edit file: broken.txt. Error: disk offline.");
		});

		// computeEditsDiff 是预览路径：文件不存在时返回 {error} 对象而不是抛异常；
		// 与 execute 的拒绝语义不同，测试显式区分这两种契约。
		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});

		// chmod 0o222 只保留写权限，读文件会 EACCES；预览结果应保留同样的错误码。
		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			chmodSync(unreadableFile, 0o222);

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});
	});

	// bash 组：覆盖真实进程、注入后端、取消/超时、输出上限、shell 选择和流式更新。
	describe("bash tool", () => {
		// 真实本地 bash 执行 echo；成功且输出未截断时 details 为 undefined。
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		// 非零退出不是 Promise 拒绝，而是 isError:true 的工具结果：模型看到失败说明，
		// 程序调用者仍获得结构化 output/exit_code/wall_time_seconds。
		// 随后两条断言覆盖成功命令和无输出的 true 命令，区分 undefined isError 与空输出占位。
		it("should report non-zero exit codes as error results with structured content", async () => {
			const result = await bashTool.execute("test-call-9", { command: "echo out; exit 3" });
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toBe("out\n\n\nCommand exited with code 3");
			// structuredContent 的 output 是完整 stdout/stderr 合并正文；wall_time_seconds 只要求数字，
			// 因为实际耗时随机器变化，断言不应绑定具体值。
			expect(result.structuredContent).toEqual({
				output: "out\n",
				truncated: false,
				exit_code: 3,
				wall_time_seconds: expect.any(Number),
			});

			const ok = await bashTool.execute("test-call-9b", { command: "echo fine" });
			expect(ok.isError).toBeUndefined();
			expect(ok.structuredContent).toMatchObject({ output: "fine\n", exit_code: 0 });

			const empty = await bashTool.execute("test-call-9c", { command: "true" });
			expect(getTextOutput(empty)).toBe("(no output)");
			expect(empty.structuredContent).toMatchObject({ output: "", truncated: false });
		});

		// 模型可见输出保留最后 2000 行，因此 3000 行命令的正文不包含开头；
		// 但程序化 structuredContent 有 1 MiB 预算，3000 行仍完整且 truncated=false。
		// 约 2 MB 的输出则保留首尾各 512 KiB，中间插入省略标记，并给出完整日志路径。
		it("should return up to 1 MiB of output in structured content", async () => {
			// 3000 lines exceed the model-facing 2000 line limit but not 1 MiB.
			const medium = await bashTool.execute("test-call-9d", { command: "seq 1 3000" });
			expect(getTextOutput(medium)).not.toContain("\n1\n2\n");
			expect(medium.details?.truncation?.truncated).toBe(true);
			const mediumOutput = medium.structuredContent as { output: string; truncated: boolean };
			expect(mediumOutput.truncated).toBe(false);
			expect(mediumOutput.output).toBe(`${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`);

			// About 2 MB: keeps the first and last 512 KiB around an omission marker.
			const large = await bashTool.execute("test-call-9e", { command: "seq 1 300000" });
			const largeOutput = large.structuredContent as {
				output: string;
				truncated: boolean;
				full_output_path?: string;
			};
			expect(largeOutput.truncated).toBe(true);
			expect(largeOutput.output.startsWith("1\n2\n3\n")).toBe(true);
			expect(largeOutput.output.endsWith("299999\n300000\n")).toBe(true);
			expect(largeOutput.output).toMatch(/\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/);
			expect(Buffer.byteLength(largeOutput.output)).toBeLessThan(1024 * 1024 + 100);
			expect(largeOutput.full_output_path).toBe(large.details?.fullOutputPath);
			expect(readFileSync(largeOutput.full_output_path!, "utf-8").endsWith("300000\n")).toBe(true);
		});

		// 回归测试 #9577：shell 被信号杀死通常没有普通退出码，需按 128+信号编号报告。
		// Regression tests for https://github.com/earendil-works/pi/issues/9577
		// it.skipIf 在收集阶段根据平台决定是否注册用例；Windows 没有相同的信号语义，因此跳过。
		// 回调内仍使用真实 createLocalBashOperations，直接观察 exec 返回的 exitCode 映射。
		it.skipIf(process.platform === "win32")(
			"should map signal-killed commands to 128 plus the signal number",
			async () => {
				const operations = createLocalBashOperations();
				// 表驱动两组信号：KILL=9 映射 137，TERM=15 映射 143；$$ 是当前 shell PID。
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await operations.exec(`kill -${signal} $$`, testDir, { onData: () => {} });
					expect(result.exitCode).toBe(exitCode);
				}
			},
		);

		// 信号终止也要保留终止前的部分输出，并作为 isError 工具结果返回；
		// 正则中的 \s+ 兼容输出与状态说明之间的换行和尾部空白。
		it.skipIf(process.platform === "win32")(
			"should report signal-killed commands as errors while preserving partial output",
			async () => {
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await bashTool.execute(`test-call-signal-${signal}`, {
						command: `printf 'before-kill\\n'; kill -${signal} $$`,
					});
					expect(result.isError).toBe(true);
					expect(getTextOutput(result)).toMatch(
						new RegExp(`before-kill\\s+Command exited with code ${exitCode}$`),
					);
				}
			},
		);

		// 自定义后端返回 exitCode:null 表示没有可靠退出结果；工具必须拒绝，
		// 同时把抛错前已产生的输出保留在错误信息中，不能当成成功或空输出。
		it("should reject a null exit code from custom operations", async () => {
			// BashOperations 类型要求 exec 接受 onData/cwd/options 并异步返回 exitCode；
			// 这个假实现只调用 onData 再返回 null，专门触发空退出码分支。
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n", "utf-8"));
					return { exitCode: null };
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("test-call-null-exit", { command: "remote" })).rejects.toThrow(
				/partial\s+Command terminated without an exit code$/,
			);
		});

		// 超时用 Node 自身运行一个永不结束的 interval，timeout 单位是秒（0.05 秒）。
		// 期望拒绝，而不是返回 isError 结果，因为工具层把超时转换为失败 Promise。
		it("should respect timeout", async () => {
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(/timed out/i);
		});

		// 超时与用户取消都要在错误信息中附带完整输出路径，便于事后查看被裁剪日志。
		// 两个假后端先输出 3000 行再抛约定错误，验证输出收尾发生在错误分类之前。
		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Command timed out after 5 seconds" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				// 使用 let error: unknown 捕获不同实现抛出的值，再在断言前收窄为 Error；
				// 这比直接 catch 变量更符合外部异常边界的类型处理。
				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				// 从错误文字中提取 Full output 路径；断言路径存在且日志同时含开头和结尾，
				// 证明完整日志是在裁剪之外单独保存的。
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		// 工作目录不存在应在 spawn 前被识别，返回带目录说明的专门错误。
		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		// mockReturnValueOnce 只替换下一次 getShellConfig 调用，构造一个不存在的 shell；
		// 这样能验证底层 spawn 的 ENOENT 会传播为工具失败。
		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		// 传入自定义 operations 时，createBashTool 不应调用 shell 解析器：
		// 后端完全由调用者提供，getShellConfig 的调用次数为 0。
		// 另建 createLocalBashOperations({shellPath}) 才会在真正 exec 时触发解析并报路径不存在。
		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		// stdin 传输模式：mock 的 shell 实际是 Node 进程，它把 stdin 原样写到 stdout。
		// 命令里的 ${name} 等被拆成 "$" + "{...}" 拼接，避免测试文件自身发生模板插值，
		// 从而确认发送的是 shell 源文本而不是测试提前展开后的字符串。
		it("should send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "$" + "{name}";
			const countExpansion = "$" + "{count}";
			const iExpansion = "$" + "{i}";
			const command = `name='World'; echo "Hello, ${nameExpansion}!"; count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		// 旧 WSL bash.exe 走 -s + stdin；测试在非 Windows 上临时伪造 process.platform，
		// 并在 finally 中恢复 chdir 与原始属性描述符，避免污染其他用例。
		it("should resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			// Object.getOwnPropertyDescriptor 保存 platform 是否可配置、是否可枚举等完整属性，
			// 后续用同一个描述符恢复，比直接赋值更接近原始状态。
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				// defineProperty 允许只改 value 而不重建属性；configurable:true 使 finally 能再次定义。
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		// commandPrefix 会插在每条命令前并用换行分隔；这里用 export 设置变量，
		// 命令正文在同一 shell 中读取它，验证前缀不是独立进程执行。
		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		// 前缀自身也可能产生输出；最终正文按前缀输出、命令输出的顺序合并。
		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		// 未配置 prefix 时原命令不变，避免默认注入任何隐藏文本。
		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		// 5000 次小块输出只触发了少于 25 次 onUpdate，验证节流合并；
		// 最终结果仍包含最后一行，说明节流只影响中间通知，不丢失累计输出。
		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			// 第四个参数是 onUpdate 回调；这里收集每次进度对象，用于断言数量而不是内容细节。
			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		// 末尾换行不应额外算一行：4000 行的输出恰好保留最后 2000 行，
		// totalLines=4000、outputLines=2000，提示从 2001 行开始。
		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		// 把一个 UTF-8 欧元符号拆成两个 Buffer 块发送，验证 OutputAccumulator 的增量解码，
		// 不会因为多字节字符跨 chunk 而出现替换字符。
		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result).trim()).toBe("€");
		});

		// createLocalBashOperations 可被扩展复用；传入显式 env 时应覆盖默认 shell 环境，
		// 命令能读到 TEST_LOCAL_BASH_OPS，onData 收到的字节可拼回该值。
		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		// executeBashWithOperations 共享同一本地后端，并额外剥离 ANSI 颜色与转换 CRLF；
		// 输入包含 ESC[31m 和 \r\n，期望最终只剩 red 加一个换行。
		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		// 只按行数截断时也必须持久化完整输出，而不是只在字节超限时写日志；
		// 输出路径由 details.fullOutputPath 暴露，正文提示中不能出现 undefined。
		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			// 临时日志写入是异步的，短暂轮询等待文件出现；最多 20 次、每次 10ms，
			// 避免固定 sleep 拖慢测试，也避免无限等待。
			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		// 同一行为从 executeBashWithOperations 入口再验证一次，确保两条调用路径共用持久化契约。
		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	// grep 组：覆盖单文件与目录搜索、上下文/limit、rg 配置隔离和命令行参数注入防护。
	describe("grep tool", () => {
		// 搜索单个文件时仍显示 basename 和行号；命中行格式为 file:line: text。
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		// limit=1、context=1：只收集第一个匹配，但展示它前后各一行；
		// 上下文行使用短横线格式，且 limit 提示说明第二个匹配未返回。
		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			// 上下文行的格式是 file-line- text（短横线），与命中行的冒号格式区分。
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		// 回归测试 #11398：文件含孤立 CR 时，rg 的行号与工具按 LF 拆行的上下文必须对齐。
		// https://github.com/earendil-works/pi/issues/11398
		// 文件内容 "before\rprogress\nneedle\nafter"：孤立 CR 不是换行，
		// 上下文第 1 行应显示拼接后的 beforeprogress，命中仍是第 2 行。
		it("should keep context line numbers aligned with ripgrep when a file contains a lone CR", async () => {
			const testFile = join(testDir, "lone-cr.txt");
			writeFileSync(testFile, "before\rprogress\nneedle\nafter");

			const result = await grepTool.execute("test-call-lone-cr", {
				pattern: "needle",
				path: testFile,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("lone-cr.txt-1- beforeprogress");
			expect(output).toContain("lone-cr.txt:2: needle");
			expect(output).toContain("lone-cr.txt-3- after");
		});

		// 回归测试 #11203：工具参数必须不受用户 RIPGREP_CONFIG_PATH 影响。
		// https://github.com/earendil-works/pi/issues/11203
		// 配置文件强制 --fixed-strings；若 rg 读取它，"a.b" 只会命中字面量第二行。
		// 工具加 --no-config 后正则仍生效，应同时命中 aXb 和 a.b。
		it("should ignore RIPGREP_CONFIG_PATH", async () => {
			const configFile = join(testDir, "rg-config");
			const testFile = join(testDir, "fixture.txt");
			writeFileSync(configFile, "--fixed-strings\n");
			writeFileSync(testFile, "aXb\na.b\n");

			// 保存并恢复环境变量，finally 保证测试失败时也不污染后续用例。
			const previous = process.env.RIPGREP_CONFIG_PATH;
			process.env.RIPGREP_CONFIG_PATH = configFile;
			try {
				const result = await grepTool.execute("test-call-rg-config", {
					pattern: "a.b",
					path: testFile,
					literal: false,
				});

				const output = getTextOutput(result);
				expect(output).toContain("fixture.txt:1: aXb");
				expect(output).toContain("fixture.txt:2: a.b");
			} finally {
				if (previous === undefined) delete process.env.RIPGREP_CONFIG_PATH;
				else process.env.RIPGREP_CONFIG_PATH = previous;
			}
		});

		// 参数注入防护：pattern 以 --pre= 开头时，应作为搜索文本而非 rg 选项。
		// payload.sh 会在被当作 preprocessor 执行时创建 marker；marker 不存在证明没有执行。
		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			// 这个脚本字符串是攻击载荷内容，仅写入临时文件；注释不进入脚本正文。
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload}`,
				path: testDir,
			});

			// 没有匹配是正常成功结果；关键断言是 marker 不存在，即命令未被执行。
			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});
	});

	// find 组：验证 fd 的隐藏文件/gitignore 语义、glob 错误和 flag-like 模式安全。
	describe("find tool", () => {
		// 默认 fd 参数包含 --hidden，所以 .secret/hidden.txt 应出现；
		// 它不是 gitignore 条目，不能被忽略规则误删。
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await findTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			// 把输出拆行、去空白并过滤空行，避免对整体字符串顺序做脆弱断言。
			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		// 临时目录不是 Git 仓库，但工具在仓库外添加 --no-require-git，
		// 因此 .gitignore 仍生效：kept.txt 出现，ignored.txt 不出现。
		it("should respect .gitignore", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");

			const result = await findTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		// 非法 glob "[" 应由 fd 报解析错误；断言接受 stderr 文案或退出码兜底，
		// 因为不同 fd 版本错误措辞可能不同。
		it("should surface fd glob parse errors", async () => {
			await expect(
				findTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});

		// "--help" 位于 -- 之后，应作为 glob 模式而非 fd 选项；
		// 空目录下得到正常的 No files found，而不是打印帮助后失败。
		it("should treat flag-like patterns as search text", async () => {
			const result = await findTool.execute("test-call-find-flag-pattern", {
				pattern: "--help",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
		});
	});

	// ls 组：直接列出目录条目，验证点文件和目录尾斜杠。
	describe("ls tool", () => {
		// 创建普通点文件和点目录；ls 应包含两者，目录以 / 结尾，
		// 且不因名称以点开头而隐藏。
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

// fakeCtx：测试只需要 cwd 字段，因此用类型断言构造最小 ExtensionToolContext。
// 这不是运行时完整校验；真实调用方会提供符合接口的上下文对象。
function fakeCtx(cwd: string): ExtensionToolContext {
	return { cwd } as ExtensionToolContext;
}

// cwd resolution 组：工具工厂传 "/"，但 execute 第五参提供 testDir，
// 每个用例都应证明相对路径按 ctx.cwd 解析，而不是按工厂目录。
describe("tool cwd resolution", () => {
	let testDir: string;

	// beforeEach：本组同样创建独立临时目录，防止与上一大组的文件重名。
	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	// afterEach：只清理本组目录；该组没有 spy，所以无需 restoreAllMocks。
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// read 定义以 "/" 创建，相对路径 ctx-cwd-read.txt 能读到，说明 ctx.cwd 优先。
	it("read uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-read.txt");
		writeFileSync(testFile, "hello from ctx.cwd");
		const tool = createReadToolDefinition("/");
		const result = await tool.execute(
			"test-read-ctx-cwd",
			{ path: "ctx-cwd-read.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("hello from ctx.cwd");
	});

	// write 同样以 "/" 创建；文件最终出现在 testDir，而不是根目录或进程 cwd。
	it("write uses ctx.cwd when provided", async () => {
		const tool = createWriteToolDefinition("/");
		await tool.execute(
			"test-write-ctx-cwd",
			{ path: "ctx-cwd-write.txt", content: "written via ctx.cwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(join(testDir, "ctx-cwd-write.txt"), "utf-8");
		expect(content).toBe("written via ctx.cwd");
	});

	// edit 的读取与写回都走 ctx.cwd；断言最终内容确保路径解析发生在编辑链路内。
	it("edit uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-edit.txt");
		writeFileSync(testFile, "old text");
		const tool = createEditToolDefinition("/");
		await tool.execute(
			"test-edit-ctx-cwd",
			{ path: "ctx-cwd-edit.txt", edits: [{ oldText: "old text", newText: "new text" }] },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("new text");
	});

	// grep 未传 path，默认搜索根应由 ctx.cwd 决定；输出包含相对文件名。
	it("grep uses ctx.cwd when provided", async () => {
		const testFile = join(testDir, "ctx-cwd-grep.txt");
		writeFileSync(testFile, "match in ctx.cwd");
		const tool = createGrepToolDefinition("/");
		const result = await tool.execute(
			"test-grep-ctx-cwd",
			{ pattern: "match" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-grep.txt");
	});

	// find 只传 pattern，搜索根同样来自 ctx.cwd；命中文件名即可证明。
	it("find uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-find.txt"), "find me");
		const tool = createFindToolDefinition("/");
		const result = await tool.execute(
			"test-find-ctx-cwd",
			{ pattern: "ctx-cwd-find.txt" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-find.txt");
	});

	// ls 不传 path，列出 ctx.cwd 下的文件；没有文件就无法观察到目录覆盖。
	it("ls uses ctx.cwd when provided", async () => {
		writeFileSync(join(testDir, "ctx-cwd-ls.txt"), "list me");
		const tool = createLsToolDefinition("/");
		const result = await tool.execute("test-ls-ctx-cwd", {}, undefined, undefined, fakeCtx(testDir));
		const output = getTextOutput(result);
		expect(output).toContain("ctx-cwd-ls.txt");
	});

	// bash 用 pwd 直接打印工作目录，是最直接的 ctx.cwd 断言；
	// 关闭会话环境暴露，避免 PI_* 元数据干扰测试输出。
	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute(
			"test-bash-ctx-cwd",
			{ command: "pwd" },
			undefined,
			undefined,
			fakeCtx(testDir),
		);
		const output = getTextOutput(result);
		// testDir 是 tmpdir 的绝对路径；pwd 输出应包含它，而不是工厂传入的 "/"。
		expect(output).toContain(testDir);
	});
});

// fuzzy matching 组：验证模型省略微小格式差异时仍能定位原文，
// 同时保证精确匹配优先、歧义检测和写回内容正确。
describe("edit tool fuzzy matching", () => {
	let testDir: string;

	// beforeEach：fuzzy 测试同样使用独立临时目录，文件内容由每个用例精确控制。
	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-fuzzy-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	// afterEach：删除本次 fuzzy 测试目录；没有 mock 需要恢复。
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// 文件每行带尾随空格，oldText 不带；归一化匹配成功后，
	// 写回的是替换文本加原文件剩余行，不保留被替换区域的尾随空格。
	it("should match text with trailing whitespace stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		// File has trailing spaces on lines
		writeFileSync(testFile, "line one   \nline two  \nline three\n");

		// oldText without trailing whitespace should still match
		const result = await editTool.execute("test-fuzzy-1", {
			path: testFile,
			edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("replaced\nline three\n");
	});

	// 中文全角逗号和括号与 ASCII 标点按归一化形式匹配；
	// newText 中的全角逗号保留，ASCII 括号则按原文写法写回。
	it("should match fullwidth punctuation in Chinese text", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		writeFileSync(testFile, "你好，世界\n你好（世界）\n");

		const result = await editTool.execute("test-fuzzy-chinese", {
			path: testFile,
			edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("你好，pi\n你好(pi)\n");
	});

	// 全角 ＡＢＣ１２３ 与 ASCII ABC123、组合字符 cafe\u0301 与预组合 café
	// 属于 Unicode 兼容/规范化等价；匹配成功后新文本整体替换这两行。
	it("should match compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		writeFileSync(testFile, "ＡＢＣ１２３\ncafe\u0301\n");

		const result = await editTool.execute("test-fuzzy-unicode", {
			path: testFile,
			edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("XYZ789\ncoffee\n");
	});

	// 文件使用 U+2018/U+2019 智能单引号，oldText 使用 ASCII 单引号；
	// 归一化只影响匹配定位，newText 按调用者提供的内容写回。
	it("should match smart single quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		// File has smart/curly single quotes (U+2018, U+2019)
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-2", {
			path: testFile,
			edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("world");
	});

	// 同理验证 U+201C/U+201D 智能双引号；文件是双引号字符串，
	// 断言最终包含 Goodbye，避免依赖换行或完整文件格式。
	it("should match smart double quotes to ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		// File has smart/curly double quotes (U+201C, U+201D)
		writeFileSync(testFile, "const msg = \u201CHello World\u201D;\n");

		// oldText with ASCII quotes should match
		const result = await editTool.execute("test-fuzzy-3", {
			path: testFile,
			edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("Goodbye");
	});

	// en dash U+2013 与 em dash U+2014 都归一化为 ASCII 连字符参与匹配；
	// 替换文本 range: 10-50 使用普通连字符。
	it("should match Unicode dashes to ASCII hyphen", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		// File has en-dash (U+2013) and em-dash (U+2014)
		writeFileSync(testFile, "range: 1\u20135\nbreak\u2014here\n");

		// oldText with ASCII hyphens should match
		const result = await editTool.execute("test-fuzzy-4", {
			path: testFile,
			edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("10-50");
	});

	// NBSP U+00A0 在视觉上是空格，但字节不同；oldText 的普通空格应能匹配。
	it("should match non-breaking space to regular space", async () => {
		const testFile = join(testDir, "nbsp.txt");
		// File has non-breaking space (U+00A0)
		writeFileSync(testFile, "hello\u00A0world\n");

		// oldText with regular space should match
		const result = await editTool.execute("test-fuzzy-5", {
			path: testFile,
			edits: [{ oldText: "hello world", newText: "hello universe" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toContain("universe");
	});

	// 精确匹配优先：文件里本来就有完全相同的 oldText，即使模糊规则也能匹配其他内容，
	// 工具应先采用精确位置，避免不必要地改写格式。
	it("should prefer exact match over fuzzy match", async () => {
		const testFile = join(testDir, "exact-preferred.txt");
		// File has both exact and fuzzy-matchable content
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-fuzzy-6", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	// 模糊匹配不是“任意近似”：完全不同的文字仍应报 Could not find，
	// 不能让模型误以为任何 oldText 都能成功。
	it("should still fail when text is not found even with fuzzy matching", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-fuzzy-7", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});

	// 两行只差尾随空格，归一化后都等于 oldText；必须报告 2 个候选并拒绝，
	// 唯一性检查发生在归一化之后，而不是仅比较原始字节。
	it("should detect duplicates after fuzzy normalization", async () => {
		const testFile = join(testDir, "fuzzy-dups.txt");
		// Two lines that are identical after trailing whitespace is stripped
		writeFileSync(testFile, "hello world   \nhello world\n");

		await expect(
			editTool.execute("test-fuzzy-8", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	// 多编辑模式也使用同一模糊匹配：智能引号和 NBSP 两处都能定位，
	// 最终文件应同时体现两处替换。
	it("should support fuzzy matching in multi-edit mode", async () => {
		const testFile = join(testDir, "fuzzy-multi.txt");
		writeFileSync(testFile, "console.log(\u2018hello\u2019);\nhello\u00A0world\n");

		await editTool.execute("test-fuzzy-9", {
			path: testFile,
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		});

		expect(readFileSync(testFile, "utf-8")).toBe("console.log('world');\nhello universe\n");
	});

	// 关键边界：替换文本 "after\n" 与后面一条带尾随空格的行归一化后相同；
	// 工具必须替换选中的第一处，并保留未选中的 "after   " 行。
	// 再用 applyPatch 验证 details.patch 能在原文上重放出同样结果。
	it("should preserve the correct occurrence when fuzzy replacement equals a nearby line", async () => {
		const testFile = join(testDir, "fuzzy-preserve-duplicate-line.txt");
		const originalContent = ["replace me\u0020\u0020\u0020", "after\u0020\u0020\u0020", ""].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-duplicate-line", {
			path: testFile,
			edits: [{ oldText: "replace me\n", newText: "after\n" }],
		});

		const expectedContent = ["after", "after\u0020\u0020\u0020", ""].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});

	// 两项模糊多编辑之间夹着未修改行；最终内容应保留这些行及其尾随空格，
	// 同时 patch 应用结果与磁盘结果一致，证明 diff 没有吞掉上下文。
	it("should preserve untouched lines and produce an applicable patch for fuzzy multi-edits", async () => {
		const testFile = join(testDir, "fuzzy-preserve-multi.txt");
		const originalContent = [
			"keep before\u0020\u0020",
			"first target\u0020\u0020",
			"first after",
			"keep middle\u0020\u0020\u0020",
			"second target\u0020\u0020",
			"second after",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		writeFileSync(testFile, originalContent);

		const result = await editTool.execute("test-fuzzy-preserve-multi", {
			path: testFile,
			edits: [
				{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
				{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
			],
		});

		const expectedContent = [
			"keep before\u0020\u0020",
			"FIRST",
			"FIRST2",
			"keep middle\u0020\u0020\u0020",
			"SECOND",
			"SECOND2",
			"keep after\u0020\u0020",
			"",
		].join("\n");
		expect(readFileSync(testFile, "utf-8")).toBe(expectedContent);
		expect(applyPatch(originalContent, result.details?.patch ?? "")).toBe(expectedContent);
	});
});

// CRLF handling 组：edit 匹配前统一换行为 LF，写回时恢复原文件换行习惯。
describe("edit tool CRLF handling", () => {
	let testDir: string;

	// beforeEach：每个换行/BOM 用例使用独立目录，避免文件内容互相影响。
	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	// afterEach：清理本组临时目录；本组无 mock。
	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// 文件是 CRLF，oldText 是 LF；normalizeToLF 后应匹配成功。
	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	// 检测原文换行为 CRLF，恢复时把新文本中的 LF 全部转回 CRLF；
	// 断言完整字符串，确保只有目标行改变。
	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	// LF 文件不应被无故改成 CRLF；写回保持 LF。
	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	// 同一内容以 CRLF 和 LF 各出现一次，归一化后有两个相同候选；
	// 即使原始字节不同，也必须报告 Found 2 occurrences。
	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	// UTF-8 BOM 在匹配前被拆出，写回时原样拼回；
	// 断言首字符仍是 U+FEFF，且 CRLF 也保持不变。
	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	// 多编辑同时验证 BOM 和 CRLF：两处替换后，首部 BOM 与每行 CRLF 都要保留。
	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
