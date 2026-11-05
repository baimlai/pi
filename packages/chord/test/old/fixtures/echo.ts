import { num, obj, str } from "@earendil-works/pi-schema";
import { hostNamed, method, remote } from "../../../src/old/index.ts";

// 供父进程和子进程共享的远程契约：对象放在命名主机 w1 上，只有 main 变体。
// 这里只声明方法形状并计算契约描述，不启动进程，也不执行 echo；实际实现见 worker.ts。
export const Echo = remote("t.echo", {
	// 契约版本为 1，参与绑定与指纹比较。
	version: 1,
	// 输入对象没有声明字段；open 允许额外字段通过 schema，规范化仍按已知字段处理。
	input: obj({}, { open: true }),
	// 把对象位置声明为 w1，不是当前测试进程的名字。
	host: hostNamed("w1"),
	// variants 是远程可见接口的分组，由工厂返回的 variant 选择其中一种。
	variants: {
		// echo 接受并返回字符串；pid 无业务参数且返回数字。method 只定义签名，调用结果不会在这里校验。
		main: { methods: { echo: method(str(), str()), pid: method(undefined, num()) } },
	},
});
