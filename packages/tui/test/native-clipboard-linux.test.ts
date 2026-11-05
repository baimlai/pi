// Linux 原生剪贴板集成回归：满足平台/依赖门禁后，编译受控C fixture，在私有Xvfb或本机假X11连接上验证编码、超时、并发及部分传输清理。
// 套件能展开16个叶用例，但跳过套件不代表这些用例通过；只按测试名筛选也不能省掉顶层工具探测和所选套件的before编译。这里的assert来自strict入口，equal/deepEqual采用严格比较。
import assert from "node:assert/strict";
// 导入同步/异步子进程API：spawn保留流供读取ready，execFile收集完整输出，Sync版本阻塞当前线程。type ChildProcessWithoutNullStreams只描述三条流存在，不保证孩子成功启动或正常退出。
import { type ChildProcessWithoutNullStreams, execFile, execFileSync, spawn, spawnSync } from "node:child_process";
// SHA-256用来比较完整传输的字节内容，不把4MiB正文都打印出来。
import { createHash } from "node:crypto";
// once把一次事件等待变成Promise，常用于等待孩子退出或服务器开始监听；它不是立即产生事件。
import { once } from "node:events";
// 临时目录创建与递归删除只在套件钩子里实际调用，导入不创建文件；成功启用套件后会在临时目录写编译产物。
import { mkdtempSync, rmSync } from "node:fs";
// createServer建立本机TCP测试服务器，Socket类型在编译期约束连接集合，不在导入时监听端口。
import { createServer, type Socket } from "node:net";
// tmpdir返回平台临时目录根路径，不是用户当前工程或home。
import { tmpdir } from "node:os";
// join按本机路径规则连接fixture和原生产物路径，本身不访问文件。
import { join } from "node:path";
// before/after注册套件生命周期，it注册叶用例；type TestContext只约束每例清理钩子等接口，运行时擦除。
import { after, before, describe, it, type TestContext } from "node:test";
// fileURLToPath把模块相对URL转成真实文件系统路径，处理路径中URL编码。
import { fileURLToPath } from "node:url";
// promisify为Node回调式函数提供Promise调用方式，下面转换execFile，不会立即执行外部命令。
import { promisify } from "node:util";

// exec局部名字实际包装execFile而非child_process.exec；默认不启shell，await后得到stdout/stderr对象，启动失败、非零退出或超时等会拒绝。
const exec = promisify(execFile);
// 以当前测试文件的import.meta.url为基准定位fixtures目录，避免依赖运行测试时cwd。
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
// 同理定位生产Linux原生目录，后面从它的prebuilds读.node，不会在这里生成该生产产物。
const native = fileURLToPath(new URL("../native/linux/", import.meta.url));
// 只有真实process.platform为linux且当前Node架构是arm64或x64才supported；&&短路让其他平台无需继续架构匹配，更不会在下方运行工具探测。
const supported = process.platform === "linux" && ["arm64", "x64"].includes(process.arch);
// 声明依赖门禁，初始化表达式跨到下面几行；布尔值只控制后面套件skip，不负责安装依赖或验证已有.node能加载。
const dependenciesAvailable =
	// 平台不支持时&&右边完全不执行，因此macOS直接导入此测试也不会运行下方sh探测。
	supported &&
	// 支持的平台现在就启动sh执行固定探测：依次定位cc/Xvfb/xclip，再用pkg-config查xcb开发配置。&&让前项失败时停止后续检查，未编译或连接X服务器。
	spawnSync("sh", ["-c", "command -v cc && command -v Xvfb && command -v xclip && pkg-config --exists xcb"], {
		// 忽略工具探测的三路标准流，既不显示找到的路径，也不把失败详情保存下来。
		stdio: "ignore",
		// 只有探测进程正常退出码恰为0才认为依赖可用；null/非零都跳过，不区分缺哪个工具。
	}).status === 0;

