# 文件导读
#
# 所属：仓库根目录的 Windows PowerShell 开发脚本，与 pi-test.sh 对应，从源码启动 pi CLI。
# 能力：解析 --no-env；移除选定的提供商环境变量；构造 source-resolver 的 file URL 并从源码启动 CLI；透传参数与退出码。
# 用法：.\pi-test.ps1 [--no-env] [CLI 参数...]；通常经 pi-test.bat 调用以绕过执行策略。
#   --no-env 在本次 PowerShell 进程中移除一批模型提供商环境变量，随后启动 node；不会修改系统
#   环境或用户配置文件，但会影响同进程中后续启动的子进程。
# 上游：用户、pi-test.bat 或开发脚本；下游：node 加载 source-resolver.ts 后执行
# packages/coding-agent/src/cli.ts。
# 退出码：node 退出码非零时显式 exit 相同值；为零时脚本自然结束（最后一条命令成功，退出码 0）。
# 标准输出/错误：透传 CLI 输出；--no-env 时额外向主机输出一行提示。
# 副作用：CLI 可能写会话/设置/缓存或调用模型；本脚本不创建文件、不安装依赖。
# 幂等性：脚本无持久状态，但 CLI 操作可能有副作用。
# 注意：本文件以 UTF-8 无 BOM 保存；Windows PowerShell 5.1 可能把中文注释显示为乱码，但注释
# 不参与执行，且 PowerShell 7 可正确读取。
#
# 示例（真实调用）：
#   .\pi-test.ps1 --no-env --help
#
# 建议阅读顺序：先看参数拆分，再看 --no-env 的变量表，最后看 URI 构造与退出码传递。

# 任何未处理错误都终止脚本；原生命令的非零退出码不会自动终止，因此后面还要检查 $LASTEXITCODE。
$ErrorActionPreference = "Stop"

# $MyInvocation.MyCommand.Path 是当前脚本路径；Split-Path -Parent 取所在目录。
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# --no-env 标记；$forwardArgs 只收集要传给 CLI 的参数（PowerShell 的 $args 是自动变量）。
$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

# -eq 对字符串默认不区分大小写；--no-env 与 --NO-ENV 都会被识别。
foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		# List[string].Add 原地追加，保持参数顺序。
		$forwardArgs.Add($arg)
	}
}

if ($noEnv) {
	# 数组中的名字会逐个从 Env: 驱动器删除。与 pi-test.sh 相比，此表只覆盖到
	# AZURE_OPENAI_RESOURCE_NAME，未包含 .sh 后续新增的 Anthropic 联邦、DeepSeek 等变量。
	$envVarsToUnset = @(
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"GEMINI_API_KEY",
		"GROQ_API_KEY",
		"CEREBRAS_API_KEY",
		"XAI_API_KEY",
		"OPENROUTER_API_KEY",
		"ZAI_API_KEY",
		"MISTRAL_API_KEY",
		"MINIMAX_API_KEY",
		"MINIMAX_CN_API_KEY",
		"AI_GATEWAY_API_KEY",
		"OPENCODE_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"HF_TOKEN",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GOOGLE_CLOUD_PROJECT",
		"GCLOUD_PROJECT",
		"GOOGLE_CLOUD_LOCATION",
		"AWS_PROFILE",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_REGION",
		"AWS_DEFAULT_REGION",
		"AWS_BEARER_TOKEN_BEDROCK",
		"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AZURE_OPENAI_API_KEY",
		"AZURE_OPENAI_BASE_URL",
		"AZURE_OPENAI_RESOURCE_NAME"
	)

	foreach ($name in $envVarsToUnset) {
		# 变量不存在时 Remove-Item 会报错；SilentlyContinue 让缺失项被忽略，脚本继续。
		Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
	}

	Write-Host "Running without API keys..."
}

# --import takes a module specifier, so pass the resolver as a file URL (Windows paths are not specifiers).
# System.Uri 把本地路径转成 file:///... 的 AbsoluteUri；反斜杠与盘符因此变成合法的模块说明符。
$resolverUrl = ([System.Uri](Join-Path $scriptDir "packages/coding-agent/src/experimental/source-resolver.ts")).AbsoluteUri
$cliPath = Join-Path $scriptDir "packages/coding-agent/src/cli.ts"
# & 调用外部命令；@forwardArgs 把列表展开成独立参数（splatting），保留每个元素的边界。
& node --import $resolverUrl $cliPath @forwardArgs
# 原生命令失败不会触发 $ErrorActionPreference；必须读取 $LASTEXITCODE 才能传播退出码。
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
