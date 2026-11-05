#!/usr/bin/env bash

# 在Linux宿主构建X11剪贴板C模块，按宿主架构选本包prebuilds目录；package.json的build:native:linux会启动此脚本。
# 输入主要是CC/TMPDIR环境和本机系统/架构，成功输出一个二进制及Built消息；会建临时目录、调用编译器、覆盖目标文件，不读取桌面剪贴板。
# 例如在Linux x86_64运行会选择linux-x64；不交叉编译两架构，不保证编译器/XCB开发库齐全，失败也不回滚已有prebuild。
# 首行shebang经env查找bash；这里用Bash数组/[[条件]]，不能当通用sh脚本。set的-e让普通未受条件测试等例外保护的失败终止脚本，-u拒绝展开未设置变量。
# -o pipefail让管道取最右侧非零状态；这些选项不是捕获一切错误，也不保证所有信号/强制终止时完成清理。
set -euo pipefail

# BASH_SOURCE[0]取本脚本路径，dirname取目录；$(...)在子shell中cd后取pwd，&&要求cd成功才继续，不改变调用者工作目录。
# 各层双引号保留路径空格；得到脚本所在目录，但不额外解析脚本文件本身的软链接。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ${CC:-cc}在CC未设或空串时用cc；引号使整个CC作为一个命令名，CC="cc -g"不会拆成编译器和额外参数。
compiler="${CC:-cc}"

# uname -s读取宿主系统名；[[... !=...]]非Linux就进入错误分支，不仅凭目标目录名猜平台。
if [[ "$(uname -s)" != "Linux" ]]; then
    # 诊断文字重定向到标准错误（>&2），不当成成功输出。
    echo "Linux native helpers must be built on Linux" >&2
    # 以状态1结束脚本；此时尚未创建build_dir，也未安装EXIT清理。
    exit 1
fi

# case按uname -m返回的本机架构逐分支匹配；这里只决定包目录标签，没有传跨架构--target参数，也不检查CC是否实际生成同架构文件。
case "$(uname -m)" in
    # x86_64模式匹配常见Intel/AMD 64位宿主。
    x86_64)
        # 转换成Node和资源目录使用的x64标签。
        arch="x64"
        ;;
    # |把aarch64与arm64列为同一个case分支的两个可选模式。
    aarch64|arm64)
        # 两种ARM64拼写都使用arm64目录标签。
        arch="arm64"
        ;;
    # *接住未列出的架构，前面每个;;表示处理当前分支后结束case，不继续落入下一分支。
    *)
        # 再次读取架构名写入标准错误，不尝试降级构建其他架构。
        echo "Unsupported Linux architecture: $(uname -m)" >&2
        # 拒绝不支持的架构并返回失败。
        exit 1
        ;;
esac

# command -v只定位这个命令名，不试编译、不验证版本或参数支持；!反转退出状态，使找不到时进then。
# >/dev/null丢标准输出，2>&1再把标准错误接到同一目的地，因此查找过程安静。
if ! command -v "$compiler" >/dev/null 2>&1; then
    # 找不到编译器时输出包含所选名称的错误。
    echo "Linux C compiler not found: $compiler" >&2
    # 以非零状态退出，不自动安装工具链。
    exit 1
fi
# mktemp -d按模板建唯一临时目录；TMPDIR未设/空用/tmp，XXXXXX由mktemp替换，中间文件位置仍受调用者TMPDIR配置影响。
# 命令替换只收集目录名，创建本身有磁盘副作用；失败时普通赋值命令也返回非零，尚未登记下面的trap。
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-linux.XXXXXX")"
# 登记shell退出时删除临时构建目录；单引号让$build_dir到EXIT回调执行时才展开，内部双引号把目录作为一个参数。
# 这是退出清理而非安装回滚：目标prebuild在别处；强制终止/删除失败等情形不能保证清理完成。
trap 'rm -rf "$build_dir"' EXIT

