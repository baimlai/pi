#!/usr/bin/env bash
set -euo pipefail

# 文件导读：一次性维护脚本，把各包 src 下的相对导入说明符从 .js 改为 .ts。
# 所属：仓库根 scripts/，没有 npm script 或 CI 入口；由维护者在仓库根手动执行。
# 调用方式：`bash scripts/update-source-imports-to-ts.sh`，不需要参数，也不读取环境变量。
# 作用：TypeScript 的 rewriteRelativeImportExtensions 在编译输出时会把源码里的 .ts 说明符改回 .js；
#   因此源码统一写 .ts，运行时/发布产物仍是 .js。
# 副作用（高风险）：直接原地改写 packages/<pkg>/src 下所有 .ts 文件（perl -i），没有备份、没有 diff 预览。
#   运行前应提交或备份工作区；只改写形如 `from "./x.js"`、`import("./x.js")`、`declare module "./x.js"`、
#   `importNodeOnlyProvider("./x.js")` 的相对路径，绝对包名与外部依赖不受影响。
# 幂等性：已无 .js 相对说明符时第二次运行不会产生变化；但脚本不检查结果，也不会报告改了多少文件。
# 退出码：set -euo pipefail 下任一 find/perl 失败即非 0；成功时无输出、退出码 0。
# 能力清单：唯一动作是“发现 src 目录 → 找 .ts 文件 → 用 perl 正则批量替换”。
# 典型调用与预期：
#   示例 `cd <repo-root> && bash scripts/update-source-imports-to-ts.sh`；随后用 `git diff` 检查改动。
# 阅读顺序：先看 find 的深度限定，再看 while 循环如何收集文件，最后看 perl 的三条替换规则。
# 原英文说明保留如下：
# Rewrites relative source import specifiers in package source directories from .js to .ts.
# TypeScript's rewriteRelativeImportExtensions option rewrites these back to .js in emitted output.

# 上面第 2 行的 set -euo pipefail：-e 遇错退出，-u 引用未定义变量报错，-o pipefail 让管道中任一环节失败都使整条命令失败。
# 只匹配 packages/<name>/src 这一层：mindepth/maxdepth 2 排除 packages/src 与更深层的 src。
# -print0 用 NUL 分隔路径，避免文件名中的空格/换行破坏后续读取。
find packages -mindepth 2 -maxdepth 2 -type d -name src -print0 |
	# read -d '' 以 NUL 为分隔符读取目录路径；IFS= 与 -r 保留反斜杠和前后空白。
	# 循环体再找该 src 下所有 .ts 文件，同样用 NUL 分隔输出到管道。
	while IFS= read -r -d '' src_dir; do
		find "$src_dir" -type f -name '*.ts' -print0
	done |
	# xargs -0 按 NUL 拆分路径并交给 perl；perl 的 -0 把整个文件当一个字符串读入，
	# -p 自动逐文件循环打印，-i 原地改写（无备份后缀），-e 后是替换表达式。
	# 三条 s///g 规则分别覆盖：from/import 语句与动态 import、declare module、importNodeOnlyProvider。
	# 每条规则都把相对路径前缀（第 1 组）和结尾引号/括号（第 3 组）原样保留，只把中间的 `.js` 换成 `.ts`；
	# `\b` 防止匹配更长标识符的一部分，`(?:...)` 是非捕获分组，`["\x27]` 同时匹配双引号和单引号。
	xargs -0 perl -0pi -e 's/(\b(?:from|import)\b\s*\(?\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\)?)/$1$2.ts$3/g; s/(\bdeclare\s+module\s+["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27])/$1$2.ts$3/g; s/(\bimportNodeOnlyProvider\(\s*["\x27])(\.{1,2}\/[^"\x27\r\n]+)\.js(["\x27]\s*\))/$1$2.ts$3/g'
