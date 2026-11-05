// 提供 Windows 原生控制台输入设置、修饰键状态与异步文本/图片剪贴板操作；build.mjs 把本手写 C 文件编译成两个架构的 .node。
// N-API 是 JS 运行时提供给原生模块的接口。加载时先注册 JS 导出；键盘方法被直接调用，剪贴板方法经 clipboard.h 建任务，在工作线程执行 clipboard_execute，再回 JS 线程完成 Promise。
// C 的指针/整数类型参与真实内存与 ABI（函数参数、返回及调用方式的二进制约定）调用；错误常写进 job，由共享完成回调转换为 Promise 拒绝。
// DIB 是不含 BMP 文件头的位图内存格式；这里可为它补头得到 BMP 字节。CRT 指 C 运行库，下面的手动复制配合构建脚本减少对它的依赖。
// 预处理宏在包含头文件之前开启写入/复制支持，使 clipboard.h 提供 setText 和 clipboard_copy 实现；不是运行时开关。
#define PI_CLIPBOARD_WRITE
// 相对 include 取得 clipboard_job、内存/异步任务工具及 N-API 桥接声明；该头再引入 napi.h 和 Windows 系统类型。
#include "../../clipboard.h"

// 条件编译：只有 Windows 头未定义这个常量时才提供后备值，避免重复定义。
#ifndef BI_ALPHABITFIELDS
// 数值 6 表示带 alpha 位掩码的 DIB 压缩标识，后面计算像素偏移时使用。
#define BI_ALPHABITFIELDS 6
// 结束该预处理条件；此结构由编译预处理器处理，不是函数里的 if 分支。
#endif

// 十六进制 0x8000 只取 GetAsyncKeyState 返回值的最高位，判断查询时该键是否按下。
#define KEY_PRESSED_MASK 0x8000
// 打开剪贴板最多调用 10 次，不能把重试次数等同于严格时间上限。
#define OPEN_CLIPBOARD_ATTEMPTS 10
// 每次失败后 Sleep 请求等待 5 毫秒；最后一次失败也会等，实际唤醒还受系统调度影响。
#define OPEN_CLIPBOARD_RETRY_MS 5
// BMP 文件头占 14 字节；剪贴板 DIB 数据不含它，返回 BMP 字节时在前面补上。
#define BITMAP_FILE_HEADER_SIZE 14

// 比较两个以 NUL（值为0的终止字符）结尾的字节串，完全相等返回 1，否则 0；逐字节前进，不分配内存、不忽略大小写。
// 例：shift 与 shift 相等，Shift 与 shift 不等。调用方须提供有效可读、已终止字符串；没有空指针或长度检查。static 把函数限定在本编译单元，即本 C 文件与包含的头展开后的范围内。
static int string_equals(const char* left, const char* right) {
    // *left 和 *right 分别读取当前指针所指字符；短路 && 先要求两边非零，再比较当前字节，遇结尾或差异就停。
    while (*left && *right && *left == *right) {
        // 递增指针变量到下一个 char；const char* 禁止经此指针改字符，但不禁止移动指针本身。
        left++;
        // 右侧指针同步前进一个字符。
        right++;
    }
    // 只有停下时两边都到 NUL 才相等；C 的 && 表达式结果为 int 类型的 0 或 1。
    return *left == 0 && *right == 0;
}

// 查询一个 Windows 虚拟键码的当前高位状态，返回 0/1，无 JS 对象创建；例：VK_SHIFT 查询 Shift。
// GetAsyncKeyState 是系统状态快照，不是解析输入文本；0 也可能与系统无法提供该状态有关，这里不区分原因。
static int is_key_pressed(int virtual_key) {
    // 先把有符号 SHORT 结果转 unsigned short，再用按位 & 取高位，!=0 归一为真假；不使用低位的历史按键标记。
    return ((unsigned short)GetAsyncKeyState(virtual_key) & KEY_PRESSED_MASK) != 0;
}