// 剪贴板reader子进程的JSON报告形状，仅供TS检查；JSON.parse之后的as不会验证这些字段，ok布尔也不是可按成功/失败自动收窄字段的判别联合。
interface ReaderResult {
	// ok表示子脚本是否走成功报告路径，不证明finally的响应性/清理断言也成功，非零退出仍由exec拒绝。
	ok: boolean;
	// value可缺；null表示可读但无内容，短字符串可直接报告。长文本与图片通常只通过length/hash报告，undefined不会作为JSON属性保留。
	value?: string | null;
	// 读取结果恰为undefined时报告unavailable:true，表示当前不可用；这与空内容null不同。
	unavailable?: boolean;
	// length可缺，指reader生成字节副本的长度：文本先编码UTF-8，因此不是JS字符串码元数或终端显示宽。
	length?: number;
	// 可选hash为完整字节的SHA-256十六进制串，不是文件路径。
	hash?: string;
	// 失败报告可带String(error)文字；?只表示静态可缺，没有限制消息一定包含某个协议词。
	error?: string;
}

// 启动一个受控服务子进程，接测试上下文、命令/参数及环境，返回孩子引用和stdout首数据块trim后的ready文字。
// 例如Xvfb首块通常是自动分配的显示编号；函数先注册测试结束时的强杀清理，再收stderr并等待首块/启动错误/提前退出。没有拼接完整行、验证ready格式或独立启动超时，不能把首块到达等同服务所有后续操作必然成功。
async function startServer(
	// t供此函数把孩子清理挂在当前叶用例结束时，而不是全套件结束才处理。
	t: TestContext,
	// command是受控可执行文件名/路径，不自动交shell解释。
	command: string,
	// string[]按项传程序参数，不把整条字符串重新按空格切分。
	args: string[],
	// ProcessEnv允许每键字符串或undefined；传入对象给孩子，不修改父进程process.env。
	env: NodeJS.ProcessEnv,
	// Promise结果含仍活着或随后可能退出的child，以及首块ready字符串；类型不保证它始终活着或ready代表有效协议。
): Promise<{ child: ChildProcessWithoutNullStreams; ready: string }> {
	// 实际spawn并给stdin/stdout/stderr建立pipe；此行启动进程，后面的事件回调稍后才运行。
	const child = spawn(command, args, { env, stdio: "pipe" });
	// 登记异步收尾钩子，测试结束时检查并尝试强杀这个孩子；注册本身不杀进程，钩子Promise会被运行器等待。
	t.after(async () => {
		// 只有退出码和终止信号都还为null时才认为需要等待收尾；这是本地观测，不是以pid探测操作系统的原子存活快照。
		if (child.exitCode === null && child.signalCode === null) {
			// 先订阅exit再发kill，避免孩子很快退出时漏过事件。
			const exited = once(child, "exit");
			// 向这一具体孩子发送SIGKILL，不走其正常JS清理；kill返回的boolean未检查，因此不能承诺任何失败场景都能完成接下来等待。
			child.kill("SIGKILL");
			// 等待已订阅exit，确保观察到孩子退出；没有另设这一清理步骤的硬超时，也不等同所有后代进程都已退出。
			await exited;
		}
	});
	// 用可重赋字符串累计孩子stderr，便于它过早退出时提供诊断；此处没有单独限制累计大小。
	let stderr = "";
	// 给stderr流注册data回调，Buffer类型来自pipe默认字节模式的约定；注册不立即提供数据。
	child.stderr.on("data", (data: Buffer) => {
		// 将本块按默认UTF-8转文字接到累计值，这种逐块toString不专门处理跨块多字节边界，主要供错误诊断。
		stderr += data.toString();
	});
	// 建立并等待Promise；executor立即装事件监听，第一条resolve/reject决定结果，其后事件不会改写已经结算的Promise。
	const ready = await new Promise<string>((resolve, reject) => {
		// spawn错误会reject；这不验证服务是否已经准备好响应请求。
		child.once("error", reject);
		// 若孩子退出，在诊断中拼命令、退出码和当时stderr再reject；即使先已resolve，这个once监听仍留到exit触发，迟到reject不会推翻成功。
		child.once("exit", (code) => reject(new Error(`${command} exited with ${code}: ${stderr}`)));
		// stdout首块即resolve，trim去首尾空白；没有等换行或聚合多块，所以依赖受控fixture把完整ready信息放在首块的约定。
		child.stdout.once("data", (data: Buffer) => resolve(data.toString().trim()));
	});
	// 用对象属性简写返回同一个孩子引用与已读取ready，不等待服务自然结束。
	return { child, ready };
}

