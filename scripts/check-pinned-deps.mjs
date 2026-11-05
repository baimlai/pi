// 检查当前目录树内直接注册表依赖是否写固定版本，供npm run check使用；只读清单/报错退出，不安装包、不联网，也不自动改版本。
// 同步目录读取返回Dirent，读文件用于解析package.json；一次性检查命令按顺序收集数据后退出。
import { readdirSync, readFileSync } from "node:fs";
// join组合当前扫描目录与子项，避免手写平台分隔符。
import { join } from "node:path";

// 只检查这三个直接依赖区；peerDependencies、overrides和锁文件不在本脚本的循环内。
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
// 要求主.次.补丁三段数字，拒^/~/*等范围，允许可选预发布/构建后缀；只是此正则的版本外形检查，不是完整SemVer解析器。
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// 任何层级遇到这些同名目录就不深入；不读取.gitignore来决定扫描范围。
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
// 收集package.json路径的可变数组，每次启动脚本重新创建，const限制重赋而不是push。
const packageJsonFiles = [];

// 递归收集directory下的普通package.json，结果push到外层数组而不返回列表。例从.找到packages/ai/package.json；读目录失败直接抛，没有忽略权限错误或并发扫描。
function collectPackageJsonFiles(directory) {
	// withFileTypes得到Dirent对象，for...of依次走子项，不为每个条目单独lstat。
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		// 只有Dirent判断为真实目录才递归，目录符号链接不会因此被跟随。
		if (entry.isDirectory()) {
			// Set.has按目录名字精确判断，忽略目录内不会继续找嵌套包。
			if (!ignoredDirectories.has(entry.name)) {
				// 递归下一层路径；没有深度限制，依赖仓库目录结构本身有限。
				collectPackageJsonFiles(join(directory, entry.name));
			}
			// 目录处理完直接看下一项，避免再进入普通文件分支。
			continue;
		}

		// 只接受普通文件且名字严格package.json，其他JSON/符号链接不收集。
		if (entry.isFile() && entry.name === "package.json") {
			// 存路径文字，尚未读取或解析文件内容。
			packageJsonFiles.push(join(directory, entry.name));
		}
	}
}

// 按若干明确前缀识别不走直接npm注册表版本校验的依赖，例file:../x或workspace:*会跳过；返回布尔值，不访问URL，也不证明该说明符有效或可信。
function isNonRegistrySpecifier(specifier) {
	// ^锚定开头、非捕获分组列出协议，test返回boolean；未列出的格式仍会走后面的固定版本检查。
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

// 从npm别名提取真正的版本串，普通版本原样返回。例npm:@scope/pkg@1.2.3得到1.2.3；不解析整个包名、也不查询注册表，无IO。
function getVersionSpecifier(specifier) {
	// 非npm:开头提前返回，不改变输入字符串。
	if (!specifier.startsWith("npm:")) return specifier;
	// slice去掉固定前缀，得到别名目标文字，不修改原字符串。
	const aliasTarget = specifier.slice("npm:".length);
	// 取最后一个@以避开作用域开头的@；找不到返回-1。
	const versionSeparator = aliasTarget.lastIndexOf("@");
	// 分隔符不在有效位置时返回原说明符，让后续正则拒绝，不猜一个默认版本。
	if (versionSeparator <= 0) return specifier;
	// 从分隔符后一位取后缀，空后缀随后也无法通过版本正则。
	return aliasTarget.slice(versionSeparator + 1);
}

// 错误汇总数组，先收全再输出，不遇第一个范围就结束扫描。
const failures = [];

// 扫描调用者当前目录.，不是自动以本脚本所在目录为根；测试会切到自己的临时目录运行它。
collectPackageJsonFiles(".");

// sort原地按字符串默认顺序排文件路径，便于稳定显示诊断；for...of随后逐个读文件。
for (const file of packageJsonFiles.sort()) {
	// UTF-8读取后JSON.parse，坏JSON/读取失败会直接抛，不包装成下面的版本诊断。
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	// 逐个依赖区检查，数组项是字段名字符串而不是依赖包本身。
	for (const section of dependencySections) {
		// 动态属性索引取这一段依赖字典；这里是JS，依赖仓库package.json的既定结构，没有TS自动运行校验。
		const dependencies = packageJson[section];
		// 段缺省/假值则跳过；非空错误形状仍可能在后续Object.entries或字符串操作失败。
		if (!dependencies) continue;

		// Object.entries取自有可枚举条目，解构得到包名和说明符；不遍历传递依赖。
		for (const [name, specifier] of Object.entries(dependencies)) {
			// 已识别的非注册表前缀不强制形如1.2.3，判断命中就continue到下个包。
			if (isNonRegistrySpecifier(specifier)) continue;
			// npm别名先取末段版本，再检查精确外形；通过就不记录错误。
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			// 模板文字带文件/依赖区/包名/原说明符，便于定位；只是记录，不改package.json或锁文件。
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}
}

// 有任何违规才输出并用非零退出，成功路径无额外console消息。
if (failures.length > 0) {
	// 先写通用错误标题到stderr。
	console.error("Direct registry dependencies must use exact versions:");
	// 逐条输出带缩进的详细诊断，不静默修复依赖版本。
	for (const failure of failures) console.error(`  ${failure}`);
	// process.exit(1)立即失败退出，调用npm run check时会阻止后续&&命令继续。
	process.exit(1);
}
