// Chord v1 的进程内通知队列：先入队的通知先送达，防止通知中的再次写入打乱观察顺序。
// One FIFO queue for every observer notification (state events, shape pushes, registry tables, listener
// invocations).
//
// Problem: notifying observers synchronously from inside a write lets a re-entrant write overtake the write being
// published. Example: subscriber A reacts to n = 1 by writing n = 2; subscriber B then sees 2 before 1.
// Solution: a publication first adopts every revision it makes (cells and derivations), then enqueues its
// notifications. Notifications run in enqueue order, so every observer sees revisions in adoption order.
// `holdPublications` defers delivery until a multi-step change (a reload commit) is complete.
//
// 所属包与模块：packages/chord/src/old/publish.ts，Chord v1 的进程内发布队列，被 cell.ts、object.ts、host.ts、
// reload.ts 共同使用；它不理解状态、注册表或重载，只保证回调的执行顺序。
//
// 职责边界：排序与暂停，仅此而已。发送是同步的，发生在最后一次 enqueue 或 holdPublications 退出的调用栈上；
// 不捕获回调异常（任务必须自行通过 onError/report 报告），不做异步调度、不持久化、不跨进程。
// 队列是模块级单例，因此同进程内所有 host 和对象共享同一条观察顺序。
//
// 上游入口：cell.ts 在状态修订被采纳后 enqueue 状态通知；object.ts enqueue 形状/状态/监听者通知；
// host.ts 的 installTables enqueue 注册表变化；reload.ts 用 holdPublications 包住提交阶段的多步安装。
// 下游：观察者回调（状态订阅、注册表监听、listener 调用）在队列中同步执行；回调里的再次写入会排到队尾。
//
// 能力清单：
// - enqueue(task)：把 task 追加到队尾，并在允许时立即同步 drain；无返回值。
// - holdPublications(fn)：同步暂停发送，执行 fn 并返回其返回值；退出时恢复并按序发送，支持嵌套。
// - drain()（内部）：在非暂停、非重入时逐条执行队头任务；任务抛错会中断本轮并复位标志，
//   剩余任务留在队列里，等下一次 enqueue 再继续。
//
// 典型调用顺序：一次写入采纳所有修订 -> enqueue 若干通知 -> drain 同步按序执行；重载提交这种多步变更则先用
// holdPublications 包住整段安装，退出后统一发送，避免观察者看到中间态。
//
// 示例（真实签名）：
//   holdPublications(() => {
//     enqueue(() => console.log("a"));
//     enqueue(() => console.log("b"));
//   });                     // fn 返回后依次打印 a、b；期间不会发送
//
// 建议阅读顺序：先看模块级 queue/held/draining，再看 enqueue 与 drain 的配合，最后看 holdPublications 的
// 嵌套与异常处理（finally 中恢复发送）。

// (() => void)[] 是无参数、无返回值函数的数组；队列由本进程所有使用此模块的对象共用。
const queue: (() => void)[] = [];
// held 统计嵌套暂停层数；draining 防止某条通知触发 enqueue 时递归启动第二次遍历。
let held = 0;
let draining = false;

/** Runs `task` after everything enqueued before it. Tasks must not throw (report instead). */
/**
 * 把通知 task 放到末尾，再尝试同步发送；无返回值，会改模块队列并可能立即调用观察者。
 * 暂停期间只排队。例如 A 的通知中再 enqueue(B)，B 会等此前已有通知结束后执行。task 必须自行报告错误而非抛出。
 */
export function enqueue(task: () => void): void {
	// push 添加到尾部；drain 从头部取，形成先入先出的顺序。
	queue.push(task);
	// 当前正在发送或处于暂停区时 drain 会直接返回，留下任务供外层发送。
	drain();
}

/** Delivers nothing until `fn` returns, then everything it enqueued, in order. */
/**
 * 在同步函数 fn 执行期间暂停通知，返回 fn 的结果 T；退出时恢复发送，fn 抛错也会经过 finally。
 * 可嵌套，最外层结束才发送。例如一次热重载中替换多个状态后统一通知。这里不等待 fn 返回的 Promise，不能作为异步事务。
 */
export function holdPublications<T>(fn: () => T): T {
	// 进入一层暂停；嵌套调用不会过早恢复。
	held++;
	try {
		// 保留回调的原始返回值；回调异常继续向外传播。
		return fn();
	} finally {
		// 无论回调成功还是失败都退出本层；只有 held 为零时 drain 才实际工作。
		held--;
		drain();
	}
}

/**
 * 在没有暂停、没有其他发送循环时，逐条同步执行队头通知；无参数和返回值。
 * 发送中的新通知也追加到同一队列。例如 A 追加 C、原队列还有 B，执行顺序为 A、B、C。
 * 不捕获任务异常；finally 只复位发送标志，因此入队者必须遵守 task 不抛错的约定。
 */
function drain(): void {
	// 重入时交给现有循环；暂停时交给最外层 holdPublications 的 finally。
	if (draining || held > 0) return;
	// 在执行任何回调前标记，防止回调同步重入。
	draining = true;
	try {
		// shift 取走最早任务；取到 undefined 表示空队列，每轮执行后再取下一条。
		for (let task = queue.shift(); task !== undefined; task = queue.shift()) task();
	} finally {
		// 即使任务违约抛错，也允许之后的 enqueue 再次尝试处理剩余通知。
		draining = false;
	}
}
