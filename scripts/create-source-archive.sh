#!/usr/bin/env bash
# 文件导读
# 所属：仓库根 scripts/ 的发布源码归档脚本，由 .github/workflows/build-binaries.yml 在 GitHub Release 构建中调用。
# 职责：以某个 release 提交为基准，额外加入被 .gitignore 忽略但参与二进制构建的“已生成模型数据”，
#   生成确定性的 pi-<version>/ 前缀 tar.gz；随后自检必需路径、路径前缀与禁止内容，并在临时目录解包运行模型数据检查。
# 上游：npm run hydrate:model-data（必须先执行，生成 packages/ai/src/providers/data）；CI 传入 RELEASE_TAG 去掉 v 的版本。
# 下游：build-binaries.sh 从该归档解包后构建各平台二进制；归档本身作为 release 资产上传。
# 输入（参数）：--version 必填且需等于 packages/coding-agent/package.json 的 version；--ref 默认 HEAD；--out 输出路径（相对路径按调用时 PWD 解析）。
# 输出：成功时最后一行打印归档绝对路径；失败时 stderr 说明原因。退出码：0 成功；1 参数/版本/数据缺失、校验失败或 git/tar 出错（set -e）。
# 副作用：读取 git 对象库；用临时 GIT_INDEX_FILE 写索引（不改当前索引/工作区）；创建临时归档/索引/清单/解包目录，EXIT trap 清理；
#   最终 mv 归档到 --out 并覆盖同名文件。确定性：同一提交与同一份模型数据产生相同内容（--mtime 用提交时间，gzip -n 去掉时间戳）。
# 幂等性：可重复执行，输出文件被替换；不修改仓库受跟踪文件。
# 示例：
#   npm run hydrate:model-data
#   ./scripts/create-source-archive.sh --version 0.60.0 --ref HEAD --out /tmp/pi-0.60.0-source.tar.gz
# 建议阅读顺序：参数解析与版本校验 → 模型数据检查 → 临时索引与 git archive → 清单校验 → 解包运行 check-model-data → 落盘。
#
# Create the deterministic source archive uploaded with GitHub releases.
#
# Usage:
#   npm run hydrate:model-data
#   ./scripts/create-source-archive.sh --version <version> --ref <git-ref> --out <archive.tar.gz>

# -e 任一命令失败即退出；-u 未定义变量报错；-o pipefail 让 git archive | gzip 的左侧失败也能被捕获。
set -euo pipefail

# 空串表示“未提供”；source_ref 默认 HEAD；output 为空时在参数检查阶段报错。
version=""
source_ref="HEAD"
output=""
# 记录调用时工作目录：相对 --out 路径应相对调用者，而不是脚本切换后的仓库根。
invocation_dir="$PWD"

# 打印用法到 stdout；参数错误时会重定向到 stderr 再调用。
usage() {
    echo "Usage: $0 --version <version> [--ref <git-ref>] --out <archive.tar.gz>"
}

# 输入：完整参数列表（$@）。检查 $1 选项后是否还有值，且值非空；否则报错、打印用法并以 1 退出。
# 在 case 分支里先以 "$@" 调用，此时 $1 是选项名、$2 是值。
require_value() {
    if [[ $# -lt 2 || -z "$2" ]]; then
        echo "$1 requires a value" >&2
        usage >&2
        exit 1
    fi
}

# 手写参数循环；未知选项直接失败，避免 CI 中拼写错误被静默忽略。
while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)
            require_value "$@"
            version="$2"
            shift 2
            ;;
        --ref)
            require_value "$@"
            source_ref="$2"
            shift 2
            ;;
        --out)
            require_value "$@"
            output="$2"
            shift 2
            ;;
        --help)
            usage
            # 帮助是成功路径。
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

# --version 与 --out 必填；--ref 有默认值。
if [[ -z "$version" || -z "$output" ]]; then
    usage >&2
    exit 1
fi

