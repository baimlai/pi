// 预加载入口：从node:module导入异步模块钩子的注册函数，没有自定义函数或认证逻辑。
import { register } from "node:module";

// 以当前模块URL为基准注册相邻source-hooks.mjs；后续工作区import才会经过其resolve钩子。
// 例如 run.sh 的 --import 会先执行此行，再加载main.ts；注册本身不启动triage服务器。
register("./source-hooks.mjs", import.meta.url);
