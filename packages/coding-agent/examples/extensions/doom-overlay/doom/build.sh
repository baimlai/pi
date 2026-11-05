#!/usr/bin/env bash
# Build DOOM for pi-doom using doomgeneric and Emscripten

# 文件导读（doom-overlay 的 WASM 构建脚本）
#
# 用途：把 ozkl/doomgeneric 的 DOOM 源码与同目录的平台适配层 `doomgeneric_pi.c` 编译成
# Emscripten 模块，供 `doom-engine.ts` 通过 `new Function` 加载。脚本不启动游戏。
# 能力：检查 emcc；按需克隆 doomgeneric；复制平台适配层；按分辨率编译 doom.js 与 doom.wasm。
#
# 调用方式（无命令行参数）：
#   ./doom/build.sh
#   DOOM_RESX=800 DOOM_RESY=500 ./doom/build.sh
# 环境变量：
#   DOOM_RESX / DOOM_RESY  输出分辨率，默认 640x400；会作为 C 宏传入构建。
# 前置条件：
#   - 已安装 Emscripten 的 `emcc`；缺失时脚本打印安装提示并以 1 退出。
#   - 首次运行需要 `git` 和网络，以下载 doomgeneric 上游仓库。
#   - 同目录必须存在 `doomgeneric_pi.c`。
#
# 输入/输出：
#   输入：本脚本、`doomgeneric_pi.c`、上游 doomgeneric C 源码。
#   输出：`doom/build/doom.js` 与 `doom/build/doom.wasm`（覆盖已有文件）。
#   stdout：进度、解析后的分辨率、完成提示；stderr：shell/emcc/git 自身的错误。
#
# 副作用与幂等性：
#   - 若 `doom/doomgeneric` 不存在，会 `git clone` 到源码目录内（网络 + 写工作区）。
#   - 每次运行都会把 `doomgeneric_pi.c` 覆盖复制到上游源码树。
#   - `mkdir -p build` 与重新编译可重复运行，但会覆盖构建产物；已存在的上游仓库不会更新。
#   失败时 `set -e` 立即停止，可能留下已创建目录或半写产物；需要重新运行脚本恢复。
#
# 退出码：
#   0 成功；1 缺少 emcc（显式退出）；其他非零来自 git/cp/emcc 等失败命令。
#
# CI/学习边界：
#   该脚本依赖外部网络和 Emscripten 工具链，不适合在普通单元测试中执行。生成物
#   `doom/build/doom.js` 是 Emscripten 输出，不要手改；调整导入/导出或分辨率应改本脚本后重建。
#
# 示例（真实命令）：
#   cd packages/coding-agent/examples/extensions/doom-overlay
#   ./doom/build.sh
# 预期最后一行：`Output: .../doom/build/doom.js and .../doom/build/doom.wasm`。
#
# 建议阅读顺序：先看目录变量与 emcc 检查，再看上游克隆/平台文件复制，最后看 emcc 参数分组
# （导出函数、内存/模块化、文件系统、分辨率宏、C 源文件列表）。

set -e

# BASH_SOURCE[0] 是本脚本路径；先 cd 到其目录再 pwd，得到不受调用者当前目录影响的绝对路径。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 示例根目录（doom-overlay），用于定位平台文件与构建目录。
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
# 这两项实际上都指向脚本所在目录：$PROJECT_ROOT/doom == $SCRIPT_DIR。
DOOM_DIR="$PROJECT_ROOT/doom"
BUILD_DIR="$PROJECT_ROOT/doom/build"

echo "=== pi-doom Build Script ==="

# Check for emcc
# command -v 只检查可执行文件是否在 PATH 中；没有版本号或兼容性检查。
if ! command -v emcc &> /dev/null; then
    echo "Error: Emscripten (emcc) not found!"
    echo ""
    echo "Install via Homebrew:"
    echo "  brew install emscripten"
    echo ""
    echo "Or manually:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk"
    echo "  cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source ~/emsdk/emsdk_env.sh"
    exit 1
fi

# Clone doomgeneric if not present
# 只判断目录存在，不验证它是不是完整仓库；不存在的第一次构建会联网克隆。
if [ ! -d "$DOOM_DIR/doomgeneric" ]; then
    echo "Cloning doomgeneric..."
    # 先进入脚本目录，确保 clone 的相对目标落在预期位置。
    cd "$DOOM_DIR"
    git clone https://github.com/ozkl/doomgeneric.git
fi

# Create build directory
# -p 使目录已存在时也成功，可重复运行。
mkdir -p "$BUILD_DIR"

# Copy our platform file
# 每次构建都覆盖上游源码树中的同名文件，把平台适配层（帧缓冲/按键/计时）接进去。
cp "$DOOM_DIR/doomgeneric_pi.c" "$DOOM_DIR/doomgeneric/doomgeneric/"

echo "Compiling DOOM to WebAssembly..."
# 切到上游的源码目录；下面的源文件列表都相对于这里。
cd "$DOOM_DIR/doomgeneric/doomgeneric"

