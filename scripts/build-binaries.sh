#!/usr/bin/env bash
# 文件导读
# 所属：仓库根 scripts/ 的本地发版构建脚本；对应 CI 的 .github/workflows/build-binaries.yml。
# 职责：安装依赖、构建全部包、用 Bun 编译六个平台的单文件 pi，再把运行时资源打进 tar.gz/zip 并解压一份用于本地测试。
# 上游：开发者手工运行 ./scripts/build-binaries.sh；CI 用相同参数调用。下游：npm ci、npm run build、bun build --compile、
#   cp/tar/zip/unzip，以及 packages/coding-agent 下的 dist 产物和 packages/tui 的原生预编译文件。
# 能力清单（主要步骤）：
#   1. 解析 --skip-install/--skip-build/--offline-model-data/--platform/--out。
#   2. 校验平台名；相对输出目录转成绝对路径。
#   3. npm ci --ignore-scripts（会重建 node_modules）与 npm run build / build:offline。
#   4. 清空并重建输出目录，逐平台执行 bun build --compile（x64 用 baseline 目标）。
#   5. 复制 package.json、README、CHANGELOG、wasm、主题、资源、HTML 导出模板、文档、示例和原生 prebuilds。
#   6. 生成 tar.gz/zip，统一使用 pi 包装目录，最后解压到 <out>/<platform> 供本地运行。
# 输入：命令行选项。输出：归档与解压目录，stdout 打印进度和最终路径。副作用：删除 node_modules（npm ci）、
#   递归删除输出目录、写大量文件；会执行编译和网络安装（除非 --skip-install）。可重复运行，但每次都会先删输出目录。
# 前置：Node/npm、Bun（--target 交叉编译）、tar/gzip、zip/unzip；需要已经能解析依赖。
# 退出码：0 全部成功；1 未知选项或非法平台；其他非零由 set -e 从失败命令直接传播（构建、复制、打包都可能中止）。
# 示例：
#   ./scripts/build-binaries.sh --skip-install --platform darwin-arm64
#   ./scripts/build-binaries.sh --offline-model-data --out /tmp/pi-binaries
# 建议阅读顺序：先看选项解析与平台校验，再看两条构建命令，最后看逐平台编译、资源复制和归档循环。
#
# Build pi binaries for all platforms locally.
# Mirrors .github/workflows/build-binaries.yml
#
# Usage:
#   ./scripts/build-binaries.sh [--skip-install] [--skip-build] [--offline-model-data] [--platform <platform>] [--out <dir>]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: packages/coding-agent/binaries)
#
# Output:
#   packages/coding-agent/binaries/
#     pi-darwin-arm64.tar.gz
#     pi-darwin-x64.tar.gz
#     pi-linux-x64.tar.gz
#     pi-linux-arm64.tar.gz
#     pi-windows-x64.zip
#     pi-windows-arm64.zip

# -e 任一命令失败即退出；-u 未定义变量报错；pipefail 让管道任一环节失败都可见。
set -euo pipefail

# 先切到脚本所在目录的上一级（仓库根），这样后续相对路径不依赖调用者的 cwd。
cd "$(dirname "$0")/.."

# 五个开关/值的默认状态；后面按参数覆盖。
SKIP_INSTALL=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
PLATFORM=""
OUTPUT_DIR=""

# 手写参数循环：$# 是参数个数，每次 shift 消耗一个或两个参数。
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            # 需要取下一个参数作为值，因此一次 shift 两个；缺少值时 $2 为空并会在下面校验失败。
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        *)
            # 未知参数直接失败，避免拼错选项后悄悄用默认值执行高成本的 npm ci。
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Validate platform if specified
# 只有显式给 --platform 时才检查；空字符串表示构建全部六个平台。
if [[ -n "$PLATFORM" ]]; then
    # case 枚举允许值；模式之间用 | 表示“或”。
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64, windows-arm64"
            exit 1
            ;;
    esac
fi

# 默认输出放在 coding-agent 包内；-z 判断字符串为空。
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="packages/coding-agent/binaries"
fi
# 以 / 开头视为绝对路径；否则相对当前仓库根（cd 之后的 pwd）拼成绝对路径，便于后面 cd 进输出目录。
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    # npm ci 会按 lockfile 重建整个 node_modules，并跳过生命周期脚本；它会先清空现有依赖目录。
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        # build:offline 让 ai 包使用仓库内置模型数据，不刷新远端目录，适合离线/可复现构建。
        npm run build:offline
    else
        echo "==> Building all packages..."
        # 常规构建可能刷新模型数据；发布产物依赖这里生成的 dist/。
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

echo "==> Building binaries..."
# 进入 coding-agent 包，因为 bun 的入口与资源路径都相对这个目录。
cd packages/coding-agent

# Clean previous builds
# 高风险：输出目录可能是用户用 --out 指定的任意路径，这里会递归删除它；空值已在上面补成默认目录。
rm -rf "$OUTPUT_DIR"
# 大括号展开一次创建六个平台目录，后续只填实际构建的平台。
mkdir -p "$OUTPUT_DIR"/{darwin-arm64,darwin-x64,linux-x64,linux-arm64,windows-x64,windows-arm64}

