#!/usr/bin/env node

// 开发用OAuth命令行：装配内置OAuth Provider后立即按argv打印帮助/列表或登录，登录成功写当前目录auth.json。
// 这是带顶层main副作用的入口，不应只为拿函数就import；Provider装配会求值依赖图，真正login可有网络/回调监听，不能当纯配置模块。
// randomUUID作为getDeviceId工厂传给登录流程，传函数不等立即生成或持久保存安装ID。
import { randomUUID } from "node:crypto";
// 同步文件API用于相对auth.json存在检查、权限和JSON读写；导入函数本身不读文件。
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
// readline提供终端问答；下面显式createInterface才连stdin/stdout。
import { createInterface } from "node:readline";
// 三个类型只用于描述新提示/持久凭据/提供商，编译后擦除，不因类型导入构造Models。
import type { AuthPrompt, OAuthCredential, Provider } from "./index.ts";
// builtinProviders函数会装配全部内置Provider，再由本文件过滤支持OAuth者；工厂/依赖副作用与登录方法调用不同。
import { builtinProviders } from "./providers/all.ts";

// 相对当前进程cwd的文件名，不是coding-agent用户目录或自动查找项目根，也不是CredentialStore锁。
const AUTH_FILE = "auth.json";
// 模块求值即调用内置工厂并filter，缓存这次Provider对象数组；main的help/list也发生在装配之后。
const PROVIDERS = builtinProviders().filter(
	// 类型谓词加交叉类型，NonNullable去掉oauth可选值，让后续TS可直接调用login；它不会新建运行能力。
	(provider): provider is Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } } =>
		// 实际只查oauth!==undefined，符合Provider契约即保留；不在此做完整auth对象/函数shape验证。
		provider.auth.oauth !== undefined,
);

// 把readline.question回调接成Promise，接已有rl与问题返回输入原文；例问题“编号”用户答1时兑现文字"1"。
// 会写提示并等stdin，不trim/验证/隐藏输入，不把AuthPrompt.signal传给readline；关闭中断不一定会让这个Promise拒绝。
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	// Promise执行器立即调用question，回答回调resolve；同步question异常会成为拒绝，没有专门abort/close的reject监听。
	return new Promise((resolve) => rl.question(question, resolve));
}

// 同步读相对auth.json，返回声明的提供商→OAuth凭据表；例文件不存在返回{}，读/JSON解析失败也降为空。
// 不是schema校验：合法JSON的null/数组/原始值仍可能被as当字典返回；该函数不修复、迁移或锁文件，existsSync在try外。
function loadAuth(): Record<string, OAuthCredential> {
	// 没文件早返新空对象，不创建文件或目录。
	if (!existsSync(AUTH_FILE)) return {};
	// 保护读文件与JSON.parse步骤，不包括前面的存在判断。
	try {
		// 完整读UTF-8并JSON.parse，as不验证凭据标签/到期或对象形状。
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as Record<string, OAuthCredential>;
		// 读取/解码语法失败进入catch，原错误不向外报告。
	} catch {
		// 失败返回空表；之后登录若保存会以这份空表为起点，不保留坏文件内容。
		return {};
	}
}

// 同步保存整张凭据表到相对文件，无返回；先对已有文件chmod，再JSON.stringify覆写，新建mode=0600。
// 例更新某provider后写回全部表；不加密token、不做临时文件原子替换/锁/合并并发更新，权限/编码/写入错误直接抛，已改权限/已写部分不回滚。
function saveAuth(auth: Record<string, OAuthCredential>): void {
	// OAuth tokens: readable by the user only. `mode` applies when the file is created; chmod covers a file an older
	// version created, before the new tokens are in it.
	// 存在则先chmod到八进制0600（常规POSIX为用户读写）；文件系统/平台权限语义仍由宿主实现，存在到写之间不是事务。
	if (existsSync(AUTH_FILE)) chmodSync(AUTH_FILE, 0o600);
	// 序列化为2空格缩进后同步写入；mode只对新建文件生效，默认写模式可截断已有内容，循环等编码失败也会抛错。
	writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
}

