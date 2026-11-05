#!/usr/bin/env bash
# 文件导读
# 所属：仓库根 scripts/issues/ 的启动入口，封装 Node 运行参数。
# 职责：切换到仓库根，以源码条件 + 自定义模块解析钩子直接运行 TypeScript 入口 main.ts，无需先构建工作区包。
# 能力：定位仓库根；用 --conditions=source 与 --import 启动 main.ts；以 exec 透传进程与退出码。
# 上游：手动执行 scripts/issues/run.sh；README.md 与本脚本的环境变量说明见 main.ts 头部。
# 下游：node 加载 register.mjs（注册 source-hooks.mjs）→ main.ts 启动 Triage 与 HTTP 服务。
# 输入：无参数（环境变量由 main.ts 读取）。输出：继承 node/main.ts 的 stdout/stderr。
# 副作用：exec 后整个进程即 triage 服务（同步 GitHub、打开 SQLite、监听端口/socket）。
# 退出码：exec 替换 shell，node 的退出码即脚本退出码；set -e 使 cd 失败时立即以非零退出。
# 示例：scripts/issues/run.sh
# 建议阅读顺序：set 选项 → cd → exec 的参数顺序（--conditions、--import、入口）。
# 此入口真正运行后会启动本地 HTTP 服务、同步 GitHub 并调用配置模型；学习检查只做 bash -n，不执行它。
# Start the issue triage server. Environment variables are documented in README.md.
# -e 遇失败退出、-u 未定义变量报错、pipefail 让管道任一失败可见。
set -euo pipefail
# $0 是入口脚本路径，dirname 取 scripts/issues 目录；引号防空格拆分，../.. 切到仓库根。
cd "$(dirname "$0")/../.."
# exec 用 Node 替换当前 shell；--conditions=source 优先包的工具源码导出；
# --import 先注册模块钩子；最后才是 TS 主入口与它的参数。
exec node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts
