// Linux私有读取线程的受控原生测试模块：包含真实clipboard-worker.h，用固定text缓冲代替X11读取，给CJS驱动测试并发、迟到释放和Node环境退出。
// 此文件由native-clipboard-linux.test.ts编为.node，再由clipboard-worker-test.cjs加载；不是独立可直接node执行的脚本，也不访问桌面剪贴板。
// 提供C assert；测试按断言启用的配置解释，定义NDEBUG会删掉整个assert表达式，不能把它当只关闭日志。
#include <assert.h>
// 提供atomic_int/atomic_bool和原子读改写；跨私有线程/宿主线程访问计数与释放标志，普通非原子变量不能替代这些同步点。
#include <stdatomic.h>
// 提供snprintf，后面把三个状态数拼成可断言的文字。
#include <stdio.h>
// 提供实际calloc/free，包装函数定义在宏替换之前，内部仍调用真实分配器。
#include <stdlib.h>

// 模块内两个原子整数初值0：allocations计未释放的受跟踪分配块数（不是字节），reads计进入受控reader的次数。
static atomic_int allocations, reads;
// 原子released初值false，JS导出的release会把它改true；后面不再重设false，因此释放一次后未来读取不再阻塞。
static atomic_bool released;

// 受跟踪calloc包装器，接元素数/元素字节数，返回实际清零缓冲或空指针；成功才把活动块数加1，无JS值创建。例5×1分配5字节但计数只加1。
static void* tracked_calloc(size_t count, size_t size) {
    // 调用真实calloc；此处尚未定义下面的calloc替换宏，所以不会递归调用自己。
    void* pointer = calloc(count, size);
    // 非空分配才原子加1，失败不计入；无_explicit的标准原子操作默认顺序一致性，不是把整份任务变成原子对象。
    if (pointer) atomic_fetch_add(&allocations, 1);
    // 把原始指针交调用者，释放需走配套tracked_free才会正确扣账。
    return pointer;
}

// 受跟踪free包装器，接缓冲指针返回void；非空先原子减活动块数，再交实际free。调用方须只传有效、配对且未重复释放的分配，不在此验证所有权。
static void tracked_free(void* pointer) {
    // 空指针不减账，避免free(NULL)也把计数减成负数。
    if (pointer) atomic_fetch_sub(&allocations, 1);
    // 真正释放内存；宏在本函数之后才定义，这里不递归。
    free(pointer);
}

// 从这里起把包含源码中的calloc标识替成tracked_calloc，以统计共享桥接的任务/数据分配，不接管整个Node进程分配器。
#define calloc tracked_calloc
// 同一预处理范围内把free替成tracked_free，涵盖正常完成和私有线程迟到结果释放。
#define free tracked_free
// 直接包含生产线程桥接和共享任务头，在这个编译单元里复用其static状态/方法；实际read_clipboard由下面测试实现提供。
#include "../../native/linux/src/clipboard-worker.h"
// 结束calloc名字替换，后续源码不再自动绕到包装器。
#undef calloc
// 恢复free原名；下面测试reader显式调用tracked_calloc以保持计数。
#undef free

// Exercise the production executor with a controlled blocking callback, without X11.
// 受控reader接独立任务，返回void：分配text缓冲→记录格式/读取次数→每约1ms休眠直到released，模拟卡住的原生操作，不调用N-API/X11。
// 例如原请求约3秒等待结束但未release，此函数仍可活在私有pthread；之后释放标志使其返回，真实桥接会清理迟到数据。
static void read_clipboard(clipboard_job* job) {
    // 分配5个清零字节并交任务拥有，准备4字节text外加末尾0。
    job->data = tracked_calloc(5, 1);
    // 断言分配成功，否则终止测试；不是给JS Promise记录一条可恢复错误。
    assert(job->data);
    // 只复制text的4个正文字节，第5字节沿用calloc的0；不把结束符计入正文。
    memcpy(job->data, "text", 4);
    // 记录正文长度4字节。
    job->length = 4;
    // 图片请求也返回同样text字节但标BUFFER，其余标UTF8；这是验证桥接转换的fixture数据，不是真正有效图片。
    job->format = job->operation == CLIPBOARD_IMAGE ? CLIPBOARD_BUFFER : CLIPBOARD_UTF8;
    // 字段填好后原子增加读取次数，CJS可观察reader已经进入，不等它完成才加。
    atomic_fetch_add(&reads, 1);
    // 每轮原子读released，未放行就继续；不会因外层Promise超时自动把此标志改true。
    while (!atomic_load(&released)) {
        // C指定字段初始化把tv_nsec设为1000000（1ms），其他字段如tv_sec清零；不是忙转1百万次。
        struct timespec delay = {.tv_nsec = 1000000};
        // 请求休眠约1ms，第二参数0表示不接剩余时间；返回状态/中断未检查，实际调度不保证精确1ms。
        nanosleep(&delay, 0);
    }
}

// 导出release的N-API回调，输入env/info、返回undefined句柄；把全模块放行标志设true，让在读线程结束等待，不直接free它的结果。
static napi_value release_reader(napi_env env, napi_callback_info info) {
    // 显式丢弃未使用的调用信息，不解析JS参数。
    (void)info;
    // 原子发布true，且不在下一次getText/getImage重置，所以后续两次成功读取可立即结束。
    atomic_store(&released, true);
    // 用共享工具返回JS undefined，未把释放动作包装成Promise。
    return undefined_value(env);
}

// 导出state的同步N-API回调，返回reads,allocations,busy文字；例如首个reader迟到未释放时可见1,1,1。
// 锁保护busy与桥接交接，两个计数仍各自原子读取，三字段不是一个同时发生的原子快照；用于测试预设同步点，不是通用一致性监控。
static napi_value get_state(napi_env env, napi_callback_info info) {
    // 不读取state()参数。
    (void)info;
    // 栈上80字节暂存格式化结果，随后创建独立JS字符串。
    char state[80];
    // 拿生产桥接同一把互斥锁，避免与busy变更交接相冲突；未检查锁返回码。
    pthread_mutex_lock(&worker_mutex);
    // 按十进制拼三个值，用sizeof限制缓冲，两个atomic_load各自读取；snprintf返回状态未核，不把busy当线程总数。
    snprintf(state, sizeof(state), "%d,%d,%d", atomic_load(&reads), atomic_load(&allocations), worker_busy);
    // 原生共享状态读完先解锁，再创建JS值。
    pthread_mutex_unlock(&worker_mutex);
    // 动态查UTF-8字符串创建API并转指针，这个测试入口未额外判空。
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    // 准备输出句柄，初始C空指针不是实际JS null。
    napi_value result = 0;
    // 按NUL求state文字长度并建立JS字符串，API状态未检查，依赖正常宿主测试环境。
    create_string(env, state, NAPI_AUTO_LENGTH, &result);
    // 返回该字符串句柄，不返回C栈缓冲指针给JS借用。
    return result;
}

// 模块装载时注册4个JS方法并返回exports；输入宿主env/导出对象，注册不启动私有读取，缺符号等沿共享工具的有限检查处理。
PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    // 挂真实共享getText入队回调。
    set_function_export(env, exports, "getText", get_clipboard_text);
    // 挂真实共享getImage入队回调，fixture给它相同字节但不同格式。
    set_function_export(env, exports, "getImage", get_clipboard_image);
    // 挂测试专用release，用于放行受控reader。
    set_function_export(env, exports, "release", release_reader);
    // 挂测试专用state，用于观察计数/门禁。
    set_function_export(env, exports, "state", get_state);
    // 返回同一导出对象，不主动执行这些方法。
    return exports;
}