# Determine which platforms to build
# 数组元素用空格分隔；构建单个平台时只迭代一个值。
if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=(darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64 windows-arm64)
fi

for platform in "${PLATFORMS[@]}"; do
    echo "Building for $platform..."
    # Bun 的 --target 名称形如 bun-darwin-arm64，与输出目录名一致。
    bun_target="bun-$platform"
    # x64 使用 baseline CPU 目标，避免编译产物要求较新的指令集；arm64 不加后缀。
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. Bun places them at their path relative to the
    # common directory of all entrypoints, so the main entry must stay in dist/
    # for the worker specifiers in the runtime to resolve.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684). Disable cwd .env autoload so
    # project env files do not leak into pi's environment (see #10473).
    # Windows 与 Unix 的唯一差异是可执行文件扩展名；其余参数完全相同。
    # 三个入口一起传给 bun --compile：主 CLI 和两个 worker 会被嵌入可执行文件，运行时按相对路径解析。
    if [[ "$platform" == windows-* ]]; then
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --target="$bun_target" ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts --outfile "$OUTPUT_DIR/$platform/pi"
    fi
done

echo "==> Creating release archives..."

# Copy shared files to each platform directory
# 单文件可执行文件仍需外部资源：包清单用于版本/自更新，wasm 与主题/资源在运行时按相对路径加载。
for platform in "${PLATFORMS[@]}"; do
    cp package.json "$OUTPUT_DIR/$platform/"
    cp README.md "$OUTPUT_DIR/$platform/"
    cp CHANGELOG.md "$OUTPUT_DIR/$platform/"
    # Photon 是 WebAssembly 图像处理依赖，无法被 Bun 编进可执行文件，因此随包分发。
    cp ../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm "$OUTPUT_DIR/$platform/"
    mkdir -p "$OUTPUT_DIR/$platform/theme"
    # 交互主题 JSON 由构建输出提供；shell 通配符在源目录无匹配时会保留字面量并让 cp 失败。
    cp dist/modes/interactive/theme/*.json "$OUTPUT_DIR/$platform/theme/"
    mkdir -p "$OUTPUT_DIR/$platform/assets"
    cp dist/modes/interactive/assets/* "$OUTPUT_DIR/$platform/assets/"
    # HTML 导出的模板与样式在运行时读取，必须整目录复制。
    cp -r dist/core/export-html "$OUTPUT_DIR/$platform/"
    cp -r docs "$OUTPUT_DIR/$platform/"
    cp -r examples "$OUTPUT_DIR/$platform/"

    # Copy the selected architecture's native platform helpers next to the executable.
    # 把 windows-x64 映射成 win32-x64；${var%-*} 去掉最后一个 -arch 得到平台目录名。
    native_platform="${platform/windows-/win32-}"
    native_path="native/${native_platform%-*}/prebuilds"
    mkdir -p "$OUTPUT_DIR/$platform/$native_path"
    # TUI 的原生剪贴板/平台模块按 Node 平台名放在 prebuilds/<platform> 下。
    cp -R "../tui/$native_path/$native_platform" "$OUTPUT_DIR/$platform/$native_path/"
done

# Create archives
# 进入输出目录后，归档相对路径都指向这里的平台子目录。
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        # Windows (zip)
        echo "Creating pi-$platform.zip..."
        # 子 shell 里 cd，避免影响外层循环；zip -r 把当前平台目录内容写到上级归档。
        (cd "$platform" && zip -r ../pi-$platform.zip .)
    else
        # Unix platforms (tar.gz) - use wrapper directory for mise compatibility
        echo "Creating pi-$platform.tar.gz..."
        # 先把目录临时改名为 pi，使归档内顶层目录固定为 pi/，再改回平台名继续后续步骤。
        mv "$platform" pi && tar -czf pi-$platform.tar.gz pi && mv pi "$platform"
    fi
done

# Extract archives for easy local testing
# 解压回平台目录，方便直接运行刚生成的 pi；这一步会先删除同名的原始构建目录。
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if [[ "$platform" == windows-* ]]; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q ../pi-$platform.zip)
    else
        # tar 解出 pi/ 后重命名为平台目录，保持与 Windows 分支一致的目录布局。
        tar -xzf pi-$platform.tar.gz && mv pi "$platform"
    fi
done

echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
# 列出归档大小；若没有匹配文件，ls 返回非零，但 || true 保证脚本仍成功结束。
ls -lh *.tar.gz *.zip 2>/dev/null || true
echo ""
echo "Extracted directories for testing:"
for platform in "${PLATFORMS[@]}"; do
    if [[ "$platform" == windows-* ]]; then
        echo "  $OUTPUT_DIR/$platform/pi.exe"
    else
        echo "  $OUTPUT_DIR/$platform/pi"
    fi
done
