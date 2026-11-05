// 为Windows npm自更新把本进程已加载的原生库移到隔离位置，再复制回原路径，缓解锁定旧文件对替换安装的影响。
// 调用方在Windows启动/自更新路径上调用；本文件函数自身不检查平台，不执行npm更新，也不卸载已加载库。只做路径筛选和同步文件操作。
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { getCwdRelativePath } from "./paths.ts";

const QUARANTINE_DIR_NAME = ".pi-native-quarantine";

// 输入路径，先按当前cwd解析为绝对路径，再转平台命名空间形式返回，无文件I/O；例如Windows可能得到\\?\前缀。
// 不做realpath，不保证符号链接指向同一物理文件，大小写归一由后续比较时另行处理。
function normalizePath(path: string): string {
	return toNamespacedPath(resolve(path));
}

// 输入包目录，从其自身向父级找最近一个名字为node_modules的目录，返回其隔离子目录，未找到undefined。
// 例如.../node_modules/@scope/pi返回.../node_modules/.pi-native-quarantine；只按词法名字找，不确认目录存在或确属npm安装。
function getQuarantineRoot(packageDir: string): string | undefined {
	// resolve折叠./..得到绝对起点；while逐级上走，根目录parent===current时结束。
	let current = resolve(packageDir);
	while (true) {
		// 目录名比较转小写，Node路径API仍按当前宿主平台处理，不强行按win32解析任意平台字符串。
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, QUARANTINE_DIR_NAME);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		// 循环更新当前路径，而非函数递归；每轮都更靠近文件系统根。
		current = parent;
	}
}

// 输入包目录，从当前进程诊断报告中筛出词法上位于包内的已加载sharedObjects路径，去重后返回；不是递归扫描node_modules。
// 例如报告含包内addon.node和包外系统库，只保留前者；只证明报告列出且路径在范围内，不按后缀判断，也不解析符号链接/卸载库。
// getReport或路径处理错误仍会抛出，返回数组不保证文件此刻还存在，移动前由调用者再检查。
function getLoadedSharedObjectsInPackageDir(packageDir: string): string[] {
	// 诊断报告是外部结构边界，as声明只取sharedObjects未知值，不自动验证它确实是数组。
	const sharedObjects = (process.report.getReport() as { sharedObjects?: unknown }).sharedObjects;
	if (!Array.isArray(sharedObjects)) {
		return [];
	}

	// 为Windows大小写不敏感比较统一小写，保留输出文件路径的原始大小写/命名空间形式。
	const root = normalizePath(packageDir).toLowerCase();
	const seen = new Set<string>();
	const loadedFiles: string[] = [];
	for (const value of sharedObjects) {
		// 报告数组元素不完全信任，非字符串项跳过，不转换为路径。
		if (typeof value !== "string") {
			continue;
		}
		const filePath = normalizePath(value);
		const comparisonPath = filePath.toLowerCase();
		// 共享路径helper按relative做词法目录边界检查，排除兄弟前缀；seen避免大小写不同的同一路径重复处理。
		if (getCwdRelativePath(comparisonPath, root) === undefined || seen.has(comparisonPath)) {
			continue;
		}
		// 比较用小写键，实际操作仍返回filePath，不在此exists/read文件。
		seen.add(comparisonPath);
		loadedFiles.push(filePath);
	}
	return loadedFiles;
}

// 输入包目录，找到同一最近node_modules下的共享隔离根并递归尽力删除，无返回；未找到或删除失败都安静结束。
// 例如下次启动清理旧进程留下的库；会删除整个隔离根而不只某次运行目录，没有锁/保留时长，文件仍被旧进程占用时可能删不掉。
export function cleanupWindowsSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	try {
		// force允许路径不存在，recursive删除后代；此处catch也吞掉权限/占用等其他删除错误。
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// A previous pi process may still be exiting and holding a native addon.
	}
}

// 输入包目录，筛出当前进程已加载的包内库，逐个移到本次隔离目录再复制回原位置，无返回值；没有可处理项就不创建目录。
// 例如addon.node旧实体被rename到隔离处后，copyFile在原路径创建内容副本供后续npm替换；不会把进程映射自动切到新副本。
// 操作是同步且非事务的：mkdir/rename/copy任一步失败直接抛，前面已移动的文件不回滚；rename成功后copy失败可导致原路径暂缺。
export function quarantineWindowsNativeDependencies(packageDir: string): void {
	const resolvedPackageDir = normalizePath(packageDir);
	const quarantineRoot = getQuarantineRoot(resolvedPackageDir);
	if (!quarantineRoot) {
		return;
	}

	// 获取列表时可能产生诊断报告/路径异常，本函数未catch；没有node_modules根时不会运行这一步。
	const loadedFiles = getLoadedSharedObjectsInPackageDir(resolvedPackageDir);
	if (loadedFiles.length === 0) {
		return;
	}

	// 每次运行用时间、进程号、UUID分组，降低名称冲突；不提供跨进程互斥或排他创建保证。
	const quarantineRunDir = join(quarantineRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
	for (const loadedFile of loadedFiles) {
		// 报告生成后文件可能已不存在，检查只跳过当前缺失；检查后仍可能变化。
		if (!existsSync(loadedFile)) {
			continue;
		}
		// 保留该库相对包根的子路径，避免不同目录同名库在本次隔离目录里冲突。
		const quarantinePath = join(quarantineRunDir, relative(resolvedPackageDir, loadedFile));
		// 创建库的隔离父目录，随后先移动旧实体、再复制回；这两次文件操作不是一个原子动作。
		mkdirSync(dirname(quarantinePath), { recursive: true });
		renameSync(loadedFile, quarantinePath);
		copyFileSync(quarantinePath, loadedFile);
	}
}
