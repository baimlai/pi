// 让测试越过当前同步栈和微任务，等待一次零延时定时器后完成Promise<void>；无参数，无结果值。
// 例先修改队列再await waitForTick()给异步工作推进机会；它不保证所有后台工作都完成，也不承诺精确等待0毫秒。
export function waitForTick(): Promise<void> {
	// Promise执行器立即安排setTimeout，定时器到期调用resolve；Node把小于1的延时按1毫秒处理，调度还可能更晚，不是阻塞线程sleep。
	return new Promise((resolve) => setTimeout(resolve, 0));
}
