// 包装Node文件监听的创建/关闭错误；页脚Git状态和主题热加载使用它，上层自行安排重试与状态清理。
import { type FSWatcher, type WatchListener, watch } from "node:fs";

// 页脚监听失败后重试的毫秒间隔；这个常量本身不会启动计时器，主题调用方也没有自动使用它。
export const FS_WATCH_RETRY_DELAY_MS = 5000;

// 尽力关闭可选监听器，输入watcher或null/undefined，无返回；关闭错误被吞掉，不自动清空调用方字段。
// 例如上层先closeWatcher(this.headWatcher)，再把自己的引用设null，避免重复持有资源。
export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	// 联合类型包含空值，所以先跳过；不是验证不可信对象形状。
	if (!watcher) {
		return;
	}

	try {
		// 释放底层监听句柄，不删除文件或取消上层另外创建的重试计时器。
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

// 创建文件/目录监听，输入路径、变化回调和无参错误回调，返回FSWatcher或创建失败时null。
// 同步创建/注册失败调用onError；成功后异步error也调用onError，不在此自动关闭或重试。
// 例如页脚的onError负责关闭所有相关watcher再安排5秒重试；listener收到rename/change和可能为null的文件名。
// onError是宿主回调而非容错沙箱：若它抛错仍可向外传播，错误对象也不会作为参数传给它。
export function watchWithErrorHandler(
	// 传给fs.watch的文件或目录路径，不自动开启递归监听。
	path: string,
	// 泛型string表示文件名按文字传递，但Node类型仍允许filename=null。
	listener: WatchListener<string>,
	// () => void描述无参数回调，闭包可捕获上层清理/重试状态。
	onError: () => void,
): FSWatcher | null {
	try {
		// 直接创建平台监听器；平台差异、事件合并和丢失并没有被这个包装消除。
		const watcher = watch(path, listener);
		// 消费异步error事件，避免没有监听器时直接成为未处理事件异常。
		watcher.on("error", onError);
		// 返回活跃资源，生命周期由调用方负责。
		return watcher;
	} catch {
		// 创建失败同步通知；此处不保留具体异常，业务只能按失败统一处理。
		onError();
		// 回调正常结束后用null表示没有可用监听器。
		return null;
	}
}
