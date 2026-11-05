// 交互模型菜单共享同一个 Runtime 的并发全目录刷新；每个窗口独立停止等待，最后一个等待者离开才通知底层取消。
// 只导入刷新结果类型：总体 aborted 与逐供应商错误表，成功结果不等于每家目录都更新。
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
// 只导入 Runtime 契约，执行刷新的是调用方传入的实例。
import type { ModelRuntime } from "../../core/model-runtime.ts";
// 取消竞争包装只结束等待并观察迟到结果；它不能强制停止任意底层工作。
import { raceWithAbortSignal } from "../../utils/abort.ts";

// Pick 仅保留 ModelRuntime.refresh 方法，因此离线测试可传只实现 refresh 的小对象；不是创建新运行时。
type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

// 一轮共享刷新记录，按 Runtime 对象身份存入 WeakMap。
interface ActiveModelCatalogRefresh {
	// 共享工作自己的控制器，和每个调用方的 signal 分开。
	controller: AbortController;
	// 共享等待 Promise；里面是结果对象，不是模型数组快照。
	promise: Promise<ModelsRefreshResult>;
	// 尚未结束各自等待包装的数量；finally 才递减，不代表底层网络连接数。
	waiters: number;
}

// 协调器只管理并发复用，不实现目录加载/认证/模型请求；相同对象身份才共享。
class ModelCatalogRefreshCoordinator {
	// WeakMap 以 Runtime 为弱键；readonly 只限制字段重赋，仍可 set/delete，不主动给工作加期限。
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	// 复用已有工作或启动一次，再给调用方包独立取消并计数，返回刷新结果 Promise。
	// 例两个菜单同时调用只启动一次；关闭其中一个只拒绝它的等待，另一个仍可完成。已取消信号同步抛出，底层拒绝继续传播；不保证 abort 后底层已停。
	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		// 已取消先同步抛 signal.reason，本方法不是 async，因此这里不是自动转成 Promise 拒绝。
		signal.throwIfAborted();
		// let 允许没有活跃记录时改成新建记录；按对象身份查，不按模型/provider 内容查。
		let active = this.activeByRuntime.get(modelRuntime);
		// 没有共享工作才创建控制器和底层调用。
		if (!active) {
			// 新工作使用独立信号，某个窗口取消不能直接取消其他等待者。
			const controller = new AbortController();
			// ! 是确定赋值断言：下面 Promise finally 运行前会填 created，不是运行时默认值。
			let created!: ActiveModelCatalogRefresh;
			// 启动 Runtime 全量 refresh，只传共享 signal；网络许可采用 Runtime 的默认规则，可重读 models.json/刷新认证快照，不发聊天。
			const operation = modelRuntime.refresh({ signal: controller.signal });
			// 共享 Promise 也和自己的信号竞速；finally 无论成功/失败都清活跃槽，迟到底层结果由 helper 继续观察。
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				// 只清理仍指向本轮 created 的槽，避免旧轮完成误删新的工作。
				if (this.activeByRuntime.get(modelRuntime) === created) {
					// 从 WeakMap 删除本轮记录，下次调用可以重新启动。
					this.activeByRuntime.delete(modelRuntime);
				}
			});
			// 对象简写保存控制器/Promise，初始还没有登记调用方。
			created = { controller, promise, waiters: 0 };
			// 局部 active 指向新记录，后面复用相同计数逻辑。
			active = created;
			// 发布到同一 Runtime 的槽，随后并发调用可取得本轮记录。
			this.activeByRuntime.set(modelRuntime, active);
		}

		// 当前调用加入等待人数，即使它随后被取消也先计入，finally 再减。
		active.waiters++;
		// 以调用方 signal 单独竞争共享结果；不把它直接作为底层信号，返回的是附带计数清理的 Promise。
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			// 成功、失败或取消都会结束这位等待者；finally 不吞掉原结果/拒绝。
			active.waiters--;
			// 仅剩零人且槽仍属于本轮才取消共享信号，已经被清槽的成功工作无需再 abort。
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				// 通知共享取消，并让共享等待可尽快拒绝；Runtime/provider 是否及时停 IO 仍取决于其合作实现。
				active.controller.abort();
			}
		});
	}
}

// 模块内单例让不同菜单调用同一协调表；弱键按 Runtime 分组，不是跨进程刷新锁或结果长期缓存。
const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/** Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent. */
// 公开入口委托协调器，不额外做目录筛选或设置落盘；例同一 Runtime 两次并发调用共享底层，两个不同对象各自刷新。
// 输入最小 refresh 契约和必需信号，返回结果 Promise；已经取消可同步抛出，其余底层/清理异常会按调用路径传播。
export function refreshModelCatalogs(
	// 只要求 refresh 方法，保留原 Runtime 对象身份作为键。
	modelRuntime: ModelCatalogRuntime,
	// 这一调用方的取消信号，没有可省略默认值或自动超时。
	signal: AbortSignal,
	// Promise 泛型说明成功值结构；类型不保证它一定成功。
): Promise<ModelsRefreshResult> {
	// 原样返回协调器的等待，不复制结果或改 aborted。
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}
