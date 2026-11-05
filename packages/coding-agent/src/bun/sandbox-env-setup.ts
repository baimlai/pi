// Bun启动的环境副作用入口：导入修复函数后立即调用，让后面的启动模块读取修复后的环境。
// 例如cli.ts先依赖本模块，再依赖runtime-setup和共用CLI；只导入restore-sandbox-env本身不会自动修复。
import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// Restore the environment before evaluating modules that read it at startup.
// 模块求值即调用尽力恢复，无结果可等待/检查；非Bun或已有环境时函数立刻返回，不打开交互输入。
restoreSandboxEnv();
