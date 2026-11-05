// 给宿主与扩展提供按字符串频道广播的进程内事件总线；它与 runner 的特定生命周期事件聚合规则不同。
// Node EventEmitter 同步调用监听包装器；包装器中的异步处理不会被 emit 等待。
import { EventEmitter } from "node:events";

// 扩展可见的公共契约；unknown 要求订阅者自行解释频道数据，本总线不做 schema 校验。
export interface EventBus {
	// 发送数据，返回 void；不能 await 它来等待全部异步处理器完成。
	emit(channel: string, data: unknown): void;
	// 订阅返回一个无参数取消函数；handler 的静态返回值为 void，但 JS 实际返回的 Promise 也会被包装器等待/捕获。
	on(channel: string, handler: (data: unknown) => void): () => void;
}

// extends 复用 emit/on 契约，再为持有控制权的宿主增加清空接口；没有新建一个运行时父类。
export interface EventBusController extends EventBus {
	// 移除监听器，不取消已经进入执行/await 的处理器。
	clear(): void;
}

/**
 * 创建独立事件总线，返回发送/订阅/清空方法；每次调用得到自己的 EventEmitter。
 * 例：const bus=createEventBus(); const off=bus.on("x",data=>console.log(data)); bus.emit("x",1); off();
 * 监听器同步抛错或返回的 Promise 拒绝会被包装器记录到 console.error，不作为 emit 的返回错误。
 * 但Node保留频道"error"的特殊规则仍在：无error监听器时emit会同步抛出，尚未进入监听包装器。
 * 数据对象按引用传递，不复制；清空/取消只影响后续派发，不能终止已开始的异步工作。
 */
export function createEventBus(): EventBusController {
	// 局部 emitter 由下方方法闭包持有，没有写到全局共享总线。
	const emitter = new EventEmitter();
	// 返回对象的方法捕获同一个 emitter。
	return {
		// 对象方法值是箭头函数；channel/data 的类型从返回接口获得上下文推导。
		emit: (channel, data) => {
			// 普通频道无监听时返回false但此处忽略它；保留error频道无监听仍会按Node规则同步抛错。
			emitter.emit(channel, data);
		},
		// 包装后再登记，所以取消时必须移除同一个 safeHandler，而不能直接移除原 handler。
		on: (channel, handler) => {
			// async 包装器会返回 Promise；EventEmitter 不等待它，因此多个异步处理器可重叠运行。
			const safeHandler = async (data: unknown) => {
				// try 同时覆盖同步抛错和 await 收到的异步拒绝。
				try {
					// void 类型不阻止 JS 回调实际返回 Promise；await 对普通返回值也合法。
					await handler(data);
				} catch (err) {
					// 按频道输出错误，包装器不再次抛出该监听器错误。
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			// EventEmitter 按注册顺序开始调用监听器，但不会串行等待其异步尾部。
			emitter.on(channel, safeHandler);
			// 返回闭包供调用方取消这一份订阅；off 的底层返回值不属于接口承诺。
			return () => emitter.off(channel, safeHandler);
		},
		// 清空全部频道；扩展自身订阅的生命周期清理由扩展加载器另行跟踪。
		clear: () => {
			// 不传频道名意味着所有监听器一并移除，不是只移除当前扩展。
			emitter.removeAllListeners();
		},
	};
}
