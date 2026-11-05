// 私有线程原生fixture的CommonJS驱动：由native-clipboard-linux.test.ts传.node路径和模式，真实加载受控addon，断言并发/进程退出/Worker退出与清理。
// 它会创建Node Worker、读取本脚本文件、调用真实原生线程；受控reader不走X11，但此脚本不是无副作用的纯字符串测试。require是CommonJS加载调用，.cjs不使用TS类型注解。
// 引入严格断言，失败抛Error，外层catch记录并令进程失败。
const assert = require("node:assert/strict");
// 取事件once的Promise辅助，等待指定Worker消息，而非注册回调后立即完成。
const { once } = require("node:events");
// 取异步读文件，用一次真实文件I/O检验libuv池未被额外长期等待占满。
const { readFile } = require("node:fs/promises");
// 解构时把timers/promises的setTimeout改名delay，返回可await的Promise，不是传统回调定时器句柄。
const { setTimeout: delay } = require("node:timers/promises");
// 读取主/子Worker身份、父端口、Worker构造器和传入数据；新线程中workerData承接addon路径。
const { isMainThread, parentPort, Worker, workerData } = require("node:worker_threads");

// 轮询同步predicate直到为真，返回Promise<void>；谓词为假才核约5秒deadline并await10ms，例等state到1,0,0，已为真时不再核是否过期。
// predicate本身抛错或超时断言会使Promise拒绝；不是精确5秒强制中断，阻塞谓词/事件循环会延后检查。
async function waitFor(predicate) {
	// 在调用开始时固定单调毫秒截止，不每轮重新延5秒。
	const deadline = performance.now() + 5000;
	// 立即调用predicate，false才进入轮询体；成功时不再额外睡一次。
	while (!predicate()) {
		// 断言仍在截止前，失败抛错而非返回false。
		assert.ok(performance.now() < deadline, "Timed out waiting for the private reader");
		// 异步等约10ms后再重试，释放JS执行权，不是同步阻塞线程睡眠。
		await delay(10);
	}
}

