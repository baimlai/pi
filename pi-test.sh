#!/usr/bin/env bash
set -euo pipefail

# 文件导读
#
# 所属：仓库根目录的开发者脚本（POSIX bash），用于从源码启动 pi CLI，无需先构建 dist。
# 能力：解析 --no-env；清理选定的提供商环境变量；通过 source-resolver 预处理器从源码启动 CLI；透传参数与退出码。
# 用法：./pi-test.sh [--no-env] [CLI 参数...]
#   --no-env 会在本次脚本进程中清除一批模型提供商凭证，便于测试“没有 API key”的行为；node
#   随后启动并继承这个已清理的环境；它不修改调用者的 shell。
# 上游：直接由用户或开发脚本调用；下游：node 加载 source-resolver.ts 预处理器后执行
# packages/coding-agent/src/cli.ts。
# 退出码：最终继承 node CLI 的退出码；set -e 使 RESOLVER_URL 生成失败等命令也立即以非零退出。
# 标准输出/错误：原样透传给 CLI（交互界面或一次性命令）。
# 副作用：CLI 自身可能写会话、设置、缓存或调用模型；本脚本本身不建文件、不安装依赖。
# 幂等性：脚本没有持久状态，但 CLI 操作可能修改 ~/.pi 或项目文件，不能假定重复运行无副作用。
# CI：通常不用于 CI；CI/本地测试套件使用 test.sh 的隔离环境。
#
# 示例（真实调用）：
#   ./pi-test.sh --no-env --help
#
# 建议阅读顺序：先看参数拆分，再看 --no-env 的清理范围，最后看 resolver 与 node 启动方式。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for --no-env flag
# 布尔标记初始为 false；ARGS 收集要原样传给 CLI 的参数（不含 --no-env）。
NO_ENV=false
ARGS=()
# "$@" 保留每个参数的空格；不能写成 $*，否则含空格的参数会被拆开。
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    # += 追加一个元素；引号保证整个参数作为一个数组项。
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  # 这里逐个 unset 而不是清空为 ""：provider 通常用存在性/非空判断，空串与不存在并不总是等价。
  # 列表需与 env-api-keys.ts 支持的提供商保持同步；漏掉的变量仍可能被 CLI 读取。
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  unset ANTHROPIC_AUTH_TOKEN
  unset ANTHROPIC_FEDERATION_RULE_ID
  unset ANTHROPIC_IDENTITY_TOKEN_FILE
  unset ANTHROPIC_ORGANIZATION_ID
  unset ANTHROPIC_SERVICE_ACCOUNT_ID
  unset ANTHROPIC_WORKSPACE_ID
  unset ANT_LING_API_KEY
  unset BASETEN_API_KEY
  unset CLOUDFLARE_API_KEY
  unset DEEPSEEK_API_KEY
  unset FIREWORKS_API_KEY
  unset GOOGLE_CLOUD_API_KEY
  unset KIMI_API_KEY
  unset META_API_KEY
  unset MOONSHOT_API_KEY
  unset NVIDIA_API_KEY
  unset QWEN_TOKEN_PLAN_API_KEY
  unset QWEN_TOKEN_PLAN_CN_API_KEY
  unset RADIUS_API_KEY
  unset TOGETHER_API_KEY
  unset TYPESAFE_API_KEY
  unset XIAOMI_API_KEY
  unset XIAOMI_TOKEN_PLAN_CN_API_KEY
  unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
  unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
  unset ZAI_CODING_CN_API_KEY
  echo "Running without API keys..."
fi

# --import takes a module specifier, so pass the resolver as a file URL (raw paths break on #, ?, %).
# node -p 打印 pathToFileURL(...).href；process.argv[1] 是传给 node 的脚本参数（此处为 resolver 路径）。
# 用 file: URL 而不是裸路径，避免路径中出现 #、?、% 时被 URL/说明符解析截断。
RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/coding-agent/src/experimental/source-resolver.ts")"
# --import 在 CLI 模块加载前注册解析钩子，让 workspace 包名解析到源码。
# ${ARGS[@]+"${ARGS[@]}"} 是 bash 3.2（macOS 默认）兼容写法：数组为空时不展开，避免 set -u 报未绑定变量。
node --import "$RESOLVER_URL" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