// 将约定的修饰键名字映射为一组虚拟键查询，任一命中返回真，未知名字返回 0；不修改键盘状态。
// 例：option/alt 走同一组 Alt 键，command/super/win 走 Windows 键；名字比较区分大小写，参数须是有效 NUL 字符串。
static int is_modifier_name_pressed(const char* name) {
    // shift 匹配时按短路 || 依次查通用、左、右 Shift；已经命中就不继续查后面。
    if (string_equals(name, "shift")) return is_key_pressed(VK_SHIFT) || is_key_pressed(VK_LSHIFT) || is_key_pressed(VK_RSHIFT);
    // control 对应 Ctrl 通用/左右键；名字不是 ctrl，此处没有另加该别名。
    if (string_equals(name, "control")) return is_key_pressed(VK_CONTROL) || is_key_pressed(VK_LCONTROL) || is_key_pressed(VK_RCONTROL);
    // option 或 alt 名称共用 VK_MENU 系列的 Alt 键；|| 不是同时等待三个键。
    if (string_equals(name, "option") || string_equals(name, "alt")) return is_key_pressed(VK_MENU) || is_key_pressed(VK_LMENU) || is_key_pressed(VK_RMENU);
    // 三个 Windows 键别名都查左/右 Windows 键，不把它们当 macOS 系统调用。
    if (string_equals(name, "command") || string_equals(name, "super") || string_equals(name, "win")) return is_key_pressed(VK_LWIN) || is_key_pressed(VK_RWIN);
    // 所有已知名字都未匹配时返回假，不抛“未知修饰键”错误。
    return 0;
}

// N-API 同步入口：从当前标准输入句柄取控制台模式，加上 VT 输入位，再返回 JS 布尔值；不读取键盘字节。
// 例：非控制台 stdin 导致 GetConsoleMode 失败时通常返回 false；只有 JS 布尔值构造失败才走 fail。成功会改变控制台模式，本函数不恢复旧模式。
// __cdecl 是此回调的调用约定；env 是运行时上下文，info 为本次调用信息，napi_value 是运行时值句柄而非 C bool。
static napi_value __cdecl enable_virtual_terminal_input(napi_env env, napi_callback_info info) {
    // 显式把未使用的调用信息转换为 void，表达有意忽略，不释放或清空它。
    (void)info;

    // 取得进程标准输入句柄，不在这里打开新终端；HANDLE 是系统定义的句柄类型。
    HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
    // DWORD 模式位先置 0，再由 GetConsoleMode 经地址参数写入。
    DWORD mode = 0;
    // 把三步短路检查的最终结果存成 C bool；第一步只排除 INVALID_HANDLE_VALUE，其他无效情况交给后续 API 失败处理。
    bool enabled = handle != INVALID_HANDLE_VALUE &&
        // &mode 是取变量地址供系统写回模式；失败时不执行下一步设置。
        GetConsoleMode(handle, &mode) &&
        // 按位 | 保留原有模式位并加入 ENABLE_VIRTUAL_TERMINAL_INPUT；不是覆盖为单独一个标志。
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);

    // 按名字从宿主运行时动态找 N-API 函数地址，并转为对应函数指针类型；不链接某个固定 Node 库，空指针仍需检查。
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    // 0 在指针上下文表示空指针；先以空句柄初始化 JS 返回值，稍后通过 &result 输出参数接收布尔值。
    napi_value result = 0;
    // 符号不存在时短路，或调用 N-API 返回非零状态时，进入构造返回值失败分支；enabled=false 本身不是这个错误。
    if (!napi_get_boolean || napi_get_boolean(env, enabled, &result) != 0) {
        // 共享 fail 尝试抛 JS 错误并返回 undefined；若连抛错符号也不可用，不能保证真的抛出。
        return fail(env, "Could not configure console input");
    }
    // 返回已创建的 JS true/false，调用方据它判断模式设置是否成功。
    return result;
}

