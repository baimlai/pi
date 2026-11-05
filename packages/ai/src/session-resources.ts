// 会话资源清理回调名册：Codex实现加载时登记WS缓存关闭函数，AgentSession.dispose按会话ID调用；本模块本身不创建/关闭具体socket。
// 回调可接可选sessionId，同步返回void；undefined的具体含义由每个实现决定，TS不会禁止传入返回Promise的函数，但下方不会await它。
export type SessionResourceCleanup = (sessionId?: string) => void;

// 模块级活Set按函数引用去重；保存回调强引用直到手动注销，不按会话ID分组，也不在清理后自动清空。
const sessionResourceCleanups = new Set<SessionResourceCleanup>();

// 登记一个清理函数并返回无参注销闭包；例const off=registerSessionResourceCleanup(fn)，off()后下次不调用fn。
// 只add引用、不立即执行；同一函数登记两次仍只有一项，任一返回的off都能删除它，没有引用计数。
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	// Set.add保存原函数，同引用重复add不新增；不包装成隔离异步任务。
	sessionResourceCleanups.add(cleanup);
	// 返回箭头闭包捕获cleanup，调用时才删除；不是立即注销或自动调用清理。
	return () => {
		// 删除相同函数引用，重复注销无操作；delete的boolean结果没有向外返回。
		sessionResourceCleanups.delete(cleanup);
	};
}

// 同步调用所有当前清理回调，把同一个sessionId原样传入；例两个回调分别关自己的会话缓存。
// 逐个捕获同步throw后继续，最后有错则抛AggregateError；已完成清理不回滚，不await异步返回/拒绝，不自动注销或验证资源真已释放。
// 直接遍历活Set并非快照：回调可增删名册影响本轮后续访问，重入/不断追加也没有专门保护。
export function cleanupSessionResources(sessionId?: string): void {
	// 新建unknown错误数组，保留每个同步抛值原引用，不先String化或要求Error实例。
	const errors: unknown[] = [];
	// 按Set插入顺序调用；运行中删未访问项会跳过，新加入项也可能被本次遍历访问。
	for (const cleanup of sessionResourceCleanups) {
		// 单个回调的同步调用放进try，不把所有回调放一个大try以致首错终止遍历。
		try {
			// 原样传可选ID，无await；回调自己决定清单、同步I/O和错误，void类型不自动捕获Promise拒绝。
			cleanup(sessionId);
			// 只接本次调用栈同步抛出的值，不能接以后微任务才发生的拒绝。
		} catch (error) {
			// 保存错误继续下一项，不把该回调从Set删掉。
			errors.push(error);
		}
	}
	// 所有正常结束的迭代之后，有错误才抛；无错返回undefined，没有总成功对象。
	if (errors.length > 0) {
		// AggregateError.errors保留收集的抛值，message固定；这是报告部分失败，不撤销已经清掉的资源，也没单独请求取消其他回调。
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
