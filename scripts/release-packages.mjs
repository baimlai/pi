// 为检查/打包/发布脚本提供公开包清单投影；本模块本身只读清单，不进行发布。
// 同步读文件；读失败直接抛出，不自动跳过坏清单。
import { readFileSync } from "node:fs";
// 将包目录与package.json拼成当前系统的本地路径。
import { join } from "node:path";
// 复用递归目录枚举，默认从packages开始，包含其嵌套包，不解析根workspaces模式。
import { findPackageDirectories } from "./package-workspaces.mjs";

/**
 * 找包目录→读JSON→排除private严格为true的项→返回directory/name/version。
 * root原样传给目录helper；例如传自建目录可只枚举测试夹具，省略则查packages。
 * 不验证name/version格式，不解析依赖顺序，不安装包；读文件/JSON解析出错会抛出。
 */
export function getPublicWorkspacePackages(root) {
	// helper先给出已排序目录；下面map/filter保持余下项目的相对顺序。
	return findPackageDirectories(root)
		// 箭头函数的({ ... })表示直接返回对象；不是用花括号开启函数体。
		.map((directory) => ({
			// 通常是包目录；后面的清单展开若含同名directory属性会覆盖它，这里没有防护。
			directory,
			// UTF-8文字经JSON.parse成为JS值，再浅展开自有可枚举字段；不做清单schema校验。
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		// 只排除布尔true；字段缺省、false乃至字符串"true"不会被此条件排除。
		.filter((pkg) => pkg.private !== true)
		// 参数解构取三个字段再用属性简写建新对象，丢掉其他元数据；缺字段仍为undefined。
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