// 接登录AuthPrompt并等用户回答，select展示编号后回选项id，其余类型复用普通question；返回Promise<string>。
// 例第二项id=device则输入2返回device；parseInt允许1abc等数字前缀，不做完整整数语法校验；secret/manual_code也不遮盖输入或遵循每提示signal。
async function answerPrompt(rl: ReturnType<typeof createInterface>, authPrompt: AuthPrompt): Promise<string> {
	// 联合标签只在select分支读取options；其他提示走最后普通文字输入。
	if (authPrompt.type === "select") {
		// 先输出换行及提示message，不对文字作终端控制码净化。
		console.log(`\n${authPrompt.message}`);
		// 按数组长度依次展示选项，index为0基。
		for (let index = 0; index < authPrompt.options.length; index++) {
			// 给用户显示1基编号和label，不显示id/description。
			console.log(`  ${index + 1}. ${authPrompt.options[index].label}`);
		}
		// await问题输入→十进制parseInt→减1作数组下标；空/非法前缀可得NaN，2abc可得下标1。
		const choice = Number.parseInt(await prompt(rl, `Enter number (1-${authPrompt.options.length}): `), 10) - 1;
		// 按解析下标取选项，越界或NaN通常undefined；不在此夹到有效范围。
		const selected = authPrompt.options[choice];
		// 没有选项就抛Error，async把它变返回Promise拒绝。
		if (!selected) throw new Error("Invalid selection");
		// 正常只回id，不回label/整项对象。
		return selected.id;
	}
	// 其他提示message加真值placeholder后问答；空placeholder不显示，无mask或prompt.signal透传。
	return prompt(rl, `${authPrompt.message}${authPrompt.placeholder ? ` (${authPrompt.placeholder})` : ""}: `);
}

// 按id实际登录内置OAuth Provider：查找→建readline→调用flow→读旧表/替换一项/写盘→输出位置，最后关readline。
// 例login("anthropic")才可能触发浏览器授权/设备码/换token等依赖行为；本CLI自己仅打印URL，不主动打开浏览器。
// 错误向上拒绝，finally只负责rl.close，不回滚已经完成的登录/权限修改/文件写入；没有持久复用设备ID或CLI取消控制。
async function login(providerId: string): Promise<void> {
	// 查当前筛过OAuth的Provider数组，find返回首个同id对象或undefined。
	const provider = PROVIDERS.find((entry) => entry.id === providerId);
	// 没找到直接抛错，还未创建终端输入接口。
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	// 创建真实stdin/stdout交互；从这里开始try/finally覆盖下面步骤，构造本身异常不由该finally清理。
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// 登录/保存/成功提示都在同一try，任一失败最后仍关闭rl。
	try {
		// This dev CLI does not persist an installation ID; apps should reuse one across logins.
		// 真正调用Provider OAuth方法并await凭据；lazy包装器会在此才加载具体flow，可能执行网络/本机回调服务。
		const credential = await provider.auth.oauth.login(
			// 第一实参是统一交互对象，包含必需signal和提示/通知回调。
			{
				// 新控制器只取signal，控制器引用没保留，所以本CLI不主动abort它。
				signal: new AbortController().signal,
				// 提示回调捕获本次rl，把各种AuthPrompt交上述有限问答器。
				prompt: (authPrompt) => answerPrompt(rl, authPrompt),
				// 同步通知回调接AuthEvent，只打印信息而不返回用户答案，console异常也可传播。
				notify: (event) => {
					// 按事件type分支，case中的break只退出switch，不结束整个登录流程。
					switch (event.type) {
						// 授权链接通知分支，不是HTTP回调已经成功。
						case "auth_url":
							// 仅向控制台打印event.url及提示，不调用openBrowser。
							console.log(`\nOpen this URL in your browser:\n${event.url}`);
							// 有真值instructions再另打一行，空串省略。
							if (event.instructions) console.log(event.instructions);
							// 本事件处理结束，等flow继续。
							break;
						// 设备码通知分支，与auth_url不是同一数据字段。
						case "device_code":
							// 显示验证网址，未在此fetch它或检查scheme。
							console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
							// 显示用户应输入的短码，不是拿这个短码直接当access token。
							console.log(`Enter code: ${event.userCode}`);
							// 退出设备码通知分支。
							break;
						// info和progress共享下一条打印逻辑，故此case故意无break。
						case "info":
						// 进度事件直接显示message。
						case "progress":
							// 不打印info.links等可选额外字段，仅输出message。
							console.log(event.message);
							// 结束这次通知处理，不停止flow的轮询/网络。
							break;
					}
				},
			},
			// 第二实参把randomUUID函数引用交getDeviceId；每次调用都可生成新ID，不在此持久存为同一安装身份。
			{ getDeviceId: randomUUID },
		);
		// flow已成功拿凭据后才读取相对磁盘表，不在持有存储锁的事务中登录。
		const auth = loadAuth();
		// 按原providerId覆盖这一项；as读来的表若不是可赋值对象，此处仍可能抛错，未深合并旧字段。
		auth[providerId] = credential;
		// 整张表同步保存，凭据不会因为前面login完成就自动落盘。
		saveAuth(auth);
		// 只有保存调用正常返回才打印成功位置，文字仍是相对auth.json。
		console.log(`\nCredentials saved to ${AUTH_FILE}`);
		// 无论try正常/拒绝都进入finally，finally里的关闭异常也可覆盖原错误。
	} finally {
		// 关闭readline接口，不等于主动关闭每个flow的回调服务或回滚认证。
		rl.close();
	}
}

