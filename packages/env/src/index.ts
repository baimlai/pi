// pi-env公共入口：把连接、文件环境、SSH准备、普通进程、PTY和监控统一导出，方便上游从包名导入；实现仍分散在相应文件中。
// export ... from是重导出，不是在这里再写一份实现。例import { Connection, openProcess } from "@earendil-works/pi-env"；type项只供TS检查，其他项属于运行时API。
export {
	// 按需启动daemon并管理帧/事件/取消/失联，构造连接不代表已完成握手。
	Connection,
	// 连接命令数组或异步命令工厂、日志回调的静态选项。
	type ConnectionOptions,
	// 识别带lost标记的连接错误，不把所有远端业务失败都当成掉线。
	isConnectionLost,
	// 将hello的Rust系统/架构拼写映成Node习惯名，非实时探测本机平台。
	nodePlatform,
	// daemon/连接层错误包装，保code、path和原字段。
	RemoteError,
	// hello报告的远端机器信息接口，静态声明本身不验证传输数据。
	type RemoteInfo,
	// 请求结果的JSON、原始字节和原daemon会话编号。
	type Reply,
	// 单次请求的payload、signal、事件/本地开始通知与原会话约束。
	type RequestOptions,
} from "./connection.ts";
// 本机NodeExecutionEnv加同机daemon的listFiles；连接仍由调用者管理，其余能力使用本机实现。
export { LocalExecutionEnv, type LocalExecutionEnvOptions } from "./list-files.ts";
// 普通pipe进程：openProcess等started交RemoteProcess，onStdout/onStderr分流原始字节，exited等终态；不是伪终端。
export { openProcess, type ProcessOptions, RemoteProcess } from "./process.ts";
// 完整远端文件/命令环境及选项，供Durable工具经Connection访问远端；这里只导出类，不在此创建环境或执行命令。
export { RemoteExecutionEnv, type RemoteExecutionEnvOptions } from "./remote-env.ts";
// SSH引导API集中导出；调用方决定何时探测/部署/信任，不因这一列表就自动连接某个主机。
export {
	// 把已确认的主机key加入指定known-hosts文件，同类型旧key不同则拒绝，不静默替换。
	acceptHostKey,
	// 立即探测/验证或部署daemon，再返回延迟启动连接；会产生SSH及远端文件副作用。
	connectSsh,
	// 检查远端daemon内容，必要时上传/校验/改名并清理其他内容版本，返回远端路径。
	deployDaemon,
	// 通过SSH探测系统/架构/home和Windows shell等信息，不是读本机process.platform。
	detectPlatform,
	// 从应用自己的known-hosts文件移除目标alias的条目，不自动接受新key。
	forgetHostKey,
	// 已信任主机key发生变化这一错误类别，和未知key分开供宿主处理。
	HostKeyChangedError,
	// 主机key尚未信任这一错误类别，不在错误构造时自动确认。
	HostKeyUnknownError,
	// 计算当前机器所需的随包daemon路径，仍需实际文件存在并可执行才能启动。
	localDaemon,
	// 按给定远端系统/架构拼随包二进制路径，本身不上传或检查该文件内容。
	packagedDaemon,
	// 支持的系统/架构、home、可选shell及warnings的TS结构。
	type RemotePlatform,
	// SSH目标加可选本地binary、loginShell和日志配置的接口。
	type SshConnectOptions,
	// SSH执行失败的错误类，保退出码和诊断，不与文件FileError混同。
	SshError,
	// 主机、账号/端口/identity与应用known-hosts路径/alias等连接参数。
	type SshTarget,
	// 经相同SSH路由扫描主机key到临时文件并给出指纹；扫描结果仍需与可信渠道核对，非自动认证。
	scanHostKey,
	// 生成ssh到主机为止的参数数组，含严格主机key/禁转发等设置；只构造参数，不执行程序。
	sshArguments,
	// 构造lazy连接及remote读取函数，首次使用连接时才探测/验证/部署，info/session也可触发；后续重新启动会再次验证daemon。
	sshConnection,
} from "./ssh.ts";
// PTY入口：默认登录shell、原始合并输出、输入/缩放/前台作业；TerminalForeground/TerminalOptions只是静态类型。
export { openTerminal, RemoteTerminal, type TerminalForeground, type TerminalOptions } from "./terminal.ts";
// 文件监控包装及静态配置；首次open等覆盖，首次就绪后的lost失联才自动重连，并用overflow提示应全扫。
export { RemoteWatcher, type RemoteWatchOptions } from "./watch.ts";
