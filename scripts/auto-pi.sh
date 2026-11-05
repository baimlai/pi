#!/usr/bin/env bash
# 文件导读
# 所属：仓库根 scripts/ 下的开发者启动包装器，不参与 npm 包发布，也不被产品代码导入。
# 职责：把符号链接安装成 `pi` 后，默认运行当前 checkout 的构建产物 packages/coding-agent/dist/bundle/cli.js；
#   加 --stable 或执行 `pi update` 时，改为在 PATH 中寻找真正的稳定版 pi。它不负责构建，构建必须另行运行 npm run build。
# 上游：用户 shell 直接执行，或通过 `ln -s "$PWD/scripts/auto-pi.sh" "$HOME/.local/bin/pi"` 安装（README 中也说明）。
# 下游：开发分支执行 dist/bundle/cli.js；稳定分支 exec PATH 中的另一个 pi。两条路径都用 exec 替换当前 shell。
# 能力清单：
#   script_path/script_dir/repo_dir：解析符号链接后的脚本位置与仓库根。
#   find_stable_pi：按 PATH 顺序找到第一个不是本包装器的可执行 pi。
#   args/use_stable：原样传递参数，只剔除 --stable，并把首个子命令 update 视为稳定版。
# 环境变量：PI_EXPERIMENTAL 仅在开发分支设置默认值 1（用户已设置时保留原值）；稳定分支不设置。
# 输入：命令行参数。输出：无自己的正常输出；错误写 stderr。副作用：仅 exec 目标进程，不写文件、不联网、不构建。
# 退出码：0 表示 pi 正常结束（exec 后由 pi 决定）；1 表示找不到稳定版 pi、开发构建缺失或参数/解析错误；
#   其余退出码来自被 exec 的 pi。文件可重复运行，没有持久状态。
# 示例：
#   ./scripts/auto-pi.sh --version          # 走开发构建
#   ./scripts/auto-pi.sh --stable --version # 走 PATH 中后面的稳定版
#   ./scripts/auto-pi.sh update             # update 自动使用稳定版
# 建议阅读顺序：先看符号链接解析，再看 find_stable_pi，最后看 --stable/update 分支与开发分支。
# set：-e 任一命令失败即退出，-u 使用未定义变量即报错，pipefail 让管道中任一环节失败都能被 -e 捕获。
set -euo pipefail

# Developer wrapper that runs pi from this checkout's latest `npm run build`.
# Development invocations use PI_EXPERIMENTAL=1 by default. Pass --stable to use
# the next pi executable on PATH; `pi update` also uses stable so self-update
# works.
#
# From the repository root, install with:
#   mkdir -p "$HOME/.local/bin"
#   ln -s "$PWD/scripts/auto-pi.sh" "$HOME/.local/bin/pi"
#
# ~/.local/bin must appear before the stable pi installation on PATH.

# Resolve this script through symlinks so repo_dir points at the development
# checkout rather than the directory containing the `pi` symlink.
# BASH_SOURCE[0] 是本脚本路径；用户通常把它软链到 ~/.local/bin/pi，所以要先解开软链。
script_path="${BASH_SOURCE[0]}"
# -L 测试路径是否为符号链接，每次循环把 script_path 推进到链接目标，直到得到真实文件。
while [[ -L "$script_path" ]]; do
	# cd -P 解析物理路径，pwd 输出绝对目录；dirname 只取所在目录。
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	# readlink 读取软链内容；它可能是绝对路径，也可能是相对当前链接目录的路径。
	link_target="$(readlink "$script_path")"
	# 以 / 开头表示绝对目标，直接采用；否则拼到链接所在目录后再进入下一轮。
	if [[ "$link_target" == /* ]]; then
		script_path="$link_target"
	else
		script_path="$script_dir/$link_target"
	fi
done
# 循环结束后取真实脚本所在目录；再往上一层即仓库根（scripts/auto-pi.sh 的父目录）。
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

# 输入：无参数，读取全局 PATH。输出：stdout 打印稳定版 pi 的绝对路径并返回 0；找不到返回 1。
# 副作用：只读目录与文件元数据，不启动任何进程。它在 PATH 中跳过本包装器自身，避免 exec 自己造成无限循环。
find_stable_pi() {
	# 声明局部变量，避免污染调用者作用域；local -a 声明数组。
	local path_entry candidate candidate_dir
	local -a path_entries
	# IFS=: 让 read 按冒号切分 PATH；-a 写入数组，-r 禁止反斜杠转义，<<< 是 here-string。
	IFS=: read -r -a path_entries <<< "${PATH:-}"
	for path_entry in "${path_entries[@]}"; do
		# PATH 中的空段按惯例表示当前目录，这里显式替换成 .。
		[[ -n "$path_entry" ]] || path_entry=.
		candidate="$path_entry/pi"
		# 必须存在、可执行且不是目录；任一不满足就 continue 看下一段。
		[[ -x "$candidate" && ! -d "$candidate" ]] || continue
		# -ef 比较设备号与 inode（并跟随软链）；若指向本脚本就跳过，防止递归调用。
		[[ "$candidate" -ef "$script_path" ]] && continue
		# 取候选文件所在目录的物理绝对路径；cd 失败则看下一个 PATH 段。
		candidate_dir="$(cd -P "$(dirname "$candidate")" && pwd)" || continue
		# 输出规范化后的绝对路径；basename 只保留文件名 pi。
		printf '%s/%s\n' "$candidate_dir" "$(basename "$candidate")"
		return 0
	done
	return 1
}

use_stable=false
# 先复制一份参数数组，只把 --stable 这个包装器专属开关摘掉，其余参数顺序保持不变。
args=()
for arg in "$@"; do
	if [[ "$arg" == "--stable" ]]; then
		use_stable=true
	else
		args+=("$arg")
	fi
done

# 首个子命令是 update 时强制走稳定版，否则自更新可能把开发 checkout 当成安装目标。
if [[ "${args[0]:-}" == "update" ]]; then
	use_stable=true
fi

if [[ "$use_stable" == true ]]; then
	# 命令替换取得路径；找不到时 find_stable_pi 返回非零，这里打印错误并退出 1。
	if ! stable_pi="$(find_stable_pi)"; then
		echo "error: could not find a stable pi executable after the auto-pi wrapper on PATH" >&2
		exit 1
	fi
	# ${args[@]+"${args[@]}"} 在数组为空时展开为空，避免 set -u 把空数组当成未定义变量；
	# exec 用 pi 替换当前 shell，之后的退出码就是 pi 的退出码。
	exec "$stable_pi" ${args[@]+"${args[@]}"}
fi

# 开发分支固定使用当前 checkout 的 bundle 入口，而不是另一个系统安装。
dev_pi="$repo_dir/packages/coding-agent/dist/bundle/cli.js"
# 文件不存在或不可执行时给出可操作的提示；这里不自动构建，避免隐式耗时操作。
if [[ ! -x "$dev_pi" ]]; then
	echo "error: development pi build not found; run \`npm run build\` in $repo_dir" >&2
	exit 1
fi

# ${VAR:-1} 只在变量为空或未定义时赋 1；用户显式设置（包括 0）会保留。
export PI_EXPERIMENTAL="${PI_EXPERIMENTAL:-1}"
exec "$dev_pi" ${args[@]+"${args[@]}"}
