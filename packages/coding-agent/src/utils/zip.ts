// 为bug report把少量内存文件打成经典ZIP并写盘；本模块只创建归档，不解压、不提交报告，也不自动对内容脱敏。
import { writeFile } from "node:fs/promises";
import { crc32, deflateRawSync } from "node:zlib";

// 一个归档条目：name是ZIP内的路径文字，data是UTF8文本或二进制；接口不检查名字是否重复/越界路径。
interface ZipEntry {
	name: string;
	data: string | Uint8Array;
}

// 输入Date，按本地时间拼DOS时间/日期两个数值，无I/O；秒以两秒为单位，奇数秒会丢最低位。
// 例如03:04:05存成03:04:04；年份只在下界钳到1980，没有校验无效Date或限制最高年份，因此不保证任意Date都能写入16位字段。
function dosDateTime(date: Date): { time: number; day: number } {
	return {
		// <<把时/分放到对应位，|合并；>>1把秒除2取整，使用本地getHours而非UTC。
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		// DOS年从1980开始，月占4位、日占5位；getMonth从0开始，故要+1。
		day: ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** Create the small, classic ZIP archives used by bug reports. */
// 输入只读条目数组，在内存中同步压缩并返回完整Buffer；无文件I/O，会阻塞当前线程、分配压缩内容及归档内存。
// 例如[{name:"report.txt",data:"错误描述"}]产生UTF8命名的Deflate ZIP；所有条目共用本次时间，不是保留原文件mtime。
// 流程：每条本地头+文件名+压缩数据→中央目录条目→中央目录结束记录；不支持ZIP64/加密/流式大包，数量和长度超字段范围可抛错。
// readonly只在开发期禁止经此数组引用push等修改，不冻结条目/数据；本函数读取并复制字节，不修改输入数组。
function createZipArchive(entries: readonly ZipEntry[]): Buffer {
	// Buffer[]是字节块数组；files保存文件区，directory保存索引区，最后统一concat。
	const files: Buffer[] = [];
	const directory: Buffer[] = [];
	// 解构提取本次统一DOS时间/日期，按创建归档时宿主的本地时区编码。
	const { time, day } = dosDateTime(new Date());
	// 记录下一条本地文件头在归档起点的字节偏移，中央目录需引用它。
	let offset = 0;

	for (const entry of entries) {
		// 文件名默认按UTF8编码，长度统计字节而不是JS字符数。
		const name = Buffer.from(entry.name);
		// 文本转UTF8；二进制分支复制Uint8Array内容，两个分支都保留原有Buffer.from行为。
		const data = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data);
		// ZIP方法8需要raw Deflate，不加zlib头尾；同步压缩不一定比原始小。
		const compressed = deflateRawSync(data);
		// CRC32是解压后的原始内容校验，不是加密签名或防恶意篡改证明。
		const checksum = crc32(data);

		// 30字节固定本地头，alloc初始全0，因此未设置的extra长度等字段为0；LE表示小端写入。
		const local = Buffer.alloc(30);
		// 本地头签名，对应字节PK后跟03 04。
		local.writeUInt32LE(0x04034b50, 0);
		// 解压所需版本2.0，以十进制20存储。
		local.writeUInt16LE(20, 4);
		// 通用标志bit11声明文件名/注释使用UTF8，不使用尾随data descriptor。
		local.writeUInt16LE(0x0800, 6);
		// 压缩方法8=Deflate，随后是DOS修改时间和日期。
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(day, 12);
		// 已在内存算出校验、压缩长度、原始长度，可以直接填头而非后补。
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		// 文件名字节跟在固定头后，extra字段长度维持alloc的0。
		local.writeUInt16LE(name.length, 26);

		// 中央目录固定46字节，另跟同一个文件名；未写字段如注释、磁盘号、外部属性保持0。
		const central = Buffer.alloc(46);
		// 中央目录头签名，和本地头不同。
		central.writeUInt32LE(0x02014b50, 0);
		// 制作版本和所需版本都存20，此处未提供Unix文件权限属性。
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		// 与本地头重复标志/方法/时间，供解压器先读中央目录再定位内容。
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(day, 14);
		// 重复CRC32和压缩前后字节数，偏移与本地头布局不同，不能混用写入位置。
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		// 名字长度是16位，文件头相对归档起点偏移是32位；不额外生成ZIP64字段。
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);

		// 文件区按头→名字→数据排列；中央目录单独累计，最后统一放在所有文件区之后。
		files.push(local, name, compressed);
		directory.push(central, name);
		// 下一文件头偏移不计中央目录，只累加本地文件区实际字节。
		offset += local.length + name.length + compressed.length;
	}

	// concat复制成连续中央目录；空条目数组也会形成合法的空目录/结束记录结构。
	const centralDirectory = Buffer.concat(directory);
	// 22字节结束记录，磁盘号与注释长度默认0，即单卷、无归档注释。
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	// 本磁盘条目数和总条目数相等，各占16位。
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	// 中央目录字节长度，以及它在整个归档中的起点（也就是文件区总长度）。
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	// ...展开已有块列表，最终归档一次拼接为Buffer；没有把压缩工作移到异步线程。
	return Buffer.concat([...files, centralDirectory, end]);
}

// 输入目标文件路径与内存条目，先同步构造ZIP，再返回异步writeFile任务；写盘会覆盖目标，不自动建父目录或原子替换。
// 例如bug report调用本函数保存本地zip；构造压缩/字段写入错误会在返回Promise之前同步抛出，文件写入错误则拒绝Promise。
export function writeZipArchive(filePath: string, entries: readonly ZipEntry[]): Promise<void> {
	// 参数求值先执行createZipArchive，再调用writeFile，函数本身没有async包装同步异常。
	return writeFile(filePath, createZipArchive(entries));
}
