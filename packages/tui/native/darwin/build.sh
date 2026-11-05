#!/usr/bin/env bash

# 把Darwin平台Objective-C实现依次编为arm64/x64两个.node文件，供Node读取修饰键和剪贴板；package.json的build:native:darwin启动此脚本。
# 输入是CC/SDKROOT/TMPDIR环境与工具链，成功在prebuilds两目录安装产物并输出路径；会运行编译器和覆盖文件，不执行模块或访问系统剪贴板。
# 例如macOS配好Apple工具链时依次尝试arm64-macOS11和x64-macOS10.15目标；非Darwin也可用CC/SDKROOT配置交叉工具链，但脚本不保证它兼容。
# 首行shebang通过env查bash；本文件使用Bash数组与[[条件]]，不是任意sh都能解释。-e让普通未受条件测试等例外保护的失败终止，-u拒绝未设变量展开。
# -o pipefail让管道报告最右侧非零状态；这些开关并非统一异常捕获/事务，也不保证强制终止时做完清理。
set -euo pipefail

# 用BASH_SOURCE[0]定位脚本路径，dirname取目录；命令替换在子shell中cd且成功后pwd，不改变调用者当前目录。
# 双引号保留路径空格；没有额外解析脚本自身软链接，不能认为一定回到软链接目标文件旁。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 拼出Objective-C源文件路径；.m文件的#import/ARC/AppKit要求合适的Darwin工具链和SDK。
source_file="$script_dir/src/darwin-platform.m"

# -n检查字符串非空；${CC:-}使CC未设置也安全展开为空，不触发-u。
if [[ -n "${CC:-}" ]]; then
    # 非空CC直接作为整个编译器命令名；如要配置额外选项不能写成CC="clang -g"期待脚本拆词。
    compiler="$CC"
# 没有CC时，须本机uname为Darwin且command -v能找到xcrun才选此分支；&&右侧仅左侧成功才执行，查找输出丢弃。
elif [[ "$(uname -s)" == "Darwin" ]] && command -v xcrun >/dev/null 2>&1; then
    # 用xcrun查当前开发者工具链中的clang路径；这是实际子进程查询，失败的命令替换可使赋值失败而退出。
    compiler="$(xcrun --find clang)"
# 上述两种情况都不成立则走默认名称，不在这里禁止非macOS宿主。
else
    # 仅选择clang这个命令名；找到它也不代表支持macOS目标/SDK/链接器。
    compiler="clang"
fi

# command -v只查所选命令是否可定位；!将查找失败变成进入then的条件，不试编译。
if ! command -v "$compiler" >/dev/null 2>&1; then
    # 报告编译器不可定位到标准错误，>&2不让它混进正常输出。
    echo "Darwin C compiler not found: $compiler" >&2
    # 以状态1退出，不尝试自动安装clang或SDK。
    exit 1
fi

# 新建空Bash数组，意图是未配置SDK时不额外传选项；某些老Bash（如3.2）与-u组合时，展开空数组可报未设置变量，而非保证继续执行。
sdk_flags=()
# 非空SDKROOT优先，不论宿主是否Darwin；空串按未提供处理。
if [[ -n "${SDKROOT:-}" ]]; then
    # -d只检查路径指向目录（可跟随软链接），不验证所需SDK头文件/Frameworks是否齐全。
    if [[ ! -d "$SDKROOT" ]]; then
        # 路径不是目录时输出错误到标准错误，不继续换用自动发现SDK。
        echo "SDKROOT does not exist: $SDKROOT" >&2
        # 显式配置错误直接失败，尚未创建临时目录。
        exit 1
    fi
    # 数组含3项：-isysroot、SDK路径、合成的-F路径；-isysroot指定SDK系统根，-F增加其中Frameworks的搜索位置。
    # 两个路径都带引号，SDKROOT含空格仍各自保留为一个参数；这里只存选项，尚未发起编译。
    sdk_flags=(-isysroot "$SDKROOT" "-F$SDKROOT/System/Library/Frameworks")
# 没显式SDKROOT且宿主是Darwin时才自动找SDK；此分支本身不再检查xcrun存在。
elif [[ "$(uname -s)" == "Darwin" ]]; then
    # 请求xcrun给出macOS SDK路径；即使前面有CC，缺xcrun或查询失败也会在这里失败，不自动退回空数组。
    sdkroot="$(xcrun --sdk macosx --show-sdk-path)"
    # 把发现的SDK根和Frameworks搜索目录同样存成3个数组元素；不额外用-d验证返回路径。
    sdk_flags=(-isysroot "$sdkroot" "-F$sdkroot/System/Library/Frameworks")
fi