// 顶层命令路由，无显式参数，读process.argv并返回Promise<void>；help/list打印，login可交互/联网/写文件。
// 例argv后缀["list"]只走列表分支；未识别命令抛错，外层catch负责打印并exit1，未提供独立CLI入口导出供安全import。
async function main(): Promise<void> {
	// slice(2)取运行时/脚本路径后参数，创建新数组，不修改process.argv。
	const args = process.argv.slice(2);
	// 第一个参数是命令，可undefined；这里只读取它，不自动解析--key=value。
	const command = args[0];
	// 无命令与三种帮助文字都走帮助，字符串大小写敏感。
	if (!command || command === "help" || command === "--help" || command === "-h") {
		// 把OAuth Provider id补到至少20个代码单元宽并拼name，LF连接；padEnd不按终端可见列宽，也不截长id。
		const providerList = PROVIDERS.map((provider) => `  ${provider.id.padEnd(20)} ${provider.name}`).join("\n");
		// 输出下一条完整使用说明。
		console.log(
			// 模板只插providerList，保留原帮助字符串；不因写出login字样而真的登录。
			`Usage: npx @earendil-works/pi-ai <command> [provider]\n\nCommands:\n  login [provider]  Login to an OAuth provider\n  list              List available providers\n\nProviders:\n${providerList}`,
		);
		// 帮助完成即返回，不继续其他分支。
		return;
	}
	// list仅精确小写匹配。
	if (command === "list") {
		// 逐个打印当前已装配OAuth Provider，不列只支持API key的Provider，不发认证有效性探测。
		for (const provider of PROVIDERS) console.log(`${provider.id.padEnd(20)} ${provider.name}`);
		// 列表分支结束。
		return;
	}
	// login命令进入实际认证入口，后续可以产生真实副作用。
	if (command === "login") {
		// 第二个参数可直接指定id，let允许后面菜单结果覆盖。
		let providerId = args[1];
		// 没给真值id才先让用户选Provider，不自动挑第一家。
		if (!providerId) {
			// 为Provider选择菜单另外建一次readline，选完关闭后login再建自己的接口。
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			// 保护菜单问答过程，确保正常进入try后最终close。
			try {
				// 遍历当前OAuth Provider选择项。
				for (let index = 0; index < PROVIDERS.length; index++) {
					// 显示1基编号与name，不返回id或读取凭据。
					console.log(`  ${index + 1}. ${PROVIDERS[index].name}`);
				}
				// 解析编号并减1，仍只认数字前缀，不要求整条输入为合法整数。
				const index = Number.parseInt(await prompt(rl, `Enter number (1-${PROVIDERS.length}): `), 10) - 1;
				// 可选链取id，越界/NaN给undefined，留后面统一Unknown provider错误。
				providerId = PROVIDERS[index]?.id;
				// 菜单问答成功/失败都关闭当前rl。
			} finally {
				// 关闭本轮选择接口，之后认证使用另一个rl。
				rl.close();
			}
		}
		// 没id或没有精确同id项就拒绝；some只检查是否存在，不重复创建Provider。
		if (!providerId || !PROVIDERS.some((provider) => provider.id === providerId)) {
			// 错误文字用??把undefined变空串；空字符串保持本身。
			throw new Error(`Unknown provider: ${providerId ?? ""}`);
		}
		// 明确await实际login及保存流程，未完成前main不返回成功。
		await login(providerId);
		// 登录命令完成后返回。
		return;
	}
	// 其余命令抛错误，async把它变main Promise拒绝。
	throw new Error(`Unknown command: ${command}`);
}

// 模块求值立即启动main，不是仅声明函数；catch消费该Promise拒绝，未另包所有模块加载异常。
main().catch((error: unknown) => {
	// Error取message，其他抛值String化，写stderr；自定义String/console自己仍可能抛错。
	console.error("Error:", error instanceof Error ? error.message : String(error));
	// 主动以退出码1结束进程，不等待所有异步资源自然收尾；不能为只检查类型而执行整个入口。
	process.exit(1);
});
