// 共享剪贴板任务桥接：各平台包含本头，导出的读/写回调先准备任务和 Promise，再入队执行平台 clipboard_execute，完成后回 JS 线程转换数据并释放内存。
// 本头负责内存/编码/异步交接，不直接决定 Windows、macOS 或 X11 如何访问剪贴板；Linux 的平台主体还会委派额外私有线程，不能把一次异步任务等同于所有平台只用一个线程。
// 预处理保护防止同一编译单元重复展开本头；不是进程全局队列或运行时单例。
#ifndef PI_CLIPBOARD_H
// 第一次展开时定义保护宏，后续 include 会跳过本头正文。
#define PI_CLIPBOARD_H

// 取得项目最小 N-API 句柄/函数指针声明与动态符号工具，不直接依赖完整 Node 头文件。
#include "napi.h"
// 非 Windows 分支才引入 C 运行库分配/字符串操作声明，Windows 则使用系统全局内存工具。
#ifndef _WIN32
// 提供 calloc/free 等内存函数。
#include <stdlib.h>
// 提供 memcpy 等字节操作函数，下面只在对应平台条件分支使用。
#include <string.h>
// 结束标准库 include 的平台条件。
#endif

// C 枚举定义四种请求，再 typedef 成 clipboard_operation；TEXT/IMAGE/WRITE/FILES 分别是读文本、读图、写文本、读文件路径，不会据此自动执行操作。
typedef enum { CLIPBOARD_TEXT, CLIPBOARD_IMAGE, CLIPBOARD_WRITE, CLIPBOARD_FILES } clipboard_operation;
// CLIPBOARD_PATHS stores concatenated, NUL-terminated UTF-8 paths in clipboard_job.data.
// 结果格式枚举决定完成回调如何构造 JS 值；它与请求类型分开，例如读图可得到 BUFFER 或 EMPTY。
typedef enum {
    // 首项默认数值0，清零的新任务默认“不可用”；没有错误时完成回调保留 JS undefined，区别于空内容的 null。
    CLIPBOARD_UNAVAILABLE,
    // 表示支持读取但没有对应内容，完成时尝试返回 JS null。
    CLIPBOARD_EMPTY,
    // data 是 UTF-8 文本，length 按字节计。
    CLIPBOARD_UTF8,
    // data 是 Latin-1 单字节文本，用另一个 N-API 字符串函数解码，而不是按 UTF-8 猜测。
    CLIPBOARD_LATIN1,
    // data 是16位码元，length 按码元数计；和下面 Buffer 的字节单位不同。
    CLIPBOARD_UTF16,
    // 任意图片字节，完成时复制成 JS Buffer；枚举本身不验证图片编码。
    CLIPBOARD_BUFFER,
    // 拼接的 UTF-8 文件路径串，每项含 NUL 终止符，length 覆盖整块字节；完成时再拆成 JS 数组。
    CLIPBOARD_PATHS
// 结束枚举并给它 clipboard_format 类型名，后面用在结构体字段。
} clipboard_format;

// 匿名 C 结构体定义一次任务所需状态，最后 typedef 命名；任务在堆上分配，void* 用户数据跨回调传递同一地址。
typedef struct {
    // 工作项的宿主句柄，入队/删除使用它，不是系统线程 ID。
    napi_async_work work;
    // 本次 Promise 的待结算句柄，完成回调按成功/错误选择兑现或拒绝。
    napi_deferred deferred;
    // 调用者想做哪种剪贴板操作，平台工作主体据此分支。
    clipboard_operation operation;
    // 平台工作主体写回的数据编码/空值状态，清零时为 UNAVAILABLE。
    clipboard_format format;
    // 任务拥有的缓冲指针；写请求是输入副本，读请求是平台返回的独立副本，正常完成后统一释放。
    void* data;
    // 缓冲长度，通常字节数，只有 CLIPBOARD_UTF16 结果按16位码元计；不能在所有分支都叫字符数。
    size_t length;
    // 可选错误消息指针，当前平台代码给它静态文字；完成时创建 JS Error，但不会单独释放这个指针。
    const char* error;
// 命名为 clipboard_job；-> 用于经结构体指针访问字段，如 job->format 等于 (*job).format。
} clipboard_job;

// Only this function runs on the worker thread. It must not call N-API.
// 平台工作主体的前置声明，具体定义由包含本头的 C/Objective-C 文件提供；输入任务并改其中结果，不直接返回 JS 值。
// 英文强调这部分工作不能调用 N-API；实际执行回调与它调用的纯原生辅助也在工作路径上，JS 值的构造留给完成回调。
static void clipboard_execute(clipboard_job* job);