// N-API 同步修饰键入口：尝试取得第一个字符串参数、转成小缓冲区里的 UTF-8 名字，再按别名查键并返回 JS bool。
// 例：传 shift 会查 Shift；缺参数/转换失败会保留 false，不单独报参数错误。布尔返回值构造失败才调用 fail，无异步任务。
static napi_value __cdecl is_modifier_pressed(napi_env env, napi_callback_info info) {
    // 动态获取读取 JS 回调参数的函数指针，函数名变量保存的是可调用地址而非执行结果。
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    // 声明 UTF-8 转换函数指针，赋值表达式在下一行继续。
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 =
        // 查符号并作 C 函数指针强制转换；这不验证宿主实现是否真的符合此 ABI。
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    // 再取创建 JS 布尔值的符号，最终返回阶段会检查。
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    // 默认未按下；任何参数准备检查未通过都保留它。
    bool pressed = false;
    // 只有两个读参符号都存在才尝试读取；这里不因为少了读参函数就抛错。
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        // 声明最多接收一个参数的缓冲容量，通过 &argc 传给 N-API；不要求 JS 恰好只传一个参数。
        size_t argc = 1;
        // 在栈上建一个 napi_value 槽位并清零；这是固定长 C 数组，不是 JS 数组。
        napi_value args[1] = {0};
        // 调用成功、至少有一个参数且句柄非空，才继续；最后两个 0 表示不取 this/附加数据。
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            // 16 字节局部字符数组全置零，存放转换的名字；不是 16 个 Unicode 字符的容量。
            char name[16] = {0};
            // 记录 N-API 报告的复制长度，类型 size_t 用于字节数；后面没有再用它检查截断。
            size_t copied = 0;
            // sizeof(name) 在这里求固定数组的字节容量16；向缓冲区取 UTF-8，状态为 0 才查名字，没有另验完整输入是否被截断或含嵌入 NUL。
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                // C 字符串比较只看到首个 NUL 前的名字，按固定大小写/别名规则赋 pressed。
                pressed = is_modifier_name_pressed(name);
            }
        }
    }

    // 准备接收运行时布尔值句柄，仍不是直接把 C bool 当成 JS 值返回。
    napi_value result = 0;
    // 无创建布尔值符号或创建失败才进入此分支；前面的读参失败通常只是 false。
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        // 尝试向 JS 报无法检查修饰键状态，由共享 fail 处理 N-API 抛错/undefined 路径。
        return fail(env, "Could not inspect modifier state");
    }
    // 返回 JS 布尔值，不导出临时 name/args 缓冲区。
    return result;
}

// 用给定 owner 重试打开系统剪贴板，成功返回 true，全部失败返回 false；不负责关闭，成功后的调用者必须收尾。
// 例：读请求可传空 owner，写请求由下方创建消息窗口。最多 10 次，每次失败都等 5ms，不是严格 50ms 截止或无限重试。
static bool open_clipboard(HWND owner) {
    // C for 包含初始化、继续条件和每轮递增；attempt 从 0 到 9。
    for (int attempt = 0; attempt < OPEN_CLIPBOARD_ATTEMPTS; attempt++) {
        // 系统调用成功就立即返回，跳过该轮 Sleep 和剩余重试。
        if (OpenClipboard(owner)) return true;
        // 失败才阻塞当前工作线程等待；本函数不会调用 JS，也不会在主线程里 await。
        Sleep(OPEN_CLIPBOARD_RETRY_MS);
    }
    // 10 次都失败后返回假，具体系统错误码没有保存。
    return false;
}