// 启动独立Node reader读取指定DISPLAY的原生剪贴板方法，返回解析后的报告Promise；接method字符串及孩子环境，无父进程剪贴板访问。
// 例如getText可报告短文本或unavailable；这里实际加载生产prebuilt.node，子脚本还有心跳与Linux/proc清理断言。方法名/JSON形状不在本函数运行时校验，启动/退出/超时或JSON解析错误会拒绝。
async function readClipboard(method: string, env: NodeJS.ProcessEnv): Promise<ReaderResult> {
	// await包装后的execFile，解构仅保存stdout；孩子stderr仍会在exec失败时随错误供诊断，成功路径这里不使用。
	const { stdout } = await exec(
		// 运行当前Node二进制，未调用npm或安装/编译产物。
		process.execPath,
		// 下面数组各项分别成为子脚本路径、addon路径和方法名参数。
		[
			// 使用受控clipboard-reader.cjs，它会require第二个参数指定的原生模块。
			join(fixtures, "clipboard-reader.cjs"),
			// 按当前process.arch定位生产Linux .node；顶层依赖检查不验证这个文件存在、架构/ABI兼容或动态库可用。
			join(native, "prebuilds", `linux-${process.arch}`, "linux-platform-x11.node"),
			// 方法名透传给reader的动态属性调用；正常调用方只传getText/getImage，但string类型本身没有白名单。
			method,
		],
		// 用指定环境并设6000ms子进程超时，stdout默认UTF-8；超时等执行错误使Promise拒绝，不是必然得到ok:false报告。
		{ env, timeout: 6000 },
	);
	// JSON.parse会实际解析且可抛错；as ReaderResult只改变TS看待结果的类型，不检查ok/length/hash字段真的存在或正确。
	return JSON.parse(stdout) as ReaderResult;
}