# Resolution - 640x400 is doomgeneric default, good balance of speed/quality
# `${VAR:-默认值}` 在变量未设置或为空时使用默认值；分辨率会传给 C 编译宏。
RESX=${DOOM_RESX:-640}
RESY=${DOOM_RESY:-400}

echo "Resolution: ${RESX}x${RESY}"

# Compile with Emscripten (no sound)
# -O2 优化；反斜杠续行使整条 emcc 命令跨多行。
# 注意：shell 会先移除“反斜杠+换行”，因此不能在这些续行之间插入独立注释行，否则命令会被截断；
# 下面按用途解释各参数，参数本身保持原顺序：
#   -s WASM=1                         生成 WebAssembly；
#   -s EXPORTED_FUNCTIONS=...          只导出 doom-engine.ts 调用的 C 函数（前面带下划线）；
#   -s EXPORTED_RUNTIME_METHODS=...    暴露 getValue/setValue/FS 等运行时辅助方法；
#   -s ALLOW_MEMORY_GROWTH=1           允许 WASM 堆增长；
#   -s INITIAL_MEMORY=33554432         初始堆 32 MiB；
#   -s MODULARIZE=1                    导出工厂函数而不是立即执行；
#   -s EXPORT_NAME="createDoomModule"  工厂的全局名，与 doom-engine.ts 读取的模块导出一致；
#   -s ENVIRONMENT='node'              只支持 Node，不生成浏览器加载分支；
#   -s FILESYSTEM=1/-s FORCE_FILESYSTEM=1  启用虚拟文件系统，供 preRun 注入 WAD；
#   -s EXIT_RUNTIME=0/-s NO_EXIT_RUNTIME=1  main 返回后不退出运行时，游戏循环可继续；
#   -DDOOMGENERIC_RESX/RESY           把分辨率作为 C 宏传入；
#   -I.                                在当前上游源码目录查找头文件。
# 随后是上游 C 源文件列表与 `-o` 输出路径；源文件列表由 doomgeneric 的构建配置决定，
# 增删文件需要与上游版本匹配。emcc 还会在同目录生成/更新 doom.wasm。
emcc -O2 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="['_doomgeneric_Create','_doomgeneric_Tick','_DG_GetFrameBuffer','_DG_GetScreenWidth','_DG_GetScreenHeight','_DG_PushKeyEvent','_malloc','_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','FS']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=33554432 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME="createDoomModule" \
    -s ENVIRONMENT='node' \
    -s FILESYSTEM=1 \
    -s FORCE_FILESYSTEM=1 \
    -s EXIT_RUNTIME=0 \
    -s NO_EXIT_RUNTIME=1 \
    -DDOOMGENERIC_RESX="$RESX" \
    -DDOOMGENERIC_RESY="$RESY" \
    -I. \
    am_map.c \
    d_event.c \
    d_items.c \
    d_iwad.c \
    d_loop.c \
    d_main.c \
    d_mode.c \
    d_net.c \
    doomdef.c \
    doomgeneric.c \
    doomgeneric_pi.c \
    doomstat.c \
    dstrings.c \
    f_finale.c \
    f_wipe.c \
    g_game.c \
    hu_lib.c \
    hu_stuff.c \
    i_cdmus.c \
    i_input.c \
    i_endoom.c \
    i_joystick.c \
    i_scale.c \
    i_sound.c \
    i_system.c \
    i_timer.c \
    i_video.c \
    icon.c \
    info.c \
    m_argv.c \
    m_bbox.c \
    m_cheat.c \
    m_config.c \
    m_controls.c \
    m_fixed.c \
    m_menu.c \
    m_misc.c \
    m_random.c \
    memio.c \
    p_ceilng.c \
    p_doors.c \
    p_enemy.c \
    p_floor.c \
    p_inter.c \
    p_lights.c \
    p_map.c \
    p_maputl.c \
    p_mobj.c \
    p_plats.c \
    p_pspr.c \
    p_saveg.c \
    p_setup.c \
    p_sight.c \
    p_spec.c \
    p_switch.c \
    p_telept.c \
    p_tick.c \
    p_user.c \
    r_bsp.c \
    r_data.c \
    r_draw.c \
    r_main.c \
    r_plane.c \
    r_segs.c \
    r_sky.c \
    r_things.c \
    s_sound.c \
    sha1.c \
    sounds.c \
    st_lib.c \
    st_stuff.c \
    statdump.c \
    tables.c \
    v_video.c \
    w_checksum.c \
    w_file.c \
    w_file_stdc.c \
    w_main.c \
    w_wad.c \
    wi_stuff.c \
    z_zone.c \
    dummy.c \
    -o "$BUILD_DIR/doom.js"

echo ""
echo "Build complete!"
echo "Output: $BUILD_DIR/doom.js and $BUILD_DIR/doom.wasm"