// 从至少两字节的内存读一个小端无符号 16 位值，不改变源数据；例：字节 01 02 得到十六进制 0201。
// 调用方负责提供可读范围，本函数没有长度参数或越界检查；uint8_t/uint16_t 分别表示精确的 8/16 位无符号整数。
static uint16_t read_u16(const uint8_t* data) {
    // 第 0 字节占低 8 位，第 1 字节左移 8 位后按位 | 合并，再按返回类型得到 16 位值；无需把指针强转为可能未对齐的 uint16_t*。
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

// 从至少四字节读小端无符号 32 位数，无分配/修改；例：01 00 00 00 得到 1。
// 各字节先转 uint32_t 再移位，避免最高字节左移时按有符号 int 计算；调用方须保证四字节可读。
static uint32_t read_u32(const uint8_t* data) {
    // 第 0 字节放最低位组，后续续行用按位或合并，不是逻辑 ||。
    return (uint32_t)data[0] |
        // 第 1 字节放到位 8–15。
        ((uint32_t)data[1] << 8) |
        // 第 2 字节放到位 16–23。
        ((uint32_t)data[2] << 16) |
        // 第 3 字节放最高 8 位，组成最终 32 位值。
        ((uint32_t)data[3] << 24);
}

// 把一个 32 位无符号值按小端拆成四字节写到 data，返回 void；例：值 0x01020304 写成 04 03 02 01。
// 这是实际内存写入，调用方必须提供至少四字节可写空间，没有自动扩容或 JS 风格数组边界检查。
static void write_u32(uint8_t* data, uint32_t value) {
    // 转 uint8_t 保留最低 8 位，写首字节。
    data[0] = (uint8_t)value;
    // 无符号右移 8 位再截成 8 位，写第二字节。
    data[1] = (uint8_t)(value >> 8);
    // 取原数第 16–23 位写第三字节。
    data[2] = (uint8_t)(value >> 16);
    // 取原数最高 8 位写第四字节。
    data[3] = (uint8_t)(value >> 24);
}

// 向前逐字节复制 length 个字节，不分配内存、无返回数据；例：把系统剪贴板缓冲复制到 job 拥有的新内存。
// 输入/输出范围有效性由调用者保证，不提供 memmove 的重叠保证。volatile 保留显式内存访问，便于不依赖 CRT 的构建；它不提供原子操作或线程同步。
static void copy_bytes(uint8_t* destination, const uint8_t* source, size_t length) {
    // 目标指针所指的字节标为 volatile，使每个写入是可观察的内存访问；指针本身仍是普通局部变量。
    volatile uint8_t* target = destination;
    // 源是 const volatile：经此视图不改源，每次读取也需保留；不等于复制或锁住源。
    const volatile uint8_t* input = source;
    // size_t 下标从 0 复制到 length-1；length=0 不访问任何字节，没有调用 memcpy。
    for (size_t index = 0; index < length; index++) target[index] = input[index];
}

// 按 DIB 头、调色板及可选位掩码估算像素数据偏移，返回 size_t，明显不支持/越界则 0；不修改数据。
// 例：40 字节头、无调色板和额外掩码时返回 40。这里只核基本布局，不解码像素、不验证尺寸/完整图像，更不保证所有 DIB 变种都能处理。
static size_t dib_pixel_offset(const uint8_t* dib, size_t size) {
    // 至少需要 12 字节才能读旧式核心头；太短立即用 0 表示失败。
    if (size < 12) return 0;
    // DIB 开头 4 字节给头大小，用小端读避免结构体对齐/布局假设。
    uint32_t header_size = read_u32(dib);

    // 头大小恰好 12 时走旧式 BITMAPCOREHEADER 布局。
    if (header_size == 12) {
        // 其位深字段在偏移 10，占两字节，已由 size>=12 保证可读。
        uint16_t bits_per_pixel = read_u16(dib + 10);
        // 位深不超过 8 时按 2 的位深次方估颜色数；1u 是无符号常量，超过 8 则不加此调色板。
        uint32_t color_count = bits_per_pixel <= 8 ? 1u << bits_per_pixel : 0;
        // 旧式调色板每项 3 字节，先转 size_t 再乘以颜色数，加到头大小后。
        size_t offset = header_size + (size_t)color_count * 3;
        // 偏移未超过缓冲才返回，否则 0；等于 size 仍被接受，因此并不保证缓冲还剩像素字节。
        return offset <= size ? offset : 0;
    }

    // 其他格式要求头至少 40 且不大于总缓冲；这也保证后面读到偏移 32 的字段有足够空间。
    if (header_size < 40 || header_size > size) return 0;
    // 读取信息头布局中偏移 14 的位深。
    uint16_t bits_per_pixel = read_u16(dib + 14);
    // 读取偏移 16 的压缩类型，后面只特判两个位掩码常量。
    uint32_t compression = read_u32(dib + 16);
    // 读取偏移 32 的显式调色板颜色数。
    uint32_t color_count = read_u32(dib + 32);
    // 显式颜色数为 0 且位深<=8 时用默认 2^位深；否则保留响应头里的数值，没有进一步限制合理范围。
    if (!color_count && bits_per_pixel <= 8) color_count = 1u << bits_per_pixel;

    // 信息头的调色板每项按 4 字节计；先转 size_t，使颜色数按内存大小类型参与偏移计算。
    size_t offset = header_size + (size_t)color_count * 4;
    // 40 字节头配 BI_BITFIELDS 时，颜色掩码位于头外，另加 3 个 32 位掩码；更大的头不重复添加。
    if (header_size == 40 && compression == BI_BITFIELDS) offset += 3 * sizeof(uint32_t);
    // 同为 40 字节头但带 alpha 掩码时另加 4 个 32 位掩码，包含透明度通道。
    if (header_size == 40 && compression == BI_ALPHABITFIELDS) offset += 4 * sizeof(uint32_t);
    // 最后只检查偏移<=总大小，不验证像素格式/压缩数据与宽高是否自洽。
    return offset <= size ? offset : 0;
}

// 在调用者已打开的剪贴板中优先取注册 PNG 格式，否则取 DIBV5/DIB，写入 job 的字节/大小/格式或错误；不返回 JS 值。
// 例：PNG 缓冲原样复制，DIB 则补 14 字节 BMP 文件头变为 BM 开头的字节。系统句柄只解锁不释放，job 的新内存由共享完成回调释放。
// 这不是图片解码器：PNG 内容和 DIB 像素未完整验证；成功取到 PNG 句柄后若锁失败，也不会再试 DIB。
static void read_clipboard_image(clipboard_job* job) {
    // 注册/取得名为 PNG 的 Windows 剪贴板格式编号；L 前缀使文本为 Windows 使用的宽字符串。
    UINT png_format = RegisterClipboardFormatW(L"PNG");
    // 只有注册编号非零且系统声明可用才视为 PNG 可用，结合下一行判断是否完全没有受支持格式。
    if (!(png_format && IsClipboardFormatAvailable(png_format)) &&
        // DIBV5 和 DIB 也都不可用才进入空图片分支，&& 会短路查询。
        !IsClipboardFormatAvailable(CF_DIBV5) && !IsClipboardFormatAvailable(CF_DIB)) {
        // -> 通过结构体指针访问成员，job->format 相当于 (*job).format；标记无图片，完成回调把 CLIPBOARD_EMPTY 转为 JS null。
        job->format = CLIPBOARD_EMPTY;
        // 退出当前图片读取函数，外层 clipboard_execute 仍继续关闭剪贴板。
        return;
    }
    // 优先尝试 PNG 句柄，条件和三元表达式在下一行继续；格式声明可用不保证获取一定成功。
    HGLOBAL handle = png_format && IsClipboardFormatAvailable(png_format)
        // 可用则取系统数据并转为全局内存句柄，否则先设空句柄；不在这里取得字节指针。
        ? (HGLOBAL)GetClipboardData(png_format) : 0;
    // 记住实际是否拿到 PNG 句柄，不能仅凭注册过 PNG 格式就把后备 DIB 当 PNG。
    bool is_png = handle != 0;
    // PNG 没拿到句柄才试 DIBV5，保持优先顺序。
    if (!handle && IsClipboardFormatAvailable(CF_DIBV5)) handle = (HGLOBAL)GetClipboardData(CF_DIBV5);
    // 仍为空才试传统 DIB；有了句柄后不会继续替换它。
    if (!handle && IsClipboardFormatAvailable(CF_DIB)) handle = (HGLOBAL)GetClipboardData(CF_DIB);

    // 三元仅在有句柄时 GlobalLock 得到可读字节地址；此锁是全局内存句柄访问机制，不是另加线程互斥锁。
    const uint8_t* source = handle ? (const uint8_t*)GlobalLock(handle) : 0;
    // GlobalSize 取得该内存块大小，空句柄则记 0；未按实际 PNG 解码长度裁剪。
    size_t size = handle ? GlobalSize(handle) : 0;
    // 锁失败或大小为 0 都按读图失败处理，和前面“不支持图片格式”的 null 分支不同。
    if (!source || !size) {
        // 如果锁已成功则先匹配解锁；没拿到指针时不解锁。
        if (source) GlobalUnlock(handle);
        // 把错误文字写进共享任务，等回 JS 线程后由完成回调创建拒绝原因。
        job->error = "Clipboard does not contain an image";
        // 本函数提前返回，外层仍会关闭已打开的剪贴板。
        return;
    }
    // 实际取自 PNG 句柄时直接复制，不走 DIB 转 BMP 的头部补齐。
    if (is_png) {
        // clipboard_copy 分配任务拥有的内存，复制全部 size 字节并标 CLIPBOARD_BUFFER；分配失败会在 job 内记错误。
        clipboard_copy(job, source, size, CLIPBOARD_BUFFER);
    // 没有 PNG 句柄的后备数据按 DIB 处理，最终返回 BMP 文件字节而非强制转 PNG。
    } else {
        // 用上面有限的 DIB 布局检查求像素位置；失败返回 0。
        size_t offset = dib_pixel_offset(source, size);
        // 只在偏移有效且加文件头后可放进 BMP 的 32 位大小字段时允许分配；&& 短路，三元在下一行继续。
        uint8_t* bitmap = offset && size <= UINT32_MAX - BITMAP_FILE_HEADER_SIZE
            // clipboard_alloc 在 Windows 用清零内存，大小是原 DIB 加 14；无效/分配失败均得到空指针，不保证成功分配。
            ? clipboard_alloc(size + BITMAP_FILE_HEADER_SIZE) : 0;
        // 只有新缓冲存在才向其写 BMP 头和数据。
        if (bitmap) {
            // 文件头首字节是字符 B。
            bitmap[0] = 'B';
            // 第二字节为 M，合成 BMP 文件标记；这是字符常量，不是字符串终止数据。
            bitmap[1] = 'M';
            // 偏移 2 写整个文件的 32 位小端大小；前面的范围检查允许这里转换为 uint32_t。
            write_u32(bitmap + 2, (uint32_t)(size + BITMAP_FILE_HEADER_SIZE));
            // 偏移 10 写像素相对于整个 BMP 的位置，即 14+原 DIB 像素偏移；未写的保留字节由清零分配保持 0。
            write_u32(bitmap + 10, (uint32_t)(BITMAP_FILE_HEADER_SIZE + offset));
            // 将全部原 DIB 字节放在新文件头后面，保留原 DIB 头/调色板/像素内容，不重新编码。
            copy_bytes(bitmap + BITMAP_FILE_HEADER_SIZE, source, size);
            // 把新缓冲所有权交给 job，后面只解锁系统源内存，不把此处 bitmap 提前释放。
            job->data = bitmap;
            // 任务长度按字节记录完整 BMP 大小。
            job->length = size + BITMAP_FILE_HEADER_SIZE;
            // 共享完成回调按 CLIPBOARD_BUFFER 创建 JS Buffer 副本，然后释放任务缓冲。
            job->format = CLIPBOARD_BUFFER;
        // 无效 DIB 布局、超 32 位文件大小或分配失败都汇到同一错误分支，不细分原因。
        } else {
            // 存任务错误，后续仍会离开分支并解锁系统数据。
            job->error = "Could not create clipboard image buffer";
        }
    }
    // 匹配上面的 GlobalLock；返回值未检查，原系统数据句柄仍由系统拥有，不能 GlobalFree。
    GlobalUnlock(handle);
}

// 由 clipboard.h 的异步工作回调调用，按 job.operation 写文本、读文本或读图片，结果写回 job，返回 void，不在工作线程调用 N-API。
// 例：setText 创建消息窗口作为剪贴板 owner，再分配/提交 UTF-16；getText 在没有 Unicode 文本时标空。已打开后在各分支结束统一 CloseClipboard/销毁窗口。
// 关闭/销毁的返回值未检查；写入先 EmptyClipboard 再 SetClipboardData，后者失败时旧内容也可能已被清掉，并非原子替换。
static void clipboard_execute(clipboard_job* job) {
    // A real clipboard owner is required for text writes, including under Node
    // without a console. Create and destroy it on the same worker thread.
    // HWND 是窗口句柄，0 表示目前没有窗口；只有文本写请求才创建 owner。
    HWND owner = 0;
    // operation 枚举来自共享任务，CLIPBOARD_WRITE 专门对应 setText。
    if (job->operation == CLIPBOARD_WRITE) {
        // 创建系统 STATIC 类窗口，样式/尺寸等参数为 0；调用参数在下一行继续，不显示一个交互窗口。
        owner = CreateWindowExW(0, L"STATIC", 0, 0, 0, 0, 0, 0,
            // HWND_MESSAGE 指定仅消息窗口；模块实例取当前进程，窗口在本工作线程建立并在同线程销毁。
            HWND_MESSAGE, 0, GetModuleHandleA(0), 0);
        // 无法创建窗口就不能按此方案提供写入 owner。
        if (!owner) {
            // 记录创建 owner 失败的任务错误。
            job->error = "Could not create clipboard owner window";
            // 尚未打开剪贴板，直接结束任务执行；完成回调稍后处理错误。
            return;
        }
    }
    // 读请求 owner=0，写请求传消息窗口；用有上限次数的重试打开，失败时不进入 CloseClipboard 收尾。
    if (!open_clipboard(owner)) {
        // 若已经创建 owner 窗口，打开失败也要尝试销毁，返回值未检查。
        if (owner) DestroyWindow(owner);
        // 记录无法打开剪贴板，不把它转换为“没有文本/图片”。
        job->error = "Could not open clipboard";
        // 结束本次执行；因为没有成功打开，不调用后面的 CloseClipboard。
        return;
    }
    // 成功打开后，先处理有副作用的文本写入请求。
    if (job->operation == CLIPBOARD_WRITE) {
        // 共享 queue_clipboard 已将 JS 字符串转成 NUL 终止 UTF-16，job.length 是码元数；这里加终止码元再换成字节数，不是字符显示宽度。
        size_t size = (job->length + 1) * sizeof(uint16_t);
        // 申请可移动的系统全局内存，供成功 SetClipboardData 后把所有权移交系统；与任务缓冲的清零固定分配不同。
        HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, size);
        // 有句柄才锁定为可写地址；void* 表示此刻按未指定元素类型看这片内存。
        void* text = handle ? GlobalLock(handle) : 0;
        // 先假设提交失败，只有真正设置成功才改 true。
        bool success = false;
        // 锁到地址后才能拷贝，不因只有句柄就直接写内存。
        if (text) {
            // 从共享任务复制 UTF-16 正文及末尾 NUL；这片提交内存与 job.data 是不同的分配。
            copy_bytes(text, job->data, size);
            // 提交前匹配解锁，不释放系统句柄。
            GlobalUnlock(handle);
            // 先清空，再设置 CF_UNICODETEXT；&& 使清空失败时不执行设置，设置成功后内存归系统，后面不能再自行释放。
            success = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, handle) != 0;
        }
        // 任一准备/提交步骤未成功都进入失败清理。
        if (!success) {
            // 有未移交系统的句柄就释放；失败时 job.data 仍由共享完成回调另行释放，不在这里混用所有权。
            if (handle) GlobalFree(handle);
            // 记录提交错误；即使 EmptyClipboard 已成功，也不恢复此前剪贴板内容。
            job->error = "Could not set clipboard text";
        }
    // 不是写入且属于文本读取才进入此分支。
    } else if (job->operation == CLIPBOARD_TEXT) {
        // 仅请求 CF_UNICODETEXT；系统未声明可提供时直接视为无文本，不在这里列出所有格式。
        if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) {
            // 标空文本，完成回调将其转为 JS null。
            job->format = CLIPBOARD_EMPTY;
        // 有 Unicode 文本格式时才取数据。
        } else {
            // 取得系统拥有的全局内存句柄，可能失败得到 0。
            HGLOBAL handle = (HGLOBAL)GetClipboardData(CF_UNICODETEXT);
            // 成功句柄才 GlobalLock；指针视为 const uint16_t*，后续读取 UTF-16 码元而非按 UTF-8 字节走。
            const uint16_t* text = handle ? GlobalLock(handle) : 0;
            // 只有锁定成功才能检查内容。
            if (text) {
                // 由内存块字节大小除以每个 UTF-16 码元大小，得到可访问码元容量。
                size_t capacity = GlobalSize(handle) / sizeof(uint16_t);
                // 从 0 统计实际扫描到的码元数。
                size_t length = 0;
                // 先查 length<capacity 再读 text[length]，遇首个 NUL 停；没有 NUL 时会复制到容量上限，不宣称验证了严格终止格式。
                while (length < capacity && text[length]) length++;
                // 把码元数转回字节数交 clipboard_copy；CLIPBOARD_UTF16 使共享工具把任务长度再按码元记录，完成时用 UTF-16 构造 JS 字符串。
                clipboard_copy(job, text, length * sizeof(uint16_t), CLIPBOARD_UTF16);
                // 复制结束后解锁系统源；新任务内存独立持有内容，供之后主线程完成回调使用。
                GlobalUnlock(handle);
            // 格式声称存在但取/锁数据失败，和前面的空文本分支不同。
            } else {
                // 记读取错误供 Promise 拒绝处理。
                job->error = "Clipboard does not contain text";
            }
        }
    // 其他 operation 都落入图片读取；此 Windows 模块只导出文本/图片相关入口，没有另导出 getFilePaths。
    } else {
        // 图片函数可能在内部提前 return，但这里只是一次调用，返回后仍执行统一关闭逻辑。
        read_clipboard_image(job);
    }
    // 匹配本函数成功的 OpenClipboard；没有检查关闭是否成功，不是 C 自动资源管理语法。
    CloseClipboard();
    // 有写入 owner 才销毁；和创建一样在当前工作线程，读请求没有窗口可销毁。
    if (owner) DestroyWindow(owner);
}