// 分配 size 字节并清零，返回可写 void* 或失败的空指针，不抛 JS 错误；例：分配任务结构时使句柄/错误/格式处于目标平台的零初态。
// 调用者决定大小、检查失败并负责释放；不为0字节作统一归一处理，各系统分配器的0大小行为可能不同。
static void* clipboard_alloc(size_t size) {
// Windows 编译时用系统分配分支。
#ifdef _WIN32
    // GPTR 请求固定且清零的全局内存，返回值可作为指针保存；对应 clipboard_free 中的 GlobalFree。
    return GlobalAlloc(GPTR, size);
// 其他目标使用 C 运行库。
#else
    // calloc 分配一个大小为 size 的块并清零，失败返回空指针；释放必须配 free。
    return calloc(1, size);
// 结束条件编译，不会在同一次运行里同时执行两种分配。
#endif
}

// 释放本工具/平台任务按约定交付的缓冲，返回 void；例：完成回调释放 job->data 再释放 job 自身。
// 需和实际分配来源匹配，不负责关剪贴板、删除工作句柄或释放 JS 值；释放后不能再用旧指针访问数据。
static void clipboard_free(void* data) {
// Windows 选择与 GPTR 分配配对的释放 API。
#ifdef _WIN32
    // 空指针直接跳过，非空交 GlobalFree；未检查它的返回值，不表示能验证任意外部句柄合法。
    if (data) GlobalFree(data);
// 其他平台改用 C 运行库释放。
#else
    // free 接受空指针为空操作；传已释放或错误来源的地址不由本函数兜底。
    free(data);
// 结束释放的平台分支。
#endif
}

// 只有上游在 include 前定义 PI_CLIPBOARD_WRITE 才编译这段复制工具；目前 Windows/macOS 开启，Linux 源不启用该宏。
#ifdef PI_CLIPBOARD_WRITE
// 复制 length 字节到任务新缓冲，设置编码/长度，返回 void；分配失败写 job.error，源数据不修改。
// 例：UTF-16 输入8字节会记4个码元。即使长度0也至少分配1字节；未释放 job 原有 data，因此调用方按一次交付新结果使用，不能当作自动替换旧缓冲的通用接口。
static void clipboard_copy(clipboard_job* job, const void* data, size_t length, clipboard_format format) {
    // 先分配独立存储并赋给 job；三元把0长度归一为1，便于空内容也有有效缓冲。
    job->data = clipboard_alloc(length ? length : 1);
    // 内存不足时不能继续复制。
    if (!job->data) {
        // 记录静态错误文字，完成回调稍后尝试创建 JS Error。
        job->error = "Out of memory";
        // 结束本次复制，未把失败当作有效空字符串。
        return;
    }
// Windows 用显式字节循环，配合不依赖默认 C 运行库的构建。
#ifdef _WIN32
    // 以 volatile 字节指针看目标，保留逐字节写访问；不是线程锁或原子写保证。
    volatile uint8_t* target = job->data;
    // 源以 const volatile 字节读取，不能经这个视图修改，读取访问也保留。
    const volatile uint8_t* source = data;
    // 从0到length-1逐字节复制；调用者保证源/目标范围，不执行自动边界检查。
    for (size_t index = 0; index < length; index++) target[index] = source[index];
// 非 Windows 使用正常 C 内存复制。
#else
    // 复制确切 length 字节；不附加终止符，不支持靠本句处理重叠内存。
    memcpy(job->data, data, length);
// 结束复制实现选择。
#endif
    // 只有 UTF16 把字节量除以码元大小；没有验证长度必为偶数，其他格式维持字节数。
    job->length = format == CLIPBOARD_UTF16 ? length / sizeof(uint16_t) : length;
    // 保存格式，完成回调据它选择字符串/Buffer/数组转换，未检查源内容真实编码。
    job->format = format;
}
// 结束复制工具的宏开关，后面的异步桥接仍全部可用。
#endif

// N-API 的后台执行回调：接宿主给的 env 和不透明 data，把 data 当任务交给平台主体，返回 void。
// 例：getText 入队后这里才开始平台读操作；不在本回调构造 JS 值，平台结果由稍后的 complete 回调处理，Linux 主体还会委托私有线程。
static void PI_NAPI_CALL execute_clipboard_work(napi_env env, void* data) {
    // 有意不使用工作线程的 env，避免在此操作 JS 引擎；void 转换不释放上下文。
    (void)env;
    // C 可把 void* 隐式转为 clipboard_job* 参数类型；同一任务地址被平台主体写入结果，没有克隆。
    clipboard_execute(data);
}

