// 给发布/依赖检查等脚本找包目录：递归查package.json，只返回路径，不安装、构建或发布包。
// existsSync查路径是否存在，readdirSync同步读目录并可返回带种类信息的Dirent。
import { existsSync, readdirSync } from "node:fs";
// join按当前操作系统的路径规则拼接，不能当远端路径解析器。
import { join } from "node:path";

// Set保存明确跳过的目录名；这里没有读取.gitignore，也没有跳过所有隐藏目录。
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

/**
 * 返回root及其子目录里带package.json的目录，排序后交给调用者读取清单。
 * 默认root="packages"，不是自动读取根package.json的workspaces字段。
 * 例：packages/a和packages/group/b都有清单，两者都会返回；a里还有子包也继续找。
 * 只读磁盘；不存在/不可读目录会抛错，未验证package.json是正常文件或合法JSON。
 */
export function findPackageDirectories(root = "packages") {
	// 每次调用新建结果数组，不与之前调用共享；本文件是JavaScript，无TS类型声明。
	const packageDirectories = [];

	// 深度优先访问一个目录：先记当前包，再递归真实子目录；闭包直接追加外层数组。
	function visit(directory) {
		// 这里只查名字对应路径是否存在，不读取内容，也不要求它一定是普通文件。
		if (existsSync(join(directory, "package.json"))) {
			// 保存调用时沿途拼出的路径，不另做realpath规范化或包名去重。
			packageDirectories.push(directory);
		}

		// withFileTypes:true返回Dirent，避免为判断种类对每项另做stat。
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			// 文件/软链接不递归；真实目录名为dist或node_modules也跳过，与包是否private无关。
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				// 跳过当前项，仍处理同层后续项。
				continue;
			}
			// 即使当前目录已是包，也继续查它的子目录；没有最大深度或Git忽略过滤。
			visit(join(directory, entry.name));
		}
	}

	// 起点也检查清单；调用时省略或显式传undefined都会采用默认packages。
	visit(root);
	// sort原地按默认字符串顺序排序，不按版本/依赖拓扑；返回这个新结果数组。
	return packageDirectories.sort();
}