// 仅依赖门禁为真时运行套件，60000为组级毫秒超时配置，不是任意原生阻塞的强制取消保证。启用后循环共注册16叶；before会先编译，叶名过滤不能把编译变成纯字符串测试。
describe("native Linux clipboard", { skip: !dependenciesAvailable, timeout: 60000 }, () => {
	// 声明存放本套件临时产物的目录字符串，before成功创建后赋值；TS声明不会在运行时先写空串。
	let directory: string;

	// 给一例启动独立Xvfb并返回孩子与覆盖DISPLAY的新环境对象；例如ready为42则DISPLAY为:42。它真正创建X服务器，安全隔离依靠这条独立显示地址，不是读取当前桌面剪贴板。
	async function startX11(t: TestContext) {
		// await受控服务启动器得到孩子和stdout首块；测试结束的kill清理由startServer挂在同一个t上。
		const { child, ready } = await startServer(
			// 传本例上下文，使Xvfb属于本例收尾。
			t,
			// 固定执行Xvfb虚拟X服务器，依赖系统已安装，不下载或安装。
			"Xvfb",
			// -displayfd 1让Xvfb自动选显示号写stdout；屏0为640×480、24位深度；-nolisten tcp关闭它的TCP监听，正常客户走本地显示连接。
			["-displayfd", "1", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
			// Xvfb本身继承当前环境对象作为启动配置；没有在此改变父进程DISPLAY。
			process.env,
		);
		// 浅复制环境再覆盖DISPLAY，只供后续子进程使用；ready未验证为完整数字，依赖上面首块读取约定，不能把它当通用X显示发现解析器。
		return { child, env: { ...process.env, DISPLAY: `:${ready}` } };
	}

	// 注册套件before：实际启用并运行用例前创建临时目录、两次同步编译。它没有把编译延迟到某个特定叶用例。
	before(() => {
		// mkdtempSync实际在平台临时目录创建唯一目录，之后产物写到这里；创建失败抛错。
		directory = mkdtempSync(join(tmpdir(), "pi-clipboard-test-"));
		// 通用编译参数依次为C11、POSIX 2008接口、常见/额外警告并把警告当错误、pthread支持；这不是TS编译参数。
		const flags = ["-std=c11", "-D_POSIX_C_SOURCE=200809L", "-Wall", "-Wextra", "-Werror", "-pthread"];
		// 同步运行cc编译第一份C fixture，阻塞测试线程；未配独立timeout，失败抛execFileSync错误。
		execFileSync("cc", [
			// 展开共用flags为多个独立命令行参数，不拼shell命令。
			...flags,
			// 输入clipboard-x11-test.c，里面直接include生产X11实现，既能运行内存metadata断言，也能充当受控owner或失败接收端。
			join(fixtures, "clipboard-x11-test.c"),
			// 链接XCB库供真实X11协议调用。
			"-lxcb",
			// 链接动态符号查询库，配合包含的N-API辅助源码。
			"-ldl",
			// -o说明下一项是输出产物路径。
			"-o",
			// 输出临时x11-test可执行文件，不覆盖生产prebuilds。
			join(directory, "x11-test"),
		]);
		// 同步编译第二份受控私有线程测试addon，实际执行C工具链。
		execFileSync("cc", [
			// 重复展开同一套通用C/pthread警告参数。
			...flags,
			// -shared生成共享库，供Node以.node加载，不生成独立main程序。
			"-shared",
			// -fPIC生成位置无关代码以用于共享对象。
			"-fPIC",
			// -nostdlib不自动链接标准启动文件/库，按原英文模拟生产prebuild的未版本化系统符号导入；不是说fixture完全不调用C运行库。
			"-nostdlib", // Match the prebuild's unversioned system-library imports.
			// 仅arm64时展开-mno-outline-atomics，使原子操作不依赖外置outline辅助；其他架构展开空数组，不向cc传空字符串。
			...(process.arch === "arm64" ? ["-mno-outline-atomics"] : []), // Inline the fixture's allocation counters.
			// 把-z nodelete交链接器，令动态加载器保留库映射，配合环境卸载后仍在运行的私有线程场景；不代表JS对象不会被垃圾回收。
			"-Wl,-z,nodelete",
			// 输入clipboard-worker-test.c，它复用生产线程桥接，实际reader由受控阻塞回调代替，所以该addon本身不连接X11。
			join(fixtures, "clipboard-worker-test.c"),
			// 显式链接dl，供动态查Node/pthread相关符号。
			"-ldl",
			// 指定输出文件选项。
			"-o",
			// 把测试addon写为临时worker-test.node，不重新生成生产Linux addon。
			join(directory, "worker-test.node"),
		]);
	});

	// 注册套件结束清理钩子；它只删除临时目录，不自动替所有服务进程做退出等待。
	after(() => {
		// 目录已赋值时递归删除这个测试目录，force容忍缺失，权限等其他错误仍可能抛；不删除生产prebuilds。
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	// metadata叶只执行C程序的内存分支，验证INCR累计前的类型/格式/长度检查；但整个用例仍依赖before已经真实编译C，不能称纯TS单元测试。
	it("validates X11 incremental property metadata before accumulating bytes", () => {
		// 同步启动临时x11-test metadata，C内部断言成功才打印validated；UTF-8解码/trim后严格比较该词，非零进程退出先抛错而不是靠输出判断成功。
		assert.equal(execFileSync(join(directory, "x11-test"), ["metadata"], { encoding: "utf8" }).trim(), "validated");
	});

	// 循环注册3种私有reader场景：并发请求、不放行读者时进程自然退出、来源Worker被终止后迟到清理。循环现在只是注册，不立刻跑3次。
	for (const mode of ["concurrent", "process-exit", "worker-exit"]) {
		// 每个async测试调用受控CJS驱动并检查passed；具体并发/计时/分配计数断言在驱动和addon里，不在本函数镜像实现。
		it(`bounds private clipboard work and preserves cleanup: ${mode}`, async () => {
			// 等待子进程整个执行结果，不只读首块ready。
			const { stdout } = await exec(
				// 使用当前Node运行驱动。
				process.execPath,
				// 依次传驱动路径、临时受控addon路径和本轮mode；这一addon不读取X11，但会创建真实原生线程，worker-exit还创建Node Worker。
				[join(fixtures, "clipboard-worker-test.cjs"), join(directory, "worker-test.node"), mode],
				// 新环境只在孩子里把UV线程池设2，让额外长期占池等待更容易暴露；10000ms为exec超时，父进程环境不修改。
				{ env: { ...process.env, UV_THREADPOOL_SIZE: "2" }, timeout: 10000 },
			);
			// 要求正常退出后stdout去首尾空白恰为passed，子脚本先打印再未按时退出也不能绕过exec超时失败。
			assert.equal(stdout.trim(), "passed");
		});
	}

	// 循环为getText与getImage各注册一个连接建立卡住的场景，方法名作为本轮闭包值。
	for (const method of ["getText", "getImage"]) {
		// 本轮实际启动假X11 TCP服务，故意不回复握手，再约300ms断开；通过子reader心跳及总时长/连接断言观察原生连接等待不阻塞JS。
		it(`keeps JS responsive during stalled X11 connection setup: ${method}`, async (t) => {
			// 新建Set保存仍未触发close的Socket对象引用；泛型Socket只约束TS，不创建网络连接。
			const sockets = new Set<Socket>();
			// 累计接受的连接次数，清理Socket不会把这个计数减回0。
			let connections = 0;
			// 创建服务并注册新连接回调；此刻还没listen，回调以后每次接受连接才执行。
			const server = createServer((socket) => {
				// 接受连接时计数加1，让后面能证明helper确实访问过假服务器。
				connections++;
				// 将该连接放入活动集合，供断言与收尾销毁。
				sockets.add(socket);
				// 装一个空data处理器消耗握手字节但不回复，刻意让libxcb建立连接停滞；不是模拟完整X11服务器。
				socket.on("data", () => {}); // Accept setup bytes without replying.
				// libxcb owns setup blocking; release it after checking the JS timer.
				// 为当前连接登记约300ms后destroy的真实timer，主动释放卡住的握手；并非硬实时300ms期限。
				const timer = setTimeout(() => socket.destroy(), 300);
				// 登记本例结束时取消这一个timer，避免测试已结束后它再对旧Socket运行；不在注册时清除。
				t.after(() => clearTimeout(timer));
				// close事件真正到达才从Set删除该Socket；调用destroy不意味着同一行已触发close回调。
				socket.on("close", () => sockets.delete(socket));
			});
			// 登记异步服务收尾：先销毁集合中连接，再等server.close完成，错误让清理Promise拒绝。
			t.after(async () => {
				// 逐个请求销毁仍保存的Socket，不向对端发送有效X11回复。
				for (const socket of sockets) socket.destroy();
				// 把close回调包装Promise<void>：有error就reject，否则resolve；close停止新接受连接，已有连接已在上一行请求销毁，并不主动等某个原生线程返回。
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			});
			// 只监听127.0.0.1且端口0让OS分配空闲端口，不监听公网地址；这是实际本机TCP服务。
			server.listen(0, "127.0.0.1");
			// 等待listening事件后再读取地址；once也可因error事件拒绝，没有假定listen同步完成。
			await once(server, "listening");
			// address运行时可为地址对象、字符串或null，下一行在这个网络边界做有效性断言。
			const address = server.address();
			// 要求非空、非Unix路径字符串且端口大于6000，既让TS收窄对象类型，也保证后面X11显示号减法为正。
			assert.ok(address && typeof address !== "string" && address.port > 6000);
			// X11 TCP端口等于6000加显示号，因此DISPLAY设127.0.0.1:实际端口减6000，指向这个假服务器，不指向桌面。
			const env = { ...process.env, DISPLAY: `127.0.0.1:${address.port - 6000}` };
			// 记录单调毫秒起点，包含子进程启动、require、读取和报告耗时。
			const started = performance.now();
			// 启动真实生产addon的指定读取，等待其子进程报告，期间服务器没有提供完整握手。
			const result = await readClipboard(method, env);
			// 要求整段少于3500ms，给连接关闭/调度留容差；这是固定回归阈值，不证明任何机器都精确按300ms返回。
			assert.ok(performance.now() - started < 3500, "The worker must return after the connection closes");
			// 深比较报告为正常执行但不可用，而非空内容null或ok:false传输异常；实际连接建立失败保留UNAVAILABLE。
			assert.deepEqual(result, { ok: true, unavailable: true });
			// 累计连接数必须大于0，防没有真正碰到假服务器就碰巧返回不可用。
			assert.ok(connections > 0, "The helper must reach the stalled X11 server");
			// 活动Socket集合须已清空，观察close回调到达；不是扫描全部系统连接或原生内存的泄漏证明。
			assert.equal(sockets.size, 0, "The failed connection must be closed");
		});
	}

	// Latin-1回归：在新Xvfb里把STRING目标写成单字节编码，再读回JS文字，验证不误当UTF-8解码。
	it("decodes X11 STRING as Latin-1", async (t) => {
		// 启动本例专属虚拟X服务器，后续命令共用返回的DISPLAY。
		const { env } = await startX11(t);
		// 同步调用xclip把输入设为CLIPBOARD selection的STRING目标；它真的改变这个隔离显示的剪贴板所有权，不是PRIMARY选择。
		execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", "STRING"], {
			// xclip使用新Xvfb环境，父环境不变。
			env,
			// 按latin1把café、空格、英镑与ÿ编码成单字节Buffer，刻意与UTF-8字节不同。
			input: Buffer.from("café £ÿ", "latin1"),
			// 只给xclip stdin喂数据，忽略其stdout/stderr，不把控制台输出当剪贴板数据。
			stdio: ["pipe", "ignore", "ignore"],
			// 同步命令超时5000ms；xclip可留下提供selection的后台owner，未由startServer记录它的句柄，隔离Xvfb结束后其连接才会失效。
			timeout: 5000,
		});
		// 通过生产helper读取文本目标并等子reader退出。
		const result = await readClipboard("getText", env);
		// 先要求ok:true，失败消息取报告error供诊断。
		assert.equal(result.ok, true, result.error);
		// 严格要求回到原Unicode字面量café £ÿ，验证Latin-1解码结果，而不是只比较字节长度。
		assert.equal(result.value, "café £ÿ");
	});

	// 格式发现兜底：受控owner拒绝TARGETS，但接受直接UTF8_STRING；验证生产文本reader仍能取得正文。
	it("reads UTF8_STRING when X11 TARGETS is refused", async (t) => {
		// 创建隔离Xvfb环境。
		const { env } = await startX11(t);
		// 运行临时x11-test direct-text作为owner并等首块ready，测试结束由t.after强杀；它会改变该显示的CLIPBOARD所有者。
		await startServer(t, join(directory, "x11-test"), ["direct-text"], env);
		// 读取文本，实际生产preferred_target在TARGETS拒绝后尝试UTF8_STRING。
		const result = await readClipboard("getText", env);
		// 要求报告成功，失败时显示error。
		assert.equal(result.ok, true, result.error);
		// 正文须严格为含重音和日文的café 日本語。
		assert.equal(result.value, "café 日本語");
	});

	// 检查无owner的显示读取文本/图片都为空内容null，再只提供文本时图片读取仍null；不可用undefined与传输异常不满足这些预期。
	it("returns null for empty X11 clipboards and text-only selections", async (t) => {
		// 新Xvfb初始没有本测试设置的CLIPBOARD owner。
		const { env } = await startX11(t);
		// 空显示文本报告应恰为ok:true与value:null，没有unavailable字段。
		assert.deepEqual(await readClipboard("getText", env), { ok: true, value: null });
		// 空显示图片也应报告null。
		assert.deepEqual(await readClipboard("getImage", env), { ok: true, value: null });
		// 再同步xclip把UTF8_STRING文字放到同一个隔离显示的CLIPBOARD，不提供图片格式。
		execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", "UTF8_STRING"], {
			// 明确传隔离DISPLAY环境。
			env,
			// 输入固定text only，默认UTF-8发送，不是文件路径。
			input: "text only",
			// stdin为pipe供正文，输出错误都忽略。
			stdio: ["pipe", "ignore", "ignore"],
			// 最多配置5000ms外部命令等待，错误会使当前测试失败。
			timeout: 5000,
		});
		// 此时图片目标无共同支持格式，正常返回null，不能误将文本字节当图像。
		assert.deepEqual(await readClipboard("getImage", env), { ok: true, value: null });
	});

	// 顺序覆盖短Unicode文本、4MiB长文本与4MiB图片目标字节；通过长度及SHA-256核完整性，图片数据故意不是有效PNG，不测试图像解码。
	it("preserves X11 Unicode and incremental text/image transfers", async (t) => {
		// 为三轮传输共用一个新Xvfb，每轮xclip更新该显示的selection。
		const { env } = await startX11(t);
		// for...of每轮解构target、method和bytes，三项分别控制X11格式广告、helper方法、预期原始字节。
		for (const [target, method, bytes] of [
			// 短文本默认UTF-8编码，验证多字节Unicode传输。
			["UTF8_STRING", "getText", Buffer.from("café 日本語")],
			// 4×1024×1024为4MiB，Buffer.alloc用十进制120即ASCII x填满，验证长文本/INCR路径。
			["UTF8_STRING", "getText", Buffer.alloc(4 * 1024 * 1024, 120)],
			// 图片目标用4MiB的123字节填充，即ASCII左花括号；这里只按image/png目标传任意字节，生产helper不会在此解码PNG签名。
			["image/png", "getImage", Buffer.alloc(4 * 1024 * 1024, 123)],
			// as const让数组/元组在TS中保留字面量与只读视图，便于解构推断，不会运行时freeze数组或Buffer。
		] as const) {
			// 把本轮bytes写进隔离CLIPBOARD，-t使用当前target。
			execFileSync("xclip", ["-selection", "clipboard", "-in", "-t", target], {
				// 继续传同一个Xvfb环境。
				env,
				// 标准输入直接给Buffer字节，避免先转文字再损坏图片/编码。
				input: bytes,
				// 忽略xclip输出，正文只经stdin提供。
				stdio: ["pipe", "ignore", "ignore"],
				// 为该写入命令配置5000ms等待；每轮独立命令，不是三轮合计预算。
				timeout: 5000,
			});
			// 调用与本轮格式匹配的getText或getImage，实际reader报告短值/字节长度/hash。
			const result = await readClipboard(method, env);
			// 要求读取成功，错误消息可帮助定位失败轮次。
			assert.equal(result.ok, true, result.error);
			// 报告字节长度须等原Buffer长度，不把Unicode字符数与字节数混用。
			assert.equal(result.length, bytes.length);
			// 对预期完整字节算SHA-256，与reader的hash严格相等；不依赖stdout包含4MiB正文，也不是只比较一个前缀。
			assert.equal(result.hash, createHash("sha256").update(bytes).digest("hex"));
		}
	});

	// 循环注册连接中断与等待超时两个故障用例；两者先完成X11上下文并收到owner请求，区别于连接建立阶段不可用。
	for (const mode of ["disconnect", "timeout"]) {
		// 每例故意让owner完全不答，随后断开服务器或等协议期限，要求报告异常文字，保持错误与unavailable的区别。
		it(`reports X11 transfer ${mode} as an exception, not an unavailable display`, async (t) => {
			// 保留Xvfb孩子引用，disconnect模式需要强杀它；env仍指这个隔离显示。
			const { child, env } = await startX11(t);
			// 启动idle owner，它收到请求只打印requested而不发送selection回复。
			const owner = await startServer(t, join(directory, "x11-test"), ["idle"], env);
			// 在发读取之前先等待owner stdout下一块，避免请求通知很快到达时漏听；未验证该块文本恰等requested。
			const requested = once(owner.child.stdout, "data");
			// 记录整个读取/故障过程起点。
			const started = performance.now();
			// 启动但暂不await读取Promise，让下面可以在读取进行中制造断连。
			const result = readClipboard("getText", env);
			// 等owner首个后续数据块，作为请求已到达的受控同步点，而不是固定睡眠猜测时序。
			await requested;
			// 仅disconnect模式向本例Xvfb发SIGKILL，timeout模式保留服务器与无响应owner继续等待。kill返回值未检查。
			if (mode === "disconnect") child.kill("SIGKILL");
			// 等待原读取Promise得到报告；原生传输拒绝被clipboard-reader.cjs的catch转为ok:false JSON，因此此层仍可能正常兑现对象。
			const failure = await result;
			// 要求ok:false，不能把已连接后的传输失败吞成ok:true/unavailable。
			assert.equal(failure.ok, false);
			// error缺失用??回退空串，再要求含X11 clipboard；正则不要求整段错误消息完全相同。
			assert.match(failure.error ?? "", /X11 clipboard/);
			// 总时长小于3500ms，观察生产发现/传输沿同一约2秒deadline，不是精确2秒实时保证或对所有libxcb阻塞的强制截止。
			assert.ok(performance.now() - started < 3500, "The transfer must share the 2-second deadline");
		});
	}

	// 对文本与图片分别注册坏元数据清理和半传输超时两个用例，共4叶。
	for (const content of ["text", "image"]) {
		// 此例用C跟踪分配验证曾收到部分数据后发生元数据错误时释放缓冲，不仅检查返回异常；具体字节账本在fixture内。
		it(`frees partially received X11 ${content} after invalid metadata`, async (t) => {
			// 启动隔离Xvfb。
			const { env } = await startX11(t);
			// invalid owner先发4096字节，再发类型/格式错误的零元素终止块，故意破坏INCR结束元数据。
			await startServer(t, join(directory, "x11-test"), ["invalid"], env);
			// 直接运行x11-test text/image接收端；它调用生产内部读取并断言失败后指针/长度归零、峰值证明曾分配、存活跟踪字节归0，6000ms为子进程预算。
			const { stdout } = await exec(join(directory, "x11-test"), [content], { env, timeout: 6000 });
			// 正常退出且stdout去空白为clean才成功；只覆盖fixture跟踪的实现分配，不证明整个系统或libxcb绝无泄漏。
			assert.equal(stdout.trim(), "clean");
		});

		// 半传输例让owner发一块后不发结束块，要求超时异常且JS心跳仍能运行，文本/图片各一例。
		it(`times out stalled X11 ${content} after a partial transfer without blocking JS`, async (t) => {
			// 创建本例隔离显示。
			const { env } = await startX11(t);
			// partial owner发4096字节后保持等待，不发送合法零元素终止块；父测试清理钩子最终尝试强杀owner。
			await startServer(t, join(directory, "x11-test"), ["partial"], env);
			// 记录从启动reader前开始的单调毫秒时间。
			const started = performance.now();
			// 用三元为当前content选getText/getImage，只求值选中方法名，再等待独立reader加载生产helper完成。
			const result = await readClipboard(content === "text" ? "getText" : "getImage", env);
			// 要求失败报告，不能把未完成的半份内容当成功。
			assert.equal(result.ok, false);
			// 错误说明须含X11 clipboard；??只在缺失或null时回退，不替换合法空串。
			assert.match(result.error ?? "", /X11 clipboard/);
			// 要求总时长少于3500ms；子reader自己的finally还在耗时超过200ms时要求心跳>5并检查其Linux主任务children文件为空，属于有限响应性/子进程迹象，不是硬实时或全系统资源证明。
			assert.ok(performance.now() - started < 3500);
		});
	}
});
