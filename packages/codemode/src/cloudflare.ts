/**
 * Wrangler打包环境的codemode入口：直接导入构建时编译的WASM，并提供inline工厂与远端Durable Object类。
 * 普通Node不能直接解释cloudflare:workers或该wasm导入；跨平台宿主应使用portable入口并提供自己的模块/传输。
 * 此文件定义可部署能力，不会自行创建Cloudflare资源或发送部署请求；工具仍在远端客户端宿主执行。
 */
/**
 * Cloudflare Workers entry, for Workers built with Wrangler.
 *
 * Wrangler's default `CompiledWasm` rule turns the `.wasm` import below into a
 * `WebAssembly.Module`; Workers cannot compile WebAssembly from bytes at runtime. Other bundlers
 * do not support the import: use `@earendil-works/pi-codemode/portable` with your own module there.
 *
 * Two ways to run codemode on Cloudflare:
 * - `RemoteCodemodeSandbox` with a {@link CodemodeSandboxDurableObject} deployed as its own
 *   Worker: scripts run in a separate isolate and never block the caller. Use this from a Durable
 *   Object that serves a session.
 * - {@link createInlineCodemodeSandbox}: scripts run on the caller's thread. Simplest; a script
 *   that computes blocks the caller until it awaits a tool or uses up its interrupt budget.
 */
// 平台专用运行基类，不是仓库另一个pi-durable包，也不是Node内置模块。
import { DurableObject } from "cloudflare:workers";
// Wrangler规则把此导入变成WebAssembly.Module，未调用Node readFile或运行时compile。
import quickjsWasmImport from "quickjs-wasi/quickjs.wasm";
// 调用线程VM实现及配置，供工厂和远端服务复用。
import {
	// 默认轮询额度，次数不是毫秒。
	DEFAULT_INTERRUPT_BUDGET,
	// 实际运行在当前isolate线程的沙箱类。
	InlineCodemodeSandbox,
	// 配置类型在JS中擦除。
	type InlineCodemodeSandboxOptions,
} from "./runtime/inline.ts";
// 两个type只是RPC数据/回调契约，serve函数才真正启动一次服务端VM。
import { type CodemodeRemoteExchange, type CodemodeRemoteRequest, serveCodemodeRemote } from "./runtime/remote.ts";
// 仅模块类型，不把wasm.ts的Node文件读取引进此运行图。
import type { CodemodeWasmModule } from "./wasm.ts";

// export *继续公开portable的全部公开符号，补上平台便利工厂/类。
export * from "./portable.ts";

// Wrangler's `CompiledWasm` rule makes this a compiled module; the declaration cannot say so (see
// cloudflare-modules.d.ts).
// 双断言只适配静态导入声明与Wrangler真实产物，未转换字节或验证类型；取决于构建规则正确。
const quickjsWasm = quickjsWasmImport as unknown as CodemodeWasmModule;

/** Default VM memory limit of {@link CodemodeSandboxDurableObject}. Isolates have 128 MB in total. */
/** 远端单VM默认32MiB堆额度，多个VM仍共享isolate资源；不是每个对象总内存隔离保证。 */
export const DEFAULT_REMOTE_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024;

/** `quickjs-wasi/quickjs.wasm`, compiled by Wrangler. */
/** 公开Wrangler编译模块，供其他平台封装组合；类型不透明，不是WASM实例或字节数组。 */
export const cloudflareQuickJSWasm: CodemodeWasmModule = quickjsWasm;

/** `InlineCodemodeSandbox` with the QuickJS module Wrangler bundled. */
/** 创建inline沙箱并固定使用打包WASM；例createInlineCodemodeSandbox({tools,interruptBudget:1000})。Omit去掉调用方wasm字段，工厂不运行脚本。 */
export function createInlineCodemodeSandbox(options: Omit<InlineCodemodeSandboxOptions, "wasm"> = {}) {
	// 先展开选项再覆盖wasm，确保使用此入口携带的模块；返回构造出的沙箱。
	return new InlineCodemodeSandbox({ ...options, wasm: quickjsWasm });
}

/**
 * The remote end of `RemoteCodemodeSandbox`: a Durable Object whose one RPC method runs a script's
 * VM and calls back into the client for every tool call.
 *
 * Deploy it as its own Worker and bind it from the Worker that runs your agent with `script_name`.
 * A separate Worker is what keeps scripts off the agent's thread: a class in the same Worker can
 * share an isolate, and therefore a thread, with the objects that call it.
 *
 * The object keeps no state between executions and never touches storage. Executions that reach
 * the same instance share its thread: they interleave while they wait on tools, and a script that
 * computes delays the others. Name instances per session (`getByName(sessionId)`) to keep one
 * session's scripts together, or per execution for full independence.
 *
 * Limits apply to every request, whatever the client asks for. Override the fields in a subclass:
 *
 *     export class CodemodeSandbox extends CodemodeSandboxDurableObject {
 *       protected maxInterruptBudget = 200_000;
 *     }
 */
/** 可作为独立Worker绑定的Durable Object类；Env泛型描述平台绑定。每次execute单独VM，不读写对象storage，同实例的同步计算仍共享一个线程。 */
export class CodemodeSandboxDurableObject<Env = unknown> extends DurableObject<Env> {
	/** Interrupt polls per execution; the client may only ask for less. See `InlineCodemodeSandboxOptions`. */
	// protected可由子类覆盖；默认作为每个请求最大轮询额度，也为未指定请求填默认。
	protected maxInterruptBudget: number = DEFAULT_INTERRUPT_BUDGET;
	/** VM memory per execution; the client may only ask for less. */
	// 同样是服务端最大单VM堆限制，正常数值请求只能降低；本层不额外校验数值范围。
	protected maxMemoryLimitBytes: number = DEFAULT_REMOTE_MEMORY_LIMIT_BYTES;

	/** Called by `RemoteCodemodeSandbox` over RPC. Resolves when the script has settled or was stopped. */
	/** RPC执行入口，接受启动数据和反向exchange，返回服务端VM结束Promise；例宿主RemoteCodemodeSandbox调用。实际工具不在此类运行。 */
	execute(request: CodemodeRemoteRequest, exchange: CodemodeRemoteExchange): Promise<void> {
		// 复用通用remote服务逻辑，不在平台封装里复制协议实现。
		return serveCodemodeRemote(request, exchange, {
			// 构建时模块不必每次重新编译。
			wasm: quickjsWasm,
			// 读取子类可能覆盖后的额度。
			maxInterruptBudget: this.maxInterruptBudget,
			// 读取子类可能覆盖后的内存上限。
			maxMemoryLimitBytes: this.maxMemoryLimitBytes,
		});
	}
}
