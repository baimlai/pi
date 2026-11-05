// 用成对内存对象模拟MCP传输，供client.test及适配器测试使用；消息经structuredClone复制后由微任务交给对端，不开网络端口或子进程。
// 导入消息类型及连接不可用异常；类型不会自动校验传入对象，异常用于start/send失败。
import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.ts";
// McpTransport只参与TS接口检查，TransportEvents实际提供订阅/广播逻辑；测试入口testing/index.ts重导出本文件。
import { type McpTransport, TransportEvents } from "./transport.ts";

// extends继承事件底座，implements核对传输接口；本实现没有send选项参数，因此不会读取McpTransportSendOptions.signal，也不自动应用字节上限。
export class InMemoryTransport extends TransportEvents implements McpTransport {
	// 对端引用在connectPeer后保存，初始undefined；它不是服务器地址或文件句柄。
	private peer: InMemoryTransport | undefined;
	// 启动标记，start后为true；单独start不要求此时对端已连接或已启动。
	private started = false;
	// 关闭标记，close一开始置true，此后start/send拒绝，已排队到本端的消息也会忽略。
	private closed = false;

	// 为本端绑定一个对端，输入InMemoryTransport，无返回值；例：a.connectPeer(b)只完成a→b，要双向需再b.connectPeer(a)。有旧peer便抛Error，不启动任何一端，也没有检查自连接/环。
	connectPeer(peer: InMemoryTransport): void {
		// 已有对端就拒绝替换，哪怕传入相同对象；没有根据closed状态自动清掉旧绑定。
		if (this.peer) throw new Error("In-memory MCP transport already has a peer");
		// 保存原对象引用，不克隆对端；之后send与close使用这个引用。
		this.peer = peer;
	}

	// 启动这一端，输入无参数，返回Promise<void>；例：await a.start()只设本地标记。已关闭则拒绝，重复start在未关闭时仍成功，不会同时启动peer。
	async start(): Promise<void> {
		// closed时抛连接关闭异常；因为方法是async，调用者收到拒绝Promise。
		if (this.closed) throw new McpConnectionClosedError();
		// 直接标为已启动，不打开套接字、安装进程钩子或等待握手。
		this.started = true;
	}

	// 发送一条消息：先检查两端状态、structuredClone，再排微任务交给peer，返回Promise<void>；例：两端start后a.send({jsonrpc:"2.0",method:"ping"})让b收到复制值。
	// 此Promise只代表已完成检查/复制/排队，不是业务响应或监听器处理完毕；复制失败会拒绝，但微任务里的监听器throw不会回填为send拒绝。消息未做JSON编码，能复制的值也未必符合真实JSON线协议。
	async send(message: JsonRpcMessage): Promise<void> {
		// 本端未start或已close都拒绝，不悄悄启动或排队等连接。
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		// 捕获当前peer引用，后续微任务通过它投递，不在执行时重新查this.peer。
		const peer = this.peer;
		// ?.允许peer缺省，任一端不可用就拒绝；这里还没复制或排投递任务。
		if (!peer?.started || peer.closed) throw new McpConnectionClosedError("In-memory MCP peer is not connected");
		// structuredClone复制可支持的数据图，避免发送者之后改普通嵌套对象影响接收值；函数等不可克隆值会抛错，NaN/BigInt等能克隆也不等于可按JSON原样传输。
		const copy = structuredClone(message);
		// queueMicrotask安排当前同步栈之后调用peer.deliver；不await它，若peer在此期间关闭会由deliver丢弃，回调异常按宿主微任务规则报告，不由send统一catch。
		queueMicrotask(() => peer.deliver(copy));
	}

	// 关闭本端再递归关peer，返回Promise<void>；例：a.close()先同步发a关闭事件，再调用b.close发b事件，b回调a时因a已closed而停止。
	// 标记防止正常双端无限递归，不共享首次关闭Promise；本端关闭监听器若抛错会使此async方法拒绝并阻止调用peer.close，不能保证异常情况下两端都关完。
	async close(): Promise<void> {
		// 已closed直接返回；并发/重入的第二次close不等待第一次可能尚未结束的peer关闭。
		if (this.closed) return;
		// 先设置本端关闭标记，再通知，防止回调重入send或close继续正常派发。
		this.closed = true;
		// 同步发本端关闭事件，底座对重复发射去重；回调可能抛错，此处没有catch。
		this.emitClose();
		// 有peer才await它的关闭；peer反调回来时本端已closed，所以正常成对关系会终止。无需等待已排队微任务或应用处理器结束。
		await this.peer?.close();
	}

	/** Exposed so tests can simulate transport-level failures. */
	// 把父类protected的错误分发方法公开，便于测试模拟故障；输入任意错误值，无返回值，不自动关闭。例：clientTransport.emitError(new Error("stray log"))只发错误事件，监听器或String转换异常可传播。
	// override让TS核对父类确有同名成员，不生成另一套错误处理机制。
	override emitError(error: unknown): void {
		// 委托父类规范化并广播，保留其活Set遍历/不捕获回调的行为。
		super.emitError(error);
	}

	// 接收排队投递的复制消息，无返回值；closed则忽略，其他情况发消息事件。例：send排队后接收端close会丢掉这条消息，不回传失败确认。private限制TS外部访问，不是协议校验器。
	private deliver(message: JsonRpcMessage): void {
		// 投递时再查接收端closed，避免排队期间已关闭仍向应用发消息；不再次检查started。
		if (this.closed) return;
		// 同步把复制消息交给监听器，回调可能继续产生响应，也可能抛错；此处不兜异常。
		this.emitMessage(message);
	}
}

// 创建并双向绑定一对尚未启动的传输，输入无参数，返回{client,server}；例：测试先start server，再把client交McpClient.connect。副作用仅分配/绑定内存对象，不启动I/O，两个名字本身不赋予协议权限。
export function createInMemoryTransportPair(): { client: InMemoryTransport; server: InMemoryTransport } {
	// 创建第一端，started/closed初始都false。
	const client = new InMemoryTransport();
	// 创建第二个独立端，事件Set与状态不与第一端共享。
	const server = new InMemoryTransport();
	// 建立client到server的引用。
	client.connectPeer(server);
	// 再建立server到client的引用，形成对称通道。
	server.connectPeer(client);
	// 属性简写返回两个原对象引用，调用方各自负责启动与监听。
	return { client, server };
}