# 版本会进入归档前缀与路径，只允许字母数字开头及 [A-Za-z0-9._-]，防止 ../ 或空格等异常路径。
if [[ ! "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]*$ ]]; then
    echo "Invalid version: $version" >&2
    exit 1
fi

# 无论从哪个目录调用，后续 git 命令都在仓库根执行；dirname "$0" 支持通过相对路径调用。
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

# --end-of-options 让以 - 开头的 ref 不被当作选项；^{commit} 把标签/短哈希解析成提交对象。
commit="$(git rev-parse --verify --end-of-options "${source_ref}^{commit}")"

# 用管道把指定提交中的包清单交给 node 解析；readFileSync(0) 读取 stdin，避免临时文件。
package_version="$(git show "${commit}:packages/coding-agent/package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
# 版本不一致通常意味着 RELEASE_TAG 与源码未同步，归档会命名错误，直接失败。
if [[ "$package_version" != "$version" ]]; then
    echo "Version ${version} does not match package version ${package_version} at ${source_ref}" >&2
    exit 1
fi

# 相对输出路径先拼回调用目录，再统一转成绝对路径；后续 cd 才不会改变输出位置。
if [[ "$output" != /* ]]; then
    output="$invocation_dir/$output"
fi
mkdir -p "$(dirname "$output")"
# cd 到输出目录再 pwd，可规范化 . 与 ..；basename 保留文件名。
output="$(cd "$(dirname "$output")" && pwd)/$(basename "$output")"

# 生成数据被 gitignore，但两个二进制构建需要它；缺失说明调用前没跑 hydrate。
model_data_dir="packages/ai/src/providers/data"
if [[ ! -f "${model_data_dir}/.manifest.json" ]]; then
    echo "Generated model data is missing. Run npm run hydrate:model-data first." >&2
    exit 1
fi

# nullglob 让无匹配的 *.json 展开为空数组，而不是字面量；随后关闭以恢复默认行为。
shopt -s nullglob
model_data_files=("${model_data_dir}/.manifest.json" "${model_data_dir}"/*.json)
shopt -u nullglob
# 数组只有 manifest 一项时说明没有任何供应商 JSON（正常应有多份）。
if [[ ${#model_data_files[@]} -eq 1 ]]; then
    echo "Generated model data is missing from ${model_data_dir}" >&2
    exit 1
fi

# 所有临时文件都放在输出文件旁边（同文件系统），最后 mv 是原子替换。
temporary_archive="$(mktemp "${output}.tmp.XXXXXX")"
temporary_index="$(mktemp "${output}.index.XXXXXX")"
manifest="$(mktemp "${output}.manifest.XXXXXX")"
validation_root="$(mktemp -d "${output}.validation.XXXXXX")"
# mktemp 已创建索引文件，但 git read-tree 要求路径不存在或为空索引；删除后由 git 创建。
rm -f "$temporary_index"
# EXIT trap 在成功与失败时都清理临时文件与解包目录；成功路径末尾会替换成不删除归档的版本。
trap 'rm -f "$temporary_archive" "$temporary_index" "$manifest"; rm -rf "$validation_root"' EXIT

# Add the ignored release model-data snapshot to a temporary index based on the
# release commit. Archiving the resulting tree keeps the source artifact
# deterministic for the same commit and generated model data.
# 用独立的 GIT_INDEX_FILE 以提交树初始化索引；不触碰仓库当前索引。
GIT_INDEX_FILE="$temporary_index" git read-tree "$commit"
# -f 强制加入即使被 .gitignore 忽略的模型 JSON；路径相对于仓库根。
GIT_INDEX_FILE="$temporary_index" git add -f -- "${model_data_files[@]}"
# 把索引写成树对象；后续 git archive 直接归档树，不再读工作区。
archive_tree="$(GIT_INDEX_FILE="$temporary_index" git write-tree)"
# 用提交时间（Unix 秒）作为归档内所有文件的 mtime，消除构建时刻差异。
archive_mtime="$(git show -s --format=%ct "$commit")"

archive_root="pi-${version}"
# --prefix 让解包后得到单一目录；gzip -n 不写文件名/时间戳，-9 最大压缩。
git archive --format=tar --prefix="${archive_root}/" --mtime="@${archive_mtime}" "$archive_tree" \
    | gzip -n -9 > "$temporary_archive"
# 归档内路径清单，供后续 grep/awk 校验。
tar -tzf "$temporary_archive" > "$manifest"

# 二进制构建与类型生成依赖这些文件；缺任何一个都在构建早期失败，而不是发布后才发现。
required_paths=(
    "package.json"
    "package-lock.json"
    "scripts/build-binaries.sh"
    "packages/ai/src/models.generated.ts"
    "packages/ai/src/providers/data/.manifest.json"
    "packages/tui/native/napi.h"
    "packages/tui/native/clipboard.h"
    "packages/tui/native/darwin/src/darwin-platform.m"
    "packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node"
    "packages/tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node"
    "packages/tui/native/linux/build.sh"
    "packages/tui/native/linux/src/linux-platform-x11.c"
    "packages/tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node"
    "packages/tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node"
    "packages/tui/native/win32/src/win32-platform.c"
    "packages/tui/native/win32/prebuilds/win32-arm64/win32-platform.node"
    "packages/tui/native/win32/prebuilds/win32-x64/win32-platform.node"
    "packages/coding-agent/package.json"
    "packages/coding-agent/src/utils/image-resize-worker.ts"
    "packages/coding-agent/src/core/export-html/template.css"
)

# -F 按固定字符串、-x 整行、-q 静默；路径必须与清单行完全一致。
for path in "${required_paths[@]}"; do
    if ! grep -Fxq "${archive_root}/${path}" "$manifest"; then
        echo "Source archive is missing required path: $path" >&2
        exit 1
    fi
done

# 每行必须以 pi-<version>/ 开头（防止绝对路径或 ../ 逃逸）；任一不满足则 awk 以 1 退出。
if ! awk -v prefix="${archive_root}/" 'index($0, prefix) != 1 { exit 1 }' "$manifest"; then
    echo "Source archive contains a path outside ${archive_root}/" >&2
    exit 1
fi

# 归档必须只含源码：node_modules 与预编译 binaries 由构建流程另行处理，混入会让源码包不可复现且体积过大。
if grep -Eq '(^|/)node_modules/|(^|/)packages/coding-agent/binaries/' "$manifest"; then
    echo "Source archive contains generated dependencies or binaries" >&2
    exit 1
fi

# 真正解包到临时目录并运行模型数据一致性检查；只有检查通过才发布归档。
tar -xzf "$temporary_archive" -C "$validation_root"
node "${validation_root}/${archive_root}/packages/ai/scripts/check-model-data.ts"

# 校验全部通过后才把临时归档原子移动到最终输出；同名文件被替换。
mv "$temporary_archive" "$output"
# 重置 trap：归档已是最终产物，只清理索引/清单/解包目录。
trap 'rm -f "$temporary_index" "$manifest"; rm -rf "$validation_root"' EXIT
# 最后一行打印绝对路径，便于 CI 捕获。
printf '%s\n' "$output"
