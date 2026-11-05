// 文件导读
// 所属：仓库根 scripts/issues/ 的模块钩子注册入口，由 run.sh 以 node --import 预加载。
// 职责：调用 node:module 的 register()，把相邻的 source-hooks.mjs 注册为后续模块解析钩子。
// 能力：向当前 Node 进程注册 source-hooks.mjs 的异步模块解析钩子。
// 上游：scripts/issues/run.sh（node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts）。
// 下游：Node 加载 main.ts 及其 import 时经过 source-hooks.mjs 的 resolve 钩子。
// 输入：无命令行参数。输出：无 stdout。副作用：向当前 Node 进程注册异步 resolve 钩子；不启动服务器。
// 退出码：注册成功即返回（由被执行的入口决定后续退出码）；注册失败抛错导致进程非零退出。
// 示例：node --import ./scripts/issues/register.mjs scripts/issues/main.ts
// 建议阅读顺序：先看 register 的第二个参数（基准 URL），再看 source-hooks.mjs。
// 预加载入口：从 node:module 导入异步模块钩子的注册函数，没有自定义函数或认证逻辑。
import { register } from "node:module";

// 以当前模块 URL 为基准注册相邻 source-hooks.mjs；字符串说明符相对该基准解析。
// 例如 run.sh 的 --import 会先执行此行，再加载 main.ts；注册本身不启动 triage 服务器。
register("./source-hooks.mjs", import.meta.url);
