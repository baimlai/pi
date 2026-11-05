// 原生剪贴板读取子进程的JSON报告器：外层传addon路径和getText/getImage方法名，真实调用后输出短值/长度/hash，并用timer和/proc检查有限的响应性/子进程清理迹象。
// 会require原生库并读取其所连DISPLAY的剪贴板，还同步读Linux /proc；只应由隔离X11测试驱动，不能当可直接运行的纯单元测试。
// CommonJS解构require取得SHA-256构造器，之后只hash读到的字节，不保存图片文件。
const { createHash } = require("node:crypto");
// 引入严格断言，instanceof和finally检查失败都可抛错。
const assert = require("node:assert/strict");
// 引入同步文件读取，最后检查Linux当前主任务的children文件。
const { readFileSync } = require("node:fs");

// 立即调用async主流程并在末尾处理未捕获拒绝；try内的读取错误会输出ok:false，但finally失败仍可让整个进程失败。
(async () => {
// 本次心跳计数初始0。
let ticks = 0;
// 每约10ms递增ticks，提供事件循环有机会运行的迹象；interval不是准确每10ms执行一次的时钟。
const timer = setInterval(() => ticks++, 10);
// 记录调用前单调毫秒起点，包含后面require/读取/日志时间。
const started = performance.now();
// try覆盖真实加载/调用/await和成功报告，之后无论成功或失败都执行finally。
try {
	// 按受控argv路径加载.node，可能同步抛错；不是对任意用户输入路径的安全加载器。
	const helper = require(process.argv[2]);
	// 以argv方法名索引并调用真实接口，未验证方法名白名单或返回形状。
	const pending = helper[process.argv[3]]();
	// 要求返回值是当前realm可识别的Promise，缺能力直接返回undefined等同步结果会触发失败；不等同只检查then方法。
	assert.ok(pending instanceof Promise, "Native reads must return promises");
	// await读取兑现结果或把拒绝交当前catch，JS线程应能在等待期间处理timer。
	const value = await pending;
	// 只为字符串/Node Buffer建字节副本，字符串按UTF-8；其他值含null/undefined或非Buffer Uint8Array不在此生成hash字节。
	const bytes = typeof value === "string" || Buffer.isBuffer(value) ? Buffer.from(value) : undefined;
	// 把下面报告对象JSON序列化并写stdout，undefined属性会被省略；输出成功不保证后面的finally检查也通过。
	console.log(JSON.stringify({
		// ok:true只表示上述读取/报告路径正常走到这里，尚未验证所有返回类型或清理。
		ok: true,
		// 只原样报告null或不超过100个UTF-16码元的字符串；长文本和Buffer省略value，但仍可通过长度/hash核内容。
		value: value === null || (typeof value === "string" && value.length <= 100) ? value : undefined,
		// 恰好undefined时写unavailable:true；其他结果用false||undefined得到undefined，JSON中不写false字段。
		unavailable: value === undefined || undefined,
		// 可缺bytes用?.取长度，0仍被保留为0，不因假值被省略。
		length: bytes?.length,
		// bytes存在就计算完整SHA-256十六进制；空Buffer也是真值，会得到空内容hash，没字节副本才省略。
		hash: bytes && createHash("sha256").update(bytes).digest("hex"),
	}));
// 捕获try中的加载、断言、读取拒绝或JSON输出等错误，未覆盖finally内部抛错。
} catch (error) {
	// 把String(error)写成ok:false JSON到stdout；字符串化本身若抛错会继续向外拒绝，没有另层脱敏。
	console.log(JSON.stringify({ ok: false, error: String(error) }));
// 无论try成功或catch正常输出都执行收尾检查；收尾抛错会传播到最外catch。
} finally {
	// 先取消心跳interval，避免报告完后它单独让Node进程一直存活。
	clearInterval(timer);
	// 整个步骤耗时超过200ms才要求ticks>5，即至少6次心跳；这是特定测试启发式，不证明所有时间段从未阻塞或延迟有统一上界。
	if (performance.now() - started > 200) assert.ok(ticks > 5, "Clipboard I/O must not block the JS event loop");
	// Check before Node exits: process exit must not hide a leaked child or zombie.
	// 同步读/proc/self/task/主线程TID/children并断言trim后空；只看该Linux任务列出的子进程，不把私有pthread当子进程，也不是全系统泄漏扫描。
	assert.equal(readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim(), "");
}

// 主流程仍有错误则写stderr并设退出码1；不强制process.exit，stdout即使已出现ok:true也不能据此忽略失败退出码。
})().catch((error) => { console.error(error); process.exitCode = 1; });
