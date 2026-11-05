/**
 * Process @file CLI arguments into text content and image attachments
 */

// CLI 的 @file 材料装配器，与模型运行中调用的 read 工具不同；文件内容会进入初始用户消息。

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	// 文本文件正文和图片引用，带 <file> 标记，保持输入文件顺序。
	text: string;
	// 图片字节已经编码为模型内容块需要的 base64，独立于 text。
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
/**
 * 依次读取 @file 参数，返回可以交给初始 prompt 的文字和图片。
 * 参数 fileArgs 是已去掉 @ 前缀的路径；options 控制图片是否缩放。async 表示结果需要 await。
 * 流程：解析路径 → 检查存在/大小 → 判断图片 → 处理图片或 UTF-8 文字 → 汇总。
 * 例：传 ["README.md","shot.png"]，README 正文在 text，截图内容块在 images。
 * 副作用：读取本机文件；缺文件或文本读取失败会输出错误并退出进程，空文件则跳过。
 */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	// ?? 只在空缺时用 true；显式传 false 不会被覆盖。
	const autoResizeImages = options?.autoResizeImages ?? true;
	// let 允许循环中反复拼接新的字符串。
	let text = "";
	// 数组按实际成功处理的图片顺序累计。
	const images: ImageContent[] = [];

	// for...of 逐个拿路径值，而不是数组下标。
	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		// 处理 ~、特殊空格等路径形式，再相对当前进程目录转成绝对路径。
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			// access 检查能否访问；此处不是 read.ts 中带 R_OK 的自定义访问操作。
			await access(absolutePath);
		} catch {
			// catch 不绑定异常变量；这里统一展示“文件未找到”提示。
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			// 非零退出码让 shell/脚本知道本次 CLI 输入准备失败。
			process.exit(1);
		}

		// Check if file is empty
		// stat 获取大小等元数据，此处还没把整个正文读入内存。
		const stats = await stat(absolutePath);
		// 跳过空文件，避免向模型注入无内容的附件。
		if (stats.size === 0) {
			// Skip empty files
			// continue 开始处理下一个文件，不退出整个函数。
			continue;
		}

		// 根据支持的图片类型决定分支；没有图片 MIME 时走文本读取。
		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		// MIME 字符串存在时，把文件当图片字节处理。
		if (mimeType) {
			// Handle image file
			// 不传文字编码，readFile 返回 Buffer 字节。
			const content = await readFile(absolutePath);
			// 等待图片归一化；成功结果可能带尺寸调整提示。
			const processed = await processImage(content, mimeType, { autoResizeImages });

			// ok 是结果的分辨字段；false 时 TS 知道可读取 message 说明。
			if (!processed.ok) {
				// 图片处理失败也保留文字说明，便于模型知道有这个文件但没有可用图片。
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				// 不创建坏图片附件，继续下一个文件。
				continue;
			}

			// 显式类型确保内容块满足统一图片消息结构，类型本身不产生运行时验证。
			const attachment: ImageContent = {
				// 字面量标签让下游区分图片与文字块。
				type: "image",
				// 使用转换后的实际 MIME，不假设它仍与输入扩展名相同。
				mimeType: processed.mimeType,
				// base64 数据供后续供应商请求编码；不是文件路径。
				data: processed.data,
			};
			// 将图片加入独立数组；text 中只保留引用及提示。
			images.push(attachment);

			// Add text reference to image with optional processing hints
			// 有提示才把它们写进文件引用，例如图片被缩小的说明。
			if (processed.hints.length > 0) {
				// join 用换行连接提示，模板字符串中的 ${...} 将值插入正文。
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				// 没有提示时只给图片文件名引用，真正内容在 images。
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				// 指定 utf-8 得到字符串，stripBom 移除开头的字节序标记字符。
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				// 文件名与正文一起加入初始输入，模型可分辨材料来自哪个文件。
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				// unknown 必须先判断再访问 .message；非 Error 的抛出值转成字符串。
				const message = error instanceof Error ? error.message : String(error);
				// 错误走 stderr，不混进 CLI 正常输出。
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				// 中止整个命令，避免悄悄遗漏用户明确要求附带的文件。
				process.exit(1);
			}
		}
	}

	// 对象属性简写，等价于 {text:text, images:images}。
	return { text, images };
}
