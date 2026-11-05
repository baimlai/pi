#!/usr/bin/env node
// 可执行命令的最薄入口。操作系统按首行 shebang 找 Node，Node 再加载这些 ESM 模块。
// 例：pi -p "解释 README" → setupCli 设置进程环境 → main 收到 ["-p", "解释 README"]。
// import 是模块加载声明；导入不等于调用，被导入模块自身的顶层代码仍会在加载时执行。
import { setupCli } from "./cli/setup.ts";
// main 管理参数、配置、模型和运行模式；本文件不直接请求模型。
import { main } from "./main.ts";

// 先设置进程标识与 HTTP dispatcher，保证主流程发请求前完成基础准备。
setupCli();
// process.argv 前两项通常是 Node 路径和入口文件；slice(2) 复制后面的真实用户参数。
// main 是异步函数，此入口直接启动它；这里没有再额外建立一层聊天循环。
main(process.argv.slice(2));
