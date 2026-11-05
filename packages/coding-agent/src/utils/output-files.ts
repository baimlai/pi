// 集中创建工具/MCP/codemode的输出文件，返回路径供后续读取；截断的是模型看到的文本，完整输出可另存在这些临时文件里。
/**
 * Output files: files pi writes so the model can use output it was not shown in full, such as the
 * full text of truncated tool output, binary MCP resources, and images shown by codemode scripts.
 * Every output file is created here, so where they are stored can change in one place. Today they
 * go to the OS temp directory.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Output can carry private data, so only the user may read the files. */
// 八进制0o600请求仅文件所有者读写；实际权限还受平台文件系统与umask规则影响，不是加密。
const OUTPUT_FILE_MODE = 0o600;

/** A new, unused path: `<dir>/<prefix>-<random hex><extension>`. `extension` includes the dot. */
// 输入调用方提供的前缀/带点后缀，返回系统临时目录下随机路径，不创建或预占文件。
// 例如前缀pi-bash和.log拼出类似pi-bash-0123456789abcdef.log；随机降低碰撞概率，真正排他创建由下层wx保证。
// 本函数不清理/限制prefix或extension中的路径字符，当前调用方传固定用途前缀与文件类型后缀；不把它当任意不可信路径验证器。
function createOutputFilePath(prefix: string, extension: string): string {
	// 8随机字节编码为16个十六进制字符；join只拼/规范路径，不检查文件是否已经存在。
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}${extension}`);
}

/** Write `data` to a new output file and return its path. */
// 输入前缀、后缀及文字/字节数据，异步排他写入新文件并返回路径；失败拒绝Promise，不在这里重试或清理半写文件。
// 例如MCP二进制资源用Uint8Array写入.bin，文本输出可写.txt；await只在writeFile完成后才拿到成功路径，不保证fsync持久化。
export async function writeOutputFile(prefix: string, extension: string, data: string | Uint8Array): Promise<string> {
	// 先生成候选路径，此时还没有文件；string | Uint8Array表示两种合法数据输入的联合类型。
	const path = createOutputFilePath(prefix, extension);
	// `wx` never follows a link someone else placed at the path.
	// wx表示创建且目标已存在则失败，不覆盖旧文件或跟随同名符号链接；mode只用于新文件权限。
	await writeFile(path, data, { mode: OUTPUT_FILE_MODE, flag: "wx" });
	// 写入正常完成后返回路径，后续删除/保留由调用方管理，这里没有自动过期回收。
	return path;
}

/** Open a new output file for streamed output. */
// 输入前缀/后缀，立即返回{path,stream}供持续写入，无await；打开/写入错误通常由stream的error事件报告。
// 例如输出累计器不断stream.write(chunk)，最后自行end并处理错误；函数返回不表示文件已打开、更不表示内容写完。
export function createOutputFileStream(prefix: string, extension: string): { path: string; stream: WriteStream } {
	// 与一次性写入共用命名规则，不在命名阶段做磁盘存在性检查。
	const path = createOutputFilePath(prefix, extension);
	// 对象属性简写保留path，排他WriteStream异步打开文件；调用方负责结束流及监听失败。
	return { path, stream: createWriteStream(path, { mode: OUTPUT_FILE_MODE, flags: "wx" }) };
}
