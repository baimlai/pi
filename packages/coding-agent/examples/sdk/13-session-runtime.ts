/**
 * Session runtime
 *
 * Use AgentSessionRuntime when you need to replace the active AgentSession,
 * for example for new-session, resume, fork, or import flows.
 *
 * The important pattern is: after the runtime replaces the active session,
 * rebind any session-local subscriptions and extension bindings to `runtime.session`.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 13 个。上游由
 * `node examples/sdk/13-session-runtime.ts` 直接运行（需先构建工作区）；下游使用
 * createAgentSessionRuntime 管理“当前会话”的替换，并通过 createAgentSessionServices /
 * createAgentSessionFromServices 构造每个 cwd 对应的服务与会话。
 *
 * 演示什么：普通 createAgentSession 返回固定的会话对象；AgentSessionRuntime 允许 /new、
 * resume、fork、import 等流程替换活动会话。关键点是替换后必须把会话级订阅和扩展绑定重新
 * 指向 runtime.session，旧会话的退订函数先释放。示例依次创建初始会话、newSession()、再用
 * switchSession() 切回原文件路径，并在每次替换后重新 bind。脚本不发送模型请求；newSession
 * 与 switchSession 会拆除并重建会话，但不会删除旧会话文件。
 *
 * 能力清单（按调用顺序）：
 * - CreateAgentSessionRuntimeFactory：工厂类型，接收 cwd/sessionManager/sessionStartEvent 等。
 * - createAgentSessionServices({ cwd })：创建 cwd 绑定的服务（模型运行时、设置、资源等）。
 * - createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })：用现成服务建会话。
 * - createAgentSessionRuntime(factory, options)：保存工厂并创建首个运行时容器。
 * - session.bindExtensions({})：触发 session_start 等扩展绑定，替换会话后必须重做。
 * - runtime.newSession() / switchSession(path)：替换活动会话。
 * - runtime.dispose()：发出关闭事件并释放当前会话。
 *
 * 典型运行顺序与预期输出：
 *   1. 打印 `Initial session: <路径>`。
 *   2. newSession 后打印新路径；若原路径存在，switchSession 后打印恢复的路径。
 *   3. 脚本结束时退订并释放运行时；没有 prompt，不产生模型费用，新会话文件可能尚未写出。
 *
 * 示例（真实签名）：
 *   const runtime = await createAgentSessionRuntime(createRuntime, {
 *     cwd: process.cwd(), agentDir: getAgentDir(), sessionManager: SessionManager.create(cwd),
 *   });
 *   await runtime.newSession();            // 返回 { cancelled: boolean }
 *   await runtime.switchSession(path);     // 目标 cwd 默认取自会话头
 *   替换后通过 runtime.session 读取新会话，并重新 bindExtensions/subscribe。
 *
 * 建议阅读顺序：先看工厂如何按 cwd 重建服务，再看 bindSession 的退订/重绑模式，随后看
 * newSession 与 switchSession 的调用顺序，最后看 dispose。
 */

// 这些导入中只有类型与运行时函数分开：CreateAgentSessionRuntimeFactory 编译后擦除。
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// 运行时工厂：每次创建/替换会话时调用，按目标 cwd 重建服务，再把现成服务交给会话构造器。
// 参数解构只取本示例需要的三项；projectTrustContext 等可选字段忽略。
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
	// 创建 cwd 绑定的模型/设置/资源服务；替换 cwd 时必须重建，不能复用旧目录的服务。
	const services = await createAgentSessionServices({ cwd });
	// 返回完整创建结果：先展开会话结果（session 等），再补上 services 与诊断数组。
	return {
		...(await createAgentSessionFromServices({
			// 复用刚创建的服务，避免再次读取配置。
			services,
			// 传入运行时准备好的历史管理器。
			sessionManager,
			// 启动来源元数据（new/resume 等），可省略。
			sessionStartEvent,
		})),
		// 容器需要保存 cwd 相关服务，后续替换时对比/释放。
		services,
		// 诊断来自服务装配过程，交由宿主展示。
		diagnostics: services.diagnostics,
	};
};
// 创建初始运行时容器；cwd/agentDir 在这里给出，sessionManager 使用新建持久化会话。
const runtime = await createAgentSessionRuntime(createRuntime, {
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	sessionManager: SessionManager.create(process.cwd()),
});

// 保存当前会话的事件退订函数；undefined 表示还没有绑定。
let unsubscribe: (() => void) | undefined;

// 把“绑定当前 runtime.session”的步骤集中起来：替换会话后总是调用它。
async function bindSession() {
	// 先退订上一个会话；?. 在还没有订阅时安全跳过，重复绑定不会泄漏旧监听。
	unsubscribe?.();
	// getter 每次读取容器当前持有的会话，不能缓存旧的 session 变量。
	const session = runtime.session;
	// 绑定扩展并触发 session_start；空对象表示没有额外宿主绑定。替换会话后必须重做。
	await session.bindExtensions({});
	// 订阅队列变化事件，用于观察 steer/followUp 数量；返回新的退订函数。
	unsubscribe = session.subscribe((event) => {
		if (event.type === "queue_update") {
			// steering 与 followUp 是两种排队输入；length 相加只是展示总数，不代表执行顺序。
			console.log("Queued:", event.steering.length + event.followUp.length);
		}
	});
	// 返回新会话，便于调用方更新局部变量。
	return session;
}

// 首次绑定并读取初始会话文件路径（可能尚未实际创建文件）。
let session = await bindSession();
const originalSessionFile = session.sessionFile;
console.log("Initial session:", originalSessionFile);

// 新建会话：容器会拆掉旧会话并创建新会话；返回 { cancelled } 被忽略。
await runtime.newSession();
// 关键步骤：重新绑定新会话的扩展与订阅。
session = await bindSession();
console.log("After newSession():", session.sessionFile);

// 原路径存在（字符串非空）时尝试切回；不存在的新路径会按新会话初始化，不抛错。
if (originalSessionFile) {
	await runtime.switchSession(originalSessionFile);
	// 同样必须重新绑定。
	session = await bindSession();
	console.log("After switchSession():", session.sessionFile);
}

// 释放最后一个订阅，再关闭运行时；dispose 发出 session_shutdown 并释放当前会话，不删除历史。
unsubscribe?.();
await runtime.dispose();