// 提供 DLL 入口形式的兼容函数，忽略加载/卸载原因并总返回 TRUE，不做 CRT 初始化或剪贴板操作。
// 当前构建脚本显式使用无入口选项，因此不能因这个函数存在就断言每次加载都会调用它；N-API 注册导出在下方。WINAPI 指定系统调用约定。
BOOL WINAPI _DllMainCRTStartup(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    // 有意忽略模块实例参数，void 转换不释放句柄。
    (void)instance;
    // 不根据附加/分离原因执行任何分支。
    (void)reason;
    // 保留指针参数以满足入口签名，但不解引用。
    (void)reserved;
    // 返回 Windows TRUE，表达本函数未主动拒绝加载；不代表全部模块能力初始化成功。
    return TRUE;
}

// 运行时加载模块后按这个导出名注册五个 JS 方法，返回原 exports 对象；此时只安装回调，不直接调用剪贴板或读取按键。
// 例：注册后的 getText() 由共享工具排异步任务，再进入上面的 clipboard_execute。set_function_export 对缺失符号/设置失败没有完整报错保证，不能说五项必定全装好。
// PI_NAPI_EXPORT 展开为可见导出标记，PI_NAPI_CALL 在 Windows 展开为 __cdecl；env/exports 是宿主传入的值句柄。
PI_NAPI_EXPORT napi_value PI_NAPI_CALL napi_register_module_v1(napi_env env, napi_value exports) {
    // 把同步 VT 输入设置回调挂为 enableVirtualTerminalInput；传的是函数地址，不是调用结果。
    set_function_export(env, exports, "enableVirtualTerminalInput", enable_virtual_terminal_input);
    // 把同步修饰键检查回调挂到 isModifierPressed。
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    // getText 回调来自 clipboard.h，负责创建 Promise/任务而不是直接在注册线程打开剪贴板。
    set_function_export(env, exports, "getText", get_clipboard_text);
    // 由顶部 PI_CLIPBOARD_WRITE 开启的 setText 回调；只有后来调用此方法才会改剪贴板。
    set_function_export(env, exports, "setText", set_clipboard_text);
    // getImage 也走共享异步工具，最终得到原 PNG 或封装 BMP 的 Buffer/null 等结果。
    set_function_export(env, exports, "getImage", get_clipboard_image);
    // 返回同一 exports 对象给宿主，没有克隆成另一个对象或主动调用刚设置的方法。
    return exports;
}
