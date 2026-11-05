// 用临时包清单运行真实固定版本检查器，覆盖范围拒绝/固定版本与非registry放行/npm别名；仅在自建目录写夹具清单，并以该目录为cwd运行仓库真实检查器。
// strict版assert让equal使用严格相等语义，和==式宽松比较区别开。
import assert from "node:assert/strict";
// 同步启动受控Node子进程运行真实检查脚本，测试不执行npm install或下载依赖。
import { spawnSync } from "node:child_process";
// 只创建/清理测试自己的临时目录和package.json，不修改真实仓库清单。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
// tmpdir取系统临时根，具体每例由mkdtemp加随机后缀隔离。
import { tmpdir } from "node:os";
// join组合跨平台文件路径。
import { join } from "node:path";
// 把相对本测试模块的URL转本机路径，避免子进程切cwd后找不到脚本。
import { fileURLToPath } from "node:url";
// Node内置测试登记函数，不是Vitest的it，也不在导入它时自动执行产品脚本。
import test from "node:test";

// 用import.meta.url定位同目录的检查器；取得路径不等于在当前测试进程直接执行检查器顶层。
const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

// 夹具：创建临时目录→登记清理→写传入清单→在该目录启动真实检查器，返回进程结果。例范围^1.2.0应返回status1；无联网/安装副作用，读取/写入失败会拒绝当前测试。
async function check(t, manifest) {
	// 每次调用独立mkdtemp，prefix只是前缀，真正根路径由系统生成。
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-deps-"));
	// t.after接异步清理函数，测试结束时等其Promise完成；recursive/force仅作用于自己创建的root。
	t.after(() => rm(root, { recursive: true, force: true }));
	// 把对象序列化成临时package.json，检查器会实际读它，不替换内部版本判断实现。
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	// process.execPath使用同一Node，参数用数组不经shell；cwd隔离扫描范围，encoding使stdout/stderr为字符串，返回含status/error等结果对象。
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #10865: internal workspace dependencies must not allow incompatible newer releases.
// 回归用例：内外包各类版本范围都应失败，三段依赖区都要检查。async回调先await夹具，之后断言退出码和每条诊断，不只凭标题猜成功。
test("rejects internal and external registry dependency ranges in every direct dependency section", async (t) => {
	// 构造一份仅含测试依赖的清单，不要求真实包存在，因为检查器只分析版本文字。
	const result = await check(t, {
		// 运行依赖段中的三条分别检查作用域内部包和普通外部包。
		dependencies: {
			// ^1.2.0代表范围，不是固定1.2.0，内部包也应拒绝。
			"@earendil-works/pi-codemode": "^1.2.0",
			// ~1.2.0同样是范围，不能因为名字是工作区包就放行注册表范围。
			"@earendil-works/chord": "~1.2.0",
			// 普通外部包的^1.0.0也必须拒绝。
			external: "^1.0.0",
		},
		// 开发依赖的1.x不是固定补丁版本，仍属于检查范围。
		devDependencies: { "@earendil-works/pi-ai": "1.x" },
		// 可选依赖的*也不固定版本，本例并非通过“可选”免检。
		optionalDependencies: { "@earendil-works/pi-tui": "*" },
	});
	// 断言退出码严格为数字1；仍需下面的诊断检查，单凭1不能排除别的启动失败。
	assert.equal(result.status, 1);
	// 下面数组列出全部应有的诊断字段路径，for...of逐条核对，确保不只报其中一段。
	for (const dependency of [
		// 应报第一条内部运行依赖。
		"dependencies.@earendil-works/pi-codemode",
		// 应报第二条内部运行依赖。
		"dependencies.@earendil-works/chord",
		// 应报外部运行依赖。
		"dependencies.external",
		// 也要报开发依赖。
		"devDependencies.@earendil-works/pi-ai",
		// 还要报可选依赖。
		"optionalDependencies.@earendil-works/pi-tui",
	]) {
		// includes只要求stderr含这段文字，不比较全部输出或顺序；第二参数是断言失败时显示的原stderr。
		assert.ok(result.stderr.includes(`${dependency} must be pinned`), result.stderr);
	}
});

// 通过用例：固定内外版本/固定npm别名与非registry协议应被接受；它验证脚本允许这些文字，不验证依赖真实可安装。
test("accepts exact internal and external versions, exact registry aliases, and non-registry specifiers", async (t) => {
	// 夹具按此清单运行真实检查器，不修改根package.json。
	const result = await check(t, {
		// 下面都属于dependencies字段。
		dependencies: {
			// 内部包固定到1.2.0可通过。
			"@earendil-works/pi-codemode": "1.2.0",
			// 另一内部包也固定，说明内部包没有特殊版本范围例外。
			"@earendil-works/chord": "1.2.0",
			// 普通外部包固定1.0.0可通过。
			external: "1.0.0",
			// npm别名提取最后@后的1.1.0检查，作用域开头@不能被当作版本分隔符。
			alias: "npm:@earendil-works/pi-ai@1.1.0",
			// file前缀按非registry路径跳过，测试不会真的读取../local的包内容。
			local: "file:../local",
			// workspace:*也按明确非registry前缀跳过，不据*本身判为注册表范围。
			workspace: "workspace:*",
		},
		// 开发依赖固定版本照常通过。
		devDependencies: { "@earendil-works/pi-ai": "1.2.0" },
		// 固定预发布后缀rc.1在版本正则允许范围，和~或^不同。
		optionalDependencies: { "@earendil-works/pi-tui": "1.2.0-rc.1" },
	});
	// 退出码必须为0；stderr仅在失败时作为断言信息，不另断言其一定为空或没有其他输出。
	assert.equal(result.status, 0, result.stderr);
});

// 别名反例：npm目标后面是^范围也要失败，防只看到npm:前缀就整条放过；实际执行与前面共享同一夹具。
test("rejects registry alias ranges", async (t) => {
	// 传单条依赖，便于把错误定位到alias而非其他包。
	const result = await check(t, {
		// 内部目标包名固定，但版本部分^1.2.0不固定，不应通过。
		dependencies: { alias: "npm:@earendil-works/pi-ai@^1.2.0" },
	});
	// 先检查退出码1，再用下条诊断定位alias，不能单凭退出码证明失败原因。
	assert.equal(result.status, 1);
	// 正则中的\.匹配字面量点，确认诊断指出dependencies.alias；并未要求完整stderr文本精确相等。
	assert.match(result.stderr, /dependencies\.alias must be pinned/);
});
