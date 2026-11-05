#!/usr/bin/env bash
# 此入口真正运行后会启动本地HTTP服务、同步GitHub并调用配置模型；学习检查只做bash -n，不执行它。
# Start the issue triage server. Environment variables are documented in README.md.
# -e遇失败退出、-u未定义变量报错、pipefail让管道任一失败可见。
set -euo pipefail
# $0是入口脚本路径，dirname取scripts/issues目录；引号防空格拆分，../..切到仓库根。
cd "$(dirname "$0")/../.."
# exec用Node替换当前shell；source条件优先源码导出，--import先注册钩子，再执行TS主入口。
exec node --conditions=source --import ./scripts/issues/register.mjs scripts/issues/main.ts