// 把任务的 NUL 分隔 UTF-8 路径块转换成 JS 数组，经 result 输出，成功返回0、缺终止符或 N-API 步骤失败返回1。
// 例：两个路径各带末尾0，会生成两项字符串；这里只拆字节，不检查文件存在、路径安全或过滤终端控制字符。调用者须提供有效内存和可用 create_string。
static int create_clipboard_paths_value(
    // env 用于本次 JS 值创建，函数在完成阶段调用而非后台执行阶段。
    napi_env env,
    // const clipboard_job* 禁止经本结构体视图改字段，但不是深冻结 data 指向的内存；此函数只读内容。
    const clipboard_job* job,
    // 传入已取得的 UTF-8 创建函数指针，避免每个路径都再查一次符号；这里不单独检查这个指针。
    napi_create_string_utf8_fn create_string,
    // napi_value* 输出数组句柄，调用者传 &result；函数返回 int 状态，不能把两者混为一项返回值。
    napi_value* result
) {
    // 动态获取空数组创建函数，先不执行。
    napi_create_array_fn create_array = (napi_create_array_fn)node_symbol("napi_create_array");
    // 动态获取按索引写元素的函数。
    napi_set_element_fn set_element = (napi_set_element_fn)node_symbol("napi_set_element");
    // 两符号缺一或建数组非0就返回1；短路防空调用，不把错误转为成功空数组。
    if (!create_array || !set_element || create_array(env, result) != 0) return 1;

    // const char* 从整块数据首字节开始扫描，指针本身可前移，字符不经它修改。
    const char* cursor = job->data;
    // 末尾哨兵是首地址加字节长度，不包含在合法读取范围内；依赖平台生产者交付有效缓冲。
    const char* end = cursor + job->length;
    // 只要还有未消费字节就处理下一项，uint32_t 索引用于 JS 数组设置；没有额外检验极端路径项数量上限。
    for (uint32_t index = 0; cursor < end; index++) {
        // 先让终止位置从当前路径开头开始。
        const char* terminator = cursor;
        // 先保证未到 end 才解引用，逐字节找 NUL；不会读到本块末尾之后寻找终止符。
        while (terminator < end && *terminator != '\0') terminator++;
        // 剩余块没有 NUL 就报失败，不能把未终止尾部当成完整路径。
        if (terminator == end) return 1;

        // 准备接收这一项的 JS 字符串句柄。
        napi_value item = 0;
        // 指针差得到不含 NUL 的字节长度，再转 size_t 创建 UTF-8 字符串；长度显式传入，不靠再次扫描。
        if (create_string(env, cursor, (size_t)(terminator - cursor), &item) != 0 ||
            // 字符串创建成功才按当前 index 写到已创建的数组；|| 任一失败都进入下一行返回。
            set_element(env, *result, index, item) != 0) {
            // 返回通用失败状态1，不在这里释放任务内存；外层完成回调仍负责收尾。
            return 1;
        }
        // 跳过当前路径的那个 NUL，继续下一项；中间连续 NUL 会成为空路径字符串，而非被过滤。
        cursor = terminator + 1;
    }
    // 所有字节都按终止路径消费后返回0，输出数组已在 result 指向的位置。
    return 0;
}

