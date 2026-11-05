#!/usr/bin/env bash
set -euo pipefail

# 文件导读
#
# 所属：仓库根目录的测试启动脚本，供本地与 CI 运行非 e2e 测试。
# 能力：创建隔离的临时 HOME/TMPDIR/XDG/npm 缓存；清理并白名单环境变量；在 env -i 中运行 npm test；退出时安全删除临时目录。
# 用法：./test.sh（不接受参数）。
# 上游：用户、CI 或贡献者；下游：在隔离环境中执行 `npm test`，即各包的完整测试命令。
# 退出码：继承 npm test 的退出码；清理失败会在原本成功时改为 1，且绝不静默删除未验证目录。
# 标准输出/错误：npm test 的输出原样显示，另有开始提示；清理拒绝或异常写 stderr。
# 副作用：在 $TMPDIR（默认 /tmp）下创建一次性 pi-test.XXXXXX 目录，作为 HOME、TMPDIR、XDG 与
# npm 缓存；退出时删除该目录。不会读写真实用户配置或凭证，但测试本身仍可能访问网络（除非被
# 测试级开关禁止）。
# 幂等性：每次运行创建新临时目录，脚本层面可重复；测试内容可能写仓库内生成物，需自行检查。
# CI：适合 CI；它清空环境变量并显式保留 CI/GITHUB_ACTIONS，避免本机 API key 激活 e2e 测试。
#
# 依赖：bash、mktemp、npm、git（用于 GIT_ASKPASS 探测）、标准 Unix 工具。
# 示例（真实调用）：
#   ./test.sh
#
# 建议阅读顺序：先看临时目录与所有权标记，再看 cleanup 的安全校验，最后看白名单环境变量与
# env -i 的最终执行。

# Isolate user resources, credentials, temporary files, and tool configuration.
# TMPDIR 可能以 / 结尾；去掉尾部斜杠，保证后面模板与 case 前缀比较一致。
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
# mktemp -d 原子地创建唯一目录并把路径写入 test_root；模板必须以 X 结尾。
test_root="$(mktemp -d "$temp_parent/pi-test.XXXXXX")"
# type -P 只在 PATH 中找外部命令，返回 false 可执行文件路径；若系统没有该文件，结果为空。
# 用作 GIT_ASKPASS：git 需要凭据时会执行它，而 false 立即失败，从而禁止交互式索要密码。
git_askpass="$(type -P false)"
# readonly 防止后续代码意外覆盖这三个安全关键变量。
readonly temp_parent test_root git_askpass

# 创建隔离的 HOME 配置目录、临时目录与 npm 缓存目录。
mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
# 标记文件用于清理前证明目录是本脚本创建的；两个 npm 配置文件先创建为空文件，避免 npm 读取真实配置。
touch "$test_root/.pi-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	# $? 是触发 trap 前的命令/脚本状态；必须在任何其他命令前保存。
	local status=$?
	# 先移除 trap，防止 cleanup 内的命令异常触发递归。
	trap - EXIT

	# 第一层校验：路径必须位于预期父目录且以 pi-test. 开头；模式加引号使前半段按字面匹配。
	case "$test_root" in
		"$temp_parent"/pi-test.*)
			# 第二层校验：确实是目录、不是符号链接、且带有本脚本创建的所有权标记。
			# ! -L 防止攻击者把标记目录替换成指向别处的链接后诱导 rm -rf。
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.pi-test-owned" ]]; then
				# -- 终止选项解析，避免以 - 开头的路径被当成 rm 参数。
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				# 如果原本成功，把状态改成 1，让清理异常可见；原本已失败则保留原状态。
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			# 路径前缀不符合预期时同样拒绝删除。
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	# 用保存的状态退出，等价于把 npm test 的退出码透传给调用者。
	exit "$status"
}
# EXIT trap 覆盖正常退出与 set -e 导致的退出；SIGKILL 等无法捕获的终止不会执行清理。
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
# 这是白名单：最终 `env -i` 会清空所有变量，只保留这些显式项，因此 API key、代理、用户级配置
# 都不会泄漏给测试进程。每项写成 NAME=value，数组元素之间不进行分词。
test_env=(
	# 保留 PATH 以找到 node/npm；保留 PWD 让部分工具认为当前目录未变。
	"PATH=$PATH"
	"PWD=$PWD"
	# Unix 与 Windows 的 home 变量都指向隔离目录。
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	# 三类临时目录变量名覆盖 macOS/Linux/Windows 习惯；全部落在测试根内。
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	# XDG 配置与缓存也隔离，避免读取真实主题/设置/缓存。
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	# 固定语言、区域与 UTC 时区，减少依赖本地化的输出差异。
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	# 禁止 git 读取系统/全局配置，并让任何凭据提示失败而不是挂起等待输入。
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	# npm 使用隔离的 user/global 配置与缓存，避免写入真实 ~/.npm 或 ~/.npmrc。
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	# 项目级开关：测试不自动加载本地 LLM；禁止访问 AWS 实例元数据（避免超时与凭证探测）。
	"PI_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
# 在 Windows 的 bash（如 Git Bash）下，这些系统变量缺失会导致子进程无法启动；仅在存在时复制。
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	# ${!name-} 是间接展开：读取名为 name 的变量的值；- 使未定义时得到空串而不是因 set -u 退出。
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Trust extra certificates of proxies that inspect HTTPS (corporate proxies, sandboxes).
# Network tests fail with self-signed certificate errors without it.
# 只转发已有值；不主动设置，也不读取文件内容。
value="${NODE_EXTRA_CA_CERTS-}"
[[ -z "$value" ]] || test_env+=("NODE_EXTRA_CA_CERTS=$value")

# Preserve CI detection only for runner behavior and test reporting.
# 仅保留这两个变量，让测试框架知道自己在 CI 中；其余 CI 凭证/变量不会进入白名单。
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# 提示也说明 API key 已被清空；HOME 路径可用于定位临时目录（退出后会被删除）。
echo "Running tests without API keys in isolated home: $test_root/home"
# env -i 从空环境开始，只注入 test_env 的项；npm test 的退出码由 trap cleanup 保存并透传。
env -i "${test_env[@]}" npm test
