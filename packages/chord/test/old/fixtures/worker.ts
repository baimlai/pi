// Child host for manager tests. FIXTURE_MODE: normal | ignore-shutdown | fatal.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHost, type IpcChannel, ipcLink } from "../../../src/old/index.ts";
import { childControl } from "../../../src/old/manager.ts";
import { Echo } from "./echo.ts";

// 读取管理器传入的模式；?? 只在变量为 null/undefined 时使用 normal，不把空字符串替换掉。
const mode = process.env.FIXTURE_MODE ?? "normal";
// 在 process IPC 通道注册控制消息监听器；init 等待父进程初始化值。
const control = childControl();
// fatal 分支模拟子进程拒绝启动，不创建 Chord 主机。
if (mode === "fatal") {
	// 把启动错误发给父进程，不等于立即退出。
	control.fatal(new Error("fixture refuses to start"));
	// 延后以退出码 1 结束，给 IPC 错误消息留出发送时间；200ms 不是精确执行时刻保证。
	setTimeout(() => process.exit(1), 200);
} else {
	// Before anything that owns data: the kernel lock (if the manager configured one).
	// 先等待管理器配置的进程锁；没配置则直接完成。失败已由 childControl 报 fatal，此回调阻止继续初始化。
	await control.lock().catch(() => {
		// 锁失败时同样延后退出；退出前不打开数据拥有者。
		setTimeout(() => process.exit(1), 200);
		// 永不 resolve 的 Promise 让顶层 await 停在这里；never 表示不存在成功返回值，不是运行时检查。
		return new Promise<never>(() => {});
	});
	// 建子主机并连到父进程。onError 的空回调在此测试中忽略主机报告的错误。
	const host = createHost({
		// self 是当前主机使用的本地主体信息。
		self: { kind: "host" },
		// 优先用测试指定名字，否则叫 worker。Echo 的声明仍要求 w1，由测试配置名字配合。
		name: process.env.HOST_NAME ?? "worker",
		// 把 process 当作 IPC 传输接口使用；as unknown as 仅改变静态视图，不验证或改造对象。
		upstream: { link: ipcLink(process as unknown as IpcChannel), principal: { kind: "server" } },
		onError: () => {},
	});
	// 等待父进程 init；as 断言 greeting 存在，仅帮助 TypeScript，本夹具信任管理器传入形状。
	const init = (await control.init) as { greeting: string };
	// 注册 Echo 工厂；每次建立对象返回 main、echo 和 pid，不在注册时调用方法。
	// 例如 greeting="hi" 时 echo("x") 得到含 hi、x 及本子进程 PID 的字符串。
	host.serve(Echo, () => ({
		// 选择契约唯一变体 main。
		variant: "main",
		// 方法闭包读取初始化问候语，并在调用时读取当前进程 PID。
		echo: (text: string) => `${init.greeting} ${text} from ${process.pid}`,
		// 无业务参数的方法，返回运行夹具的子进程 PID。
		pid: () => process.pid,
	}));
	// 仅测试要求时创建孙进程，以验证管理器能清理整棵进程树。
	if (process.env.GRANDCHILD_FILE) {
		// 启动一个只保留定时器的 Node 进程；忽略其标准输入输出。
		const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		// 把孙进程 PID 写到指定文件供父测试读取，有同步文件写入副作用。
		writeFileSync(process.env.GRANDCHILD_FILE, String(grandchild.pid));
	}
	// 注册停机处理：正常模式先等 host.close 再以 0 退出；ignore-shutdown 则故意不响应供强杀测试使用。
	control.onShutdown(async () => {
		// 该模式提前返回，父管理器需要超时后终止进程。
		if (mode === "ignore-shutdown") return;
		// 等待主机清理结束，失败会使此异步回调拒绝，这里没有 catch。
		await host.close();
		// 正常处理结束，退出整个子进程。
		process.exit(0);
	});
	// 工厂及停机回调已注册后向管理器发送 ready；并非等待一个 Echo 引用完成激活。
	control.ready();
}