# Bash数组逐项保存公共编译/链接参数；括号内每行一个元素，之后用带引号的${common_flags[@]}逐项展开。
common_flags=(
    # 用C11语法模式处理C源码，不是使用C++编译器。
    -std=c11
    # 定义POSIX功能选择宏为200809L，控制系统头暴露的POSIX.1-2008接口，供时钟等函数声明使用。
    -D_POSIX_C_SOURCE=200809L
    # 启用编译器的一组常用警告；Wall并不包含所有可能警告。
    -Wall
    # 再开额外警告组，配合上面的Wall。
    -Wextra
    # 把已启用的警告按错误处理，因此它们也可导致构建失败。
    -Werror
    # 采用偏向缩小生成代码体积的优化级别，不表示关闭全部运行性能优化。
    -Os
    # 要求链接时优化LTO，编译器和链接器必须支持相应流程。
    -flto
    # 生成位置无关代码，适合装入Node进程的共享模块，不固定其装载地址。
    -fPIC
    # 请求编译器的POSIX线程支持选项，供私有pthread读取线程使用；标准库链接仍受后面的nostdlib影响。
    -pthread
    # 默认隐藏符号以减小对外暴露面；napi.h的PI_NAPI_EXPORT另显式导出Node注册入口。
    -fvisibility=hidden
    # 不生成栈保护器插桩，避免依赖相应运行时符号；这是生成选项，不代表执行了安全验证。
    -fno-stack-protector
    # 要求生成共享对象而非独立可执行程序，输出随后使用.node扩展名。
    -shared
    # 不自动加入通常的启动文件和标准库；显式-lxcb仍保留，不能理解成产物完全没有外部依赖。
    -nostdlib
    # -Wl,把逗号后的选项传给链接器；此项容许未解析符号留到装载环境解析，不保证运行时一定找得到。
    -Wl,--unresolved-symbols=ignore-all
    # 关闭链接器as-needed策略，显式请求的动态库不因当前引用判断而被省略。
    -Wl,--no-as-needed
    # 给链接器传O2优化等级，和前面控制编译器代码优化的-Os是两层设置。
    -Wl,-O2
    # 让链接器回收未使用的输入节；按节的可达性处理，不保证逐个删除所有未调用C函数。
    -Wl,--gc-sections
    # A timed-out private thread may outlive the Node environment that loaded us.
    # 给ELF标记NODELETE，避免卸载模块时撤掉仍在运行的私有线程所用代码；worker等待超时后线程可能继续，不是已强制杀线程。
    -Wl,-z,nodelete
    # 让链接器剥离符号等信息以缩小产物；不会改变上面显式要求的模块注册接口契约。
    -Wl,-s
)

# 把本次X11中间产物路径放在临时目录，还未修改包内prebuild。
x11_output="$build_dir/linux-platform-x11.node"
# 下面四个物理行是一条编译并链接命令：行尾反斜杠延续下一行，不能在续行中插独立#注释。
# 第1行执行所选编译器，并把common_flags数组的每个元素作为独立参数传入，不把全部选项合并成一个字符串。
# 第2行提供linux-platform-x11.c；它包含clipboard-worker.h，再包含共享clipboard.h/napi.h，而非另编这些头文件。
# 第3行-lxcb显式链接XCB库；需要编译期头文件/库和运行时兼容依赖，脚本不会自动下载它们。
# 第4行-o指定临时.node输出；失败时-e结束并触发已安装的EXIT清理，后面的安装不会执行。
"$compiler" "${common_flags[@]}" \
    "$script_dir/src/linux-platform-x11.c" \
    -lxcb \
    -o "$x11_output"

# 按先前识别的架构拼包内目录；native-platform.ts稍后按平台/进程架构查这里，不由本脚本require模块。
output_dir="$script_dir/prebuilds/linux-$arch"
# 递归建目标目录；已存在则保留，不清空其他架构或文件。
mkdir -p "$output_dir"
# 把编译结果安装/覆盖为固定文件名，模式755表示所有者可读写执行、其他人可读执行；不是包管理器安装依赖。
install -m 755 "$x11_output" "$output_dir/linux-platform-x11.node"
# 安装正常返回后打印路径；固定printf格式让路径只作%s数据，不证明Node能成功装载或读到剪贴板。
printf 'Built %s\n' "$output_dir/linux-platform-x11.node"