// 异步任务完成后回 JS 运行时线程：按格式创建结果或 Error，尝试结算 deferred，再删除工作项/释放任务内存，返回 void。
// 例：EMPTY→null、UNAVAILABLE→undefined、BUFFER→JS Buffer 副本；WRITE 成功也保留 undefined。API 状态/符号并非逐次检查，不能承诺任意宿主错误下都能成功结算并收尾。
static void PI_NAPI_CALL complete_clipboard_work(napi_env env, int status, void* data) {
    // 把异步用户数据从 void* 恢复为原 clipboard_job*，仍是创建时同一分配。
    clipboard_job* job = data;
    // 重新取得 UTF-8 字符串创建函数，后面用于结果或错误消息；本处没有再次判空。
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    // 先用 JS undefined 作为缺能力/写成功等情况的默认结果；工具本身也不保证每个 N-API 调用成功。
    napi_value result = undefined_value(env);
    // 任何非0完成状态都覆盖为这条取消错误，不保留可能已有的平台错误原因。
    if (status != 0) job->error = "Clipboard operation cancelled";
    // 没有错误且不是写请求才把读回数据转换为 JS 值；写操作不把输入正文再次返回。
    if (!job->error && job->operation != CLIPBOARD_WRITE) {
        // 空内容结果分支，与不可用状态不同。
        if (job->format == CLIPBOARD_EMPTY) {
            // 尝试取得真正的 JS null 值句柄。
            result = null_value(env);
        // 文件路径块需要拆分为字符串数组。
        } else if (job->format == CLIPBOARD_PATHS) {
            // 调用上面的受边界约束路径解析器，返回状态赋给当前 status。
            status = create_clipboard_paths_value(env, job, create_string, &result);
        // 图片/字节数据走 Buffer 副本。
        } else if (job->format == CLIPBOARD_BUFFER) {
            // 查 Buffer 创建符号，但这里没有判空后再调用的分支。
            napi_create_buffer_copy_fn create_buffer = (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
            // length 按字节，data 是源；第四参数0表示不取新缓冲地址，只接 JS Buffer 句柄，成功副本不借用任务内存。
            status = create_buffer(env, job->length, job->data, 0, &result);
        // UTF-16 文本分支按码元长度建立字符串。
        } else if (job->format == CLIPBOARD_UTF16) {
            // 查 UTF-16 字符串函数，未在此再次验证符号存在。
            napi_create_string_utf16_fn create_utf16 = (napi_create_string_utf16_fn)node_symbol("napi_create_string_utf16");
            // job.length 已是码元数，不能再乘2传给此 API；状态供后面统一判断。
            status = create_utf16(env, job->data, job->length, &result);
        // UTF-8/Latin-1 共用字节长度签名，但需要不同的解码函数。
        } else if (job->format == CLIPBOARD_UTF8 || job->format == CLIPBOARD_LATIN1) {
            // 先按格式选择函数指针，三元赋值在下一行继续。
            napi_create_string_utf8_fn create_text = job->format == CLIPBOARD_LATIN1
                // Latin-1 查专用符号，否则复用 UTF-8；没有把 Latin-1 原字节误交 UTF-8 解码，也没再次判空。
                ? (napi_create_string_utf8_fn)node_symbol("napi_create_string_latin1") : create_string;
            // 按 length 字节创建字符串并记录状态，允许空内容长度为0。
            status = create_text(env, job->data, job->length, &result);
        }
        // 转换状态非0就换为通用创建值错误；未进入这些转换的 UNAVAILABLE 状态保持默认 undefined。
        if (status != 0) job->error = "Could not create clipboard value";
    }
    // 有平台/取消/转换错误时准备 JS Error，覆盖原先的结果值。
    if (job->error) {
        // 查 Error 构造 API；此错误处理路径同样没有逐项判空/状态检查。
        napi_create_error_fn create_error = (napi_create_error_fn)node_symbol("napi_create_error");
        // 声明用于接收错误消息的 JS 值句柄，未初始化，依赖下一 API 成功写入。
        napi_value message;
        // 把静态 C 错误文字按自动长度变成 JS 字符串，返回状态未检查。
        create_string(env, job->error, NAPI_AUTO_LENGTH, &message);
        // 以空错误码和消息建立 JS Error，经 &result 写结果；创建 Error 本身并未结算 Promise。
        create_error(env, 0, message, &result);
    }
    // 动态选择 deferred 的结算函数，完整符号名在下一行决定；不是调用 JS then。
    napi_settle_deferred_fn settle = (napi_settle_deferred_fn)node_symbol(
        // 有 error 选 reject，否则 resolve；两者共用相同函数指针类型。
        job->error ? "napi_reject_deferred" : "napi_resolve_deferred"
    );
    // 尝试拒绝/兑现 Promise；未检查 settle 指针/状态，调用返回后继续收尾，缺符号等异常并无完整兜底。
    settle(env, job->deferred, result);
    // 取得删除工作项的 API，不能用 clipboard_free 释放这个宿主句柄。
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    // 删除已经完成的异步工作项，返回状态未检查。
    delete_work(env, job->work);
    // 成功转换的 JS 值已经独立持有内容；正常或已记录错误时都继续释放原生任务缓冲，写请求也在这里释放输入副本。
    clipboard_free(job->data);
    // 最后释放任务本体；后续不能再访问 job 或它的字段。
    clipboard_free(job);
}

// JS 读/写入口共用的准备器：查所需 API、分配清零任务、写请求先复制参数，再创建工作/Promise并入队，返回 JS Promise 句柄。
// 例：getText 不读取输入参数，setText 会在本线程先取得字符串副本；平台访问在入队后的工作路径执行，可能在本函数返回前已开始。
// 准备失败尝试清理已分配任务/工作项并同步 fail；并非总能先返回一个被拒绝的 Promise，已创建却未返回的 deferred 也未在失败分支主动结算。
static napi_value queue_clipboard(napi_env env, napi_callback_info info, clipboard_operation operation) {
    // 取创建异步工作项的函数指针。
    napi_create_async_work_fn create_work = (napi_create_async_work_fn)node_symbol("napi_create_async_work");
    // 取入队 API；有工作句柄不等于已经开始执行。
    napi_async_work_fn queue_work = (napi_async_work_fn)node_symbol("napi_queue_async_work");
    // 取删除工作项 API，供准备失败时清理。
    napi_async_work_fn delete_work = (napi_async_work_fn)node_symbol("napi_delete_async_work");
    // 取一次创建 Promise 与 deferred 的 API。
    napi_create_promise_fn create_promise = (napi_create_promise_fn)node_symbol("napi_create_promise");
    // 取 UTF-8 字符串创建 API，首先用于异步资源显示名字。
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    // 这五个核心符号必须齐备；后面使用的全部转换/错误符号并不都在这里检查。
    if (!create_work || !queue_work || !delete_work || !create_promise || !create_string) {
        // 核心异步能力缺失时尝试同步抛 JS 错误并返回 undefined，不创建工作。
        return fail(env, "Async clipboard API unavailable");
    }
    // sizeof(*job) 按指向的结构体类型求字节数，不会解引用尚未赋值的 job；分配器清零字段。
    clipboard_job* job = clipboard_alloc(sizeof(*job));
    // 任务分配失败就立即 fail，没有可供后续异步完成的任务对象。
    if (!job) return fail(env, "Out of memory");
    // 保存本次操作枚举，平台执行主体稍后据此决定读写种类。
    job->operation = operation;
// 写入功能编译开关，和 Windows/macOS 在 include 前定义的宏配套。
#ifdef PI_CLIPBOARD_WRITE
    // 只有 WRITE 请求需要先读入 JS 字符串，其他请求跳过本段。
    if (operation == CLIPBOARD_WRITE) {
        // 获取 JS 回调参数读取 API，下一步会检查它。
        napi_get_cb_info_fn get_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
// 写入编码按目标系统选择，不是根据字符串内容猜编码。
#ifdef _WIN32
        // Windows 使用 UTF-16 参数提取，和 CF_UNICODETEXT 需要的码元一致。
        napi_get_value_string_utf16_fn get_string = (napi_get_value_string_utf16_fn)node_symbol("napi_get_value_string_utf16");
        // 一个容量单位占 sizeof(uint16_t) 字节。
        size_t unit_size = sizeof(uint16_t);
// 非 Windows 写请求采用 UTF-8。
#else
        // UTF-8 提取函数把 JS 字符串编码为字节，未作任意值的自动字符串转换。
        napi_get_value_string_utf8_fn get_string = (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
        // UTF-8 容量单位就是1字节。
        size_t unit_size = 1;
// 结束编码函数/单位选择，两边变量名相同供下文共用。
#endif
        // 为第一个参数提供一个接收槽位的容量，额外参数不会在此逐项处理。
        size_t argc = 1;
        // 先设空值句柄，成功读取后接第一个参数。
        napi_value argument = 0;
        // 符号缺失、取参失败或参数数量为0都会短路到错误分支；条件继续到下一行。
        if (!get_info || !get_string || get_info(env, info, &argc, &argument, 0, 0) != 0 || argc == 0 ||
            // 目标缓冲0/容量0只查询编码后的所需长度（不含末尾NUL），写到 job.length；非字符串等失败也归此分支。
            get_string(env, argument, 0, 0, &job->length) != 0) {
            // 尚未建异步工作，先释放任务本体；此时没有正文缓冲需另外释放。
            clipboard_free(job);
            // 尝试向 JS 报 setText 需要字符串，返回路径不再继续入队。
            return fail(env, "setText requires a string");
        }
        // 先检查长度上界，为加一个终止单位、再乘 unit_size 留出不溢出 size_t 的空间；三元在下一行继续。
        job->data = job->length < SIZE_MAX / unit_size
            // 合格才真正分配正文加终止符的清零缓冲，否则空指针表示不能继续。
            ? clipboard_alloc((job->length + 1) * unit_size) : 0;
        // 缓冲存在才第二次编码复制，容量仍按码元/字节单位传 length+1，输出实际长度；|| 短路避免写空缓冲。
        if (!job->data || get_string(env, argument, job->data, job->length + 1, &job->length) != 0) {
            // 分配或第二次读取失败，先释放可能已经存在的正文缓冲，允许空指针。
            clipboard_free(job->data);
            // 再释放任务对象，顺序保证不先释放 job 再读其 data。
            clipboard_free(job);
            // 尝试同步报告读取字符串失败，不向工作线程提交半份任务。
            return fail(env, "Could not read clipboard text");
        }
    }
// 未编译写功能时走此预处理分支，读入口仍可使用。
#else
    // 仅标明 info 有意不读，不执行运行时参数转换。
    (void)info;
// 结束可选写请求准备区。
#endif
    // 准备接收异步资源名字的 JS 字符串句柄。
    napi_value name = 0;
    // 准备接收将返回给 JS 的 Promise 值，deferred 另存在 job 中。
    napi_value promise = 0;
    // 第一步创建用于异步追踪的 pi.clipboard 名字；任一步非0都会通过 || 短路进入失败清理。
    if (create_string(env, "pi.clipboard", NAPI_AUTO_LENGTH, &name) != 0 ||
        // 创建工作项并关联执行/完成回调及 job 地址；此 API 只建工作，尚未调用 queue_work。
        create_work(env, 0, name, execute_clipboard_work, complete_clipboard_work, job, &job->work) != 0 ||
        // 先创建 deferred/Promise，再入队工作；前一步失败不会入队，入队成功后平台工作才可开始。
        create_promise(env, &job->deferred, &promise) != 0 || queue_work(env, job->work) != 0) {
        // 如果此前已创建工作项就尝试删除，句柄初值为0所以可判断是否需要；不检查删除状态。
        if (job->work) delete_work(env, job->work);
        // 释放写请求可能已有的输入缓冲，读请求通常仍为空。
        clipboard_free(job->data);
        // 释放任务本体，避免失败时留待永远不会到来的完成回调。
        clipboard_free(job);
        // 尝试同步 fail；此分支没有专门 reject 可能已经创建但尚未返回的 Promise。
        return fail(env, "Could not queue clipboard operation");
    }
    // 准备和入队均成功后，把 JS Promise 句柄交还调用者；完成/错误稍后由 complete_clipboard_work 尝试结算。
    return promise;
}

// getText 的 N-API 回调，输入宿主 env/info，返回共享准备器的 Promise 或其同步失败返回值，无额外参数解析。
// 例：JS 调 getText() 先在当前线程准备/入队，实际读取编码和空/不可用状态由平台结果决定，不在此保证一定有字符串。
static napi_value PI_NAPI_CALL get_clipboard_text(napi_env env, napi_callback_info info) {
    // 以 CLIPBOARD_TEXT 标记本次读取，其他异步/内存步骤全由准备器负责。
    return queue_clipboard(env, info, CLIPBOARD_TEXT);
}

// getImage 的 N-API 回调，把 env/info 透传准备器并返回其结果；例：平台无图片可最终得到 null，传输错误可拒绝，不在本入口解码图片。
static napi_value PI_NAPI_CALL get_clipboard_image(napi_env env, napi_callback_info info) {
    // 只把操作标签换为 IMAGE，不打开额外文件、不在当前线程读取系统图片。
    return queue_clipboard(env, info, CLIPBOARD_IMAGE);
}

// 可选写入导出回调也受同一宏控制，Linux 未定义该宏时没有此函数体。
#ifdef PI_CLIPBOARD_WRITE
// setText 的 N-API 回调，把宿主调用交给 WRITE 准备路径；成功 Promise 最终兑现 undefined，准备失败可能同步设置异常。
// 例：JS 传字符串先由准备器复制，再由平台执行主体写系统剪贴板；这项副作用发生在工作路径，不在函数注册时发生。
static napi_value PI_NAPI_CALL set_clipboard_text(napi_env env, napi_callback_info info) {
    // 操作标记为 WRITE，触发上面的参数读取和平台文本写入分支。
    return queue_clipboard(env, info, CLIPBOARD_WRITE);
}
// 结束写入回调的编译开关。
#endif

// 结束本头的 PI_CLIPBOARD_H 保护条件。
#endif