// 定义并立即调用async箭头主流程，返回Promise由末尾catch处理；主/子Worker都从这里按身份分支，不自动等待所有被void丢弃的Promise。
(async () => {
	// 子Worker走此分支，主线程跳过。
	if (!isMainThread) {
		// 按workerData路径真实require原生addon，会执行模块注册；不是读取文件内容当JSON。
		const helper = require(workerData);
		// 启动getText并有意不await，让受控reader在后台阻塞；void只丢返回值，不会取消任务或吞它将来的拒绝。
		void helper.getText();
		// 轮询reads字段是否以1,开头，确认第一个reader已进入；没有仅凭启动Promise就宣布线程在读。
		await waitFor(() => helper.state().startsWith("1,"));
		// 向父线程发reading消息，parentPort由实际子Worker宿主提供；这不是把原生任务数据传给父线程。
		parentPort.postMessage("reading");
		// 结束子Worker这段async流程，未release或await后台getText；是否退出由后续宿主终止/任务句柄决定。
		return;
	}
	// 主线程从argv去掉node与脚本路径，解构addon路径和模式；未做独立参数schema校验。
	const [addon, mode] = process.argv.slice(2);
	// 精确worker-exit模式测试来源Node环境销毁后，原生私有读取仍可被另一个环境观察/收尾。
	if (mode === "worker-exit") {
		// The originating environment unloads while its private callback still waits.
		// 创建真实Node Worker重跑本脚本，workerData给addon路径；未创建操作系统子进程来复制一份独立静态状态。
		const worker = new Worker(__filename, { workerData: addon });
		// 等待首个message事件，未另断言消息文本，Worker error可使once拒绝；无消息也没有此行独立超时。
		await once(worker, "message");
		// 请求停止子Worker的JS执行并await其exit完成；不等同强杀addon额外创建的私有pthread。
		await worker.terminate();
		// 主线程再次加载同一原生库，依靠模块中的静态状态观察尚在进行的私有读取。
		const helper = require(addon);
		// 断言读1次、仍有1个跟踪块、busy为1；这是特定时序观测，不是统计所有Node进程内存。
		assert.equal(helper.state(), "1,1,1", "The detached operation survives environment teardown");
		// 主线程调用测试release，原子放行仍活着的受控reader。
		helper.release();
		// 等读取结果迟到释放且busy清零：读取次数仍1，活动块数0。
		await waitFor(() => helper.state() === "1,0,0");
		// release标志已保持true，新getText可成功返回text，断言环境退出后还能再次读取。
		assert.equal(await helper.getText(), "text");
		// 输出固定passed给外层测试比对，不在模块加载时打印。
		console.log("passed");
		// worker-exit分支结束，不进入下面并发压力步骤。
		return;
	}
	// 其余模式在主线程真实加载同一addon。
	const helper = require(addon);
	// 记录整个首次读取的起始毫秒，供后面4.5秒容差断言。
	const started = performance.now();
	// 启动首个getText，保存Promise，受控reader在未release前不会自行完成。
	const pending = helper.getText();
	// 等C侧reads到1，确保随后的并发操作发生在首个私有读取已占用门禁时。
	await waitFor(() => helper.state().startsWith("1,"));
	// process-exit模式专门不放行私有线程，测试外层Node进程是否仍可自然结束。
	if (mode === "process-exit") {
		// await首次N-API工作有限等待结束，预期undefined表示暂不可用，不是私有线程已经终止。
		assert.equal(await pending, undefined);
		// 先打印passed；是否最终按时自然退出仍由外层exec的10秒超时检验，不只看这一行。
		console.log("passed");
		// 从async主流程return而非process.exit，故意留私有reader没完成，让真实事件循环退出语义接受测试。
		return; // The private callback never finishes; Node must still exit naturally.
	}
	// 记录20个并发尝试和文件I/O阶段的起始时刻。
	const concurrentStarted = performance.now();
	// Array.from建20项并立即交替调用getImage/getText（偶数image、奇数text），保存20个Promise；方法名是方括号动态索引。
	const concurrent = Array.from({ length: 20 }, (_, index) => helper[index % 2 ? "getText" : "getImage"]());
	// With UV_THREADPOOL_SIZE=2, a second blocked native task would delay this read.
	// 真实异步读当前CJS文件；外层把UV_THREADPOOL_SIZE设2，若第二个libuv线程也长期等原生读取，这次I/O会被拖住。
	await readFile(__filename);
	// 等待20个请求均兑现并逐项等于undefined，说明忙时没有再启动长期私有读取；不是它们都返回了文本。
	assert.deepEqual(await Promise.all(concurrent), Array(20).fill(undefined));
	// 断言这一阶段少于1500ms，作为特定负载回归阈值，不是对所有机器/I/O调度的实时性能保证。
	assert.ok(performance.now() - concurrentStarted < 1500, "Concurrent reads and filesystem I/O must remain available");
	// 首次请求最终也应因有界等待返回undefined，reader仍未被release。
	assert.equal(await pending, undefined);
	// 按从started以来总时长断言小于4500ms，留给约3秒等待调度余量，不证明截止严格精确。
	assert.ok(performance.now() - started < 4500, "The shared worker must leave its bounded wait");
	// 此时只读1次、只剩1个数据块、busy仍1，表明原reader继续活着但原任务已收尾。
	assert.equal(helper.state(), "1,1,1", "Only one private reader may remain blocked");
	// 再请求图片也应暂不可用，不能绕过同一读取门禁启动另一reader。
	assert.equal(await helper.getImage(), undefined);
	// 再次核计数/门禁未变，补充上条仅看返回值的证明。
	assert.equal(helper.state(), "1,1,1", "Another request must not start another private reader");
	// 最后放行受控reader；之后released一直true。
	helper.release();
	// 等迟到数据被释放且门禁恢复空闲，不把调用release本身当已经收尾。
	await waitFor(() => helper.state() === "1,0,0");
	// 恢复后新文本读取返回text，读取次数增到2。
	assert.equal(await helper.getText(), "text");
	// 再读图片预期Buffer等于text的UTF-8字节，只验证桥接字节类型/内容，不验证真实图片解码。
	assert.deepEqual(await helper.getImage(), Buffer.from("text"));
	// 最终3次实际读取、0块未释放、busy0；只覆盖本fixture跟踪的分配，不是证明所有库无泄漏。
	assert.equal(helper.state(), "3,0,0", "Late and successful results must all be freed");
	// 并发模式全部断言通过后打印passed。
	console.log("passed");
// 主async Promise的拒绝在这里统一处理；已丢弃的独立Promise并不自动归到这个catch。
})().catch((error) => {
	// 把错误写标准错误，外层测试可随非零状态诊断。
	console.error(error);
	// 设置自然退出码1，不强制立刻process.exit，也不在错误分支保证release原生reader。
	process.exitCode = 1;
});
