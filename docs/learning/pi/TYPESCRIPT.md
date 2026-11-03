# 结合 Pi 架构学习 TypeScript

先知道代码位于哪一层，再学语法。下面的讲解版摘自真实源码；加了中文注释，部分片段省略无关字段，不替代原文件。先读完第一节即可开始下一次带读。

## 第一课 从几行 CLI 入口开始

原文件：[cli.ts](../../../packages/coding-agent/src/cli.ts)。它位于 coding-agent 产品层。

```ts
#!/usr/bin/env node
// 第一行是命令行入口声明：直接运行这个文件时，用 Node 执行。
// 它不是 TypeScript 的类型语法。

// import：从另一个模块导入东西。
// 花括号表示“按名字导入”，这里导入的名字是 setupCli。
// from 后面的字符串是模块路径。
// ./ 表示当前文件所在目录。
// .ts 是源码文件扩展名；本仓库配置允许这样写。
import { setupCli } from "./cli/setup.ts";

// 再导入一个名叫 main 的函数。
// 导入函数本身和调用函数是两件事。
import { main } from "./main.ts";

// 函数名后加括号：调用这个函数。
// 空括号表示本次没有传入参数。
// 先做 CLI 初始化，再进入 main。
setupCli();

// process 是 Node 提供的进程对象，不是 Pi 自己定义的类型。
// process.argv 是启动进程时的参数数组。
// 前两项通常是 Node 可执行文件和脚本路径。
// slice(2) 返回从下标 2 开始的数组，不修改原数组。
// main 收到的是用户真正传入的参数。
main(process.argv.slice(2));
```

这段代码没有显式类型标注，也可以是合法 TypeScript。TypeScript 建立在 JavaScript 上，不要求每一行都出现类型。

练习：输入 node cli.ts --mode rpc 时，main 收到的数组是什么？答案是 `["--mode", "rpc"]`。

## 第二课 把函数签名读成一句话

来自 [sdk.ts](../../../packages/coding-agent/src/core/sdk.ts) 的 createAgentSession 声明。这里只展示签名，省略实现，因此使用 declare；原函数包含实际函数体。

```ts
// import type：这里只导入类型，运行时不会加载这个“类型值”。
// 这些类型描述 SDK 的输入和输出形状。
import type {
  CreateAgentSessionOptions,
  CreateAgentSessionResult,
} from "../../../packages/coding-agent/src/core/sdk.ts";

// export：允许其他模块导入它。
// declare：这里只声明存在这样的函数，不提供实现。
// options：参数名。
// 冒号后面的 CreateAgentSessionOptions：参数的类型。
// ? 表示这个参数可以省略；原实现用 = {} 提供默认空对象。
// Promise<T>：异步操作完成后产生一个 T 类型的结果。
// 尖括号里的类型参数说明“这个 Promise 最终装的是什么”。
export declare function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

原实现是 async function。async 让函数返回 Promise；await 等待异步结果。真正的调用通常放在另一个模块中：

```ts
// 导入真实函数；这是运行时需要的值，不是 import type。
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.ts";

// 调用时传入一个对象。
// 对象内字段写成“字段名: 值”，这里的冒号不是类型标注。
// cwd 表示当前工作目录；其余选项使用 SDK 的默认值。
// 这是可能涉及模型目录、配置和扩展加载的实际初始化，学习时先读，不自动执行。
const result = await createAgentSession({ cwd: process.cwd() });

// 点号用于读取对象属性。
const session = result.session;

// 对象解构可以把上一行取属性的过程写得更短。
// 这里从已经创建的 result 取值，没有再次创建会话。
const { extensionsResult } = result;

// session 和 extensionsResult 的类型通常能由编译器推断。
// 不用为了使用 TypeScript 给每一个变量重复写类型。
```

## 第三课 联合类型描述明确的选择

真实声明见 [agent/types.ts](../../../packages/agent/src/types.ts) 的 ToolExecutionMode 和 AgentTurnDecision。

```ts
// type：给一个类型起名字。
// 这里不是定义变量，也不是执行某种策略。
// | 表示“或者”。
// "sequential" 和 "parallel" 是字符串字面量类型。
// 值只能是这两个字符串中的一个，不能随便拼成 "paralell"。
export type ToolExecutionMode = "sequential" | "parallel";

// 两种对象形状组成联合类型。
// 通过 action 字段判断当前是哪种选择。
// 这叫带判别字段的联合类型：字段值帮助编译器区分分支。
export type AgentTurnDecision =
  | { action: "continue" }
  | { action: "end" };

// 下面是教学函数，不是从 Pi 原样复制的实现。
// 参数冒号后写输入类型，右括号后写返回类型。
function shouldContinue(decision: AgentTurnDecision): boolean {
  // === 是 JavaScript 的严格相等比较。
  // 类型约束在开发阶段检查，比较则真的在运行时发生。
  return decision.action === "continue";
}
```

架构联系：agent-loop 的 finishTurn hook 可以返回继续或结束的决定。类型只描述允许的决定；真正怎样继续，由循环实现执行。

## 第四课 回调把产品层接到通用循环

下面是 SDK 中 Agent 配置的简化讲解。结构与真实的 [sdk.ts](../../../packages/coding-agent/src/core/sdk.ts) 对应，但省略类型、初始化和其他字段，不能单独运行。

```ts
// new：创建类的实例。
// Agent 是通用运行器，具体模型服务由外部注入。
const agent = new Agent({
  // streamFn 是配置对象中的一个字段。
  // 字段值是 async 箭头函数。
  // (参数) => { 函数体 } 是另一种定义函数的语法。
  streamFn: async (model, context, options) => {
    // Agent 需要请求模型时，再调用这个函数。
    // modelRuntime 来自 SDK 所在的外层作用域。
    // 函数可以使用外层变量，这叫闭包。
    // 真实 SDK 在这里还会准备请求选项、处理缓存预热等。
    return modelRuntime.streamSimple(model, context, options);
  },
});
```

架构联系：这就是为什么通用 agent 不必自己创建 coding-agent 的配置、凭据或 UI。产品层把“怎么请求模型”作为函数交给它。第一次看到只要能识别“传入了一个稍后会被调用的函数”即可。

## 第五课 类型检查不代替输入校验

TypeScript 的 string、interface、type 等类型信息在运行时被擦除。模型发来的工具参数是外部数据；仅在源码中声明参数类型，不能保证模型真的发送正确值。

Pi 在 [agent-loop.ts](../../../packages/agent/src/agent-loop.ts) 的 prepareToolCall 中调用 validateToolArguments，再执行工具。校验实现经 [ai/utils/validation.ts](../../../packages/ai/src/utils/validation.ts) 使用 schema 能力。

记住两个不同阶段：开发时，TypeScript 帮助发现源码类型错误；运行时，schema 在外部输入边界检查真实数据。后续读工具时会用一个具体参数演示。

学习顺序：模块导入和函数调用 → 对象与类型标注 → 联合类型 → async/await → 回调和闭包 → 泛型。先跟架构走，遇到语法再展开。