# mktemp -d在TMPDIR或缺省/tmp下建唯一目录；XXXXXX由工具替换，本次两架构共用该根目录。
# 若非Darwin且未设SDKROOT，上面保留空sdk_flags；后面须先能展开数组，再由交叉工具链决定有没有可用默认SDK。
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-darwin.XXXXXX")"
# 登记EXIT时递归删除临时目录；单引号推迟$temporary_dir展开，内部双引号保留空格。不能回滚已安装prebuild，也不能保证强制终止/删除失败时清理完成。
trap 'rm -rf "$temporary_dir"' EXIT

# 为一组架构标签和编译目标构建/安装单个模块；输入$1=目录标签、$2=目标三元组，无显式返回值，正常末条echo状态成为函数状态。
# 流程是建临时子目录→编译链接→建包目录→安装→打印；例如build arm64 arm64-apple-macos11.0对应darwin-arm64目录。
# 会读源与SDK并覆盖目标，不加载模块；失败在本脚本的直接调用上下文受-e中断，先前成功安装的另一架构不回滚，非原子双架构发布。
build() {
    # local创建函数局部变量，$1取本次第一个位置参数（如arm64），不改全局架构；缺参数在-u下会报错。
    local arch="$1"
    # 第二个位置参数给clang --target，不依据当前CPU隐式选择，函数不验证标签与目标相互一致。
    local target="$2"
    # 按标签选择包内prebuilds/darwin-架构目录，不现在写文件。
    local output_dir="$script_dir/prebuilds/darwin-$arch"
    # 临时输出也按标签隔开，两个架构不会共用同一个中间文件名。
    local temporary_output="$temporary_dir/darwin-$arch/darwin-platform.node"

    # dirname取临时文件父目录，mkdir -p递归创建；路径引号使空格不分成多个参数。
    mkdir -p "$(dirname "$temporary_output")"
    # 以下反斜杠续行构成一次编译并链接调用；每行末尾的反斜杠紧接换行，参数说明集中放在命令之前以免插注释截断续行。
    # "$compiler"执行选定命令；-fobjc-arc启用Objective-C对象的ARC自动引用计数，不替C malloc/free管理字节缓冲。
    # -std=c11指定Objective-C所基于的C语法标准；-Wall与-Wextra启用常用/额外警告，这里没有-Werror，警告本身未被统一升级为错误。
    # -Oz偏重更小代码体积；-flto启用链接时优化，实际支持取决于编译器和链接器。
    # -fvisibility=hidden默认隐藏符号；napi.h用PI_NAPI_EXPORT给Node的注册入口单独设默认可见性。
    # "--target=$target"把架构/平台/最低系统版本作为一个参数；例如arm64-apple-macos11.0，不等于已在那台系统验证运行。
    # "${sdk_flags[@]}"逐元素插入SDK选项而不重新拆路径；支持空数组与-u组合的Bash会在空数组时不插入参数，老版本可能在展开时就失败。
    # -bundle要求可装载的Mach-O bundle，而非独立程序；-undefined dynamic_lookup允许未定义符号由运行时装载环境解析，不保证符号一定存在。
    # -Wl,-dead_strip把不可达代码/数据裁剪选项传链接器；-Wl,-x省去非全局符号表项，和删除所有运行时导出不是一回事。
    # 三个-framework参数依次链接AppKit/CoreGraphics/Foundation：分别用于粘贴板/图片、修饰键状态以及NSString/NSData/URL等对象能力。
    # "$source_file"是唯一显式源文件；它包含共享clipboard.h/napi.h，不另编这些头；-o后的"$temporary_output"指定本架构临时.node文件。
    # 工具链/SDK/链接失败会使本次调用失败；脚本不下载依赖、不证明产物能被Node装载，也不在此调用剪贴板方法。
    "$compiler" \
        -fobjc-arc \
        -std=c11 \
        -Wall \
        -Wextra \
        -Oz \
        -flto \
        -fvisibility=hidden \
        "--target=$target" \
        "${sdk_flags[@]}" \
        -bundle \
        -undefined dynamic_lookup \
        -Wl,-dead_strip \
        -Wl,-x \
        -framework AppKit \
        -framework CoreGraphics \
        -framework Foundation \
        "$source_file" \
        -o "$temporary_output"

    # 编译成功才递归创建包内架构目录；存在时保留其他内容。
    mkdir -p "$output_dir"
    # install复制/覆盖目标模块并设755权限，即所有者读写执行、其他人读执行；不先做运行时测试，不是npm安装。
    install -m 755 "$temporary_output" "$output_dir/darwin-platform.node"
    # 安装返回成功后输出Built及目标路径；这条日志不保证模块加载、系统权限或剪贴板操作成功。
    echo "Built $output_dir/darwin-platform.node"
}

# 定义函数后才首次调用：先尝试arm64，目标最低macOS11.0；标签控制路径，目标字符串控制编译，两个参数角色不同。
build arm64 arm64-apple-macos11.0
# 第一架构流程正常返回后再尝试x64，目标最低macOS10.15；任一失败不自动删除先前已安装文件，也不生成合并的universal二进制。
build x64 x86_64-apple-macos10.15
