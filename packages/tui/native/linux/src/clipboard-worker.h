// Linux剪贴板的额外私有线程桥接：共享N-API工作在这里有限等待，真正可能卡住的X11读取交给单个pthread，避免长期占住libuv工作线程。
// linux-platform-x11.c包含本头并定义read_clipboard；本头是手写内部实现，没有自己的include guard，应在每个编译单元内最多展开一次。
// 超时只结束这次等待，未杀掉读线程；它若始终不返回，后续请求保持不可用。静态状态属于模块的C状态，不按每个JS Promise或Node环境各建一份。
// 提供pthread线程、互斥锁、条件变量及一次初始化类型/函数声明；include本身不创建线程。
#include <pthread.h>
// 提供timespec、clock_gettime和CLOCK_MONOTONIC，用单调时钟构造绝对等待截止值。
#include <time.h>
// 引入clipboard_job与N-API异步桥接；本头补实现clipboard_execute，结果转换/Promise结算仍在共享完成回调。
#include "../../clipboard.h"

// 前置声明实际读函数：接可写任务指针、返回void，定义由包含本头的X11主体或受控测试fixture稍后提供；声明不开始读取。
static void read_clipboard(clipboard_job* job);
// 静态互斥锁用宏初始化，保护busy/waiting/finished和结果交付；不是每次请求new一把锁。
static pthread_mutex_t worker_mutex = PTHREAD_MUTEX_INITIALIZER;
// 静态once控制块用PTHREAD_ONCE_INIT初始化，用于协调条件变量/符号的首次准备。
static pthread_once_t worker_once = PTHREAD_ONCE_INIT;
// 条件变量对象具有静态存储期而先清零，但必须initialize成功后才可用，不能只凭清零就当已初始化。
static pthread_cond_t worker_changed;
// 四个bool静态初值均false：ready为条件变量可用，busy为已有读者，waiting为原调用者仍等结果，finished为私有读取已完成。
static bool worker_ready, worker_busy, worker_waiting, worker_finished;
// 共享结果结构静态清零，私有线程写它而不持有原N-API job，避免原请求结束后再写已释放任务。
static clipboard_job worker_result;
// int (*名字)(...)声明函数指针，稍后从宿主动态查到pthread_cond_signal；静态初值为空，声明不发送通知。
static int (*signal_worker)(pthread_cond_t*);
// 定时等待函数指针接条件变量、互斥锁、只读绝对timespec并返回状态码；const限制经该指针改deadline，不是运行时冻结。
static int (*wait_for_worker)(pthread_cond_t*, pthread_mutex_t*, const struct timespec*);

// pthread_once首次调用的无参初始化器，返回void；解析条件变量API、建立单调时钟属性并初始化worker_changed，成功把worker_ready置true。
// 例如缺一个符号会保留ready=false，调用者按不可用返回；这些普通早返回仍算once初始化器已经返回，后续不会因此自动重试。
static void initialize_worker_condition(void) {
    // Unversioned ELF imports otherwise bind obsolete condition variables on glibc x64.
    // 在局部声明带具体参数签名的初始化函数指针并动态取地址；按原英文避开glibc x64的旧条件变量版本绑定问题，不额外打开新共享库。
    int (*initialize)(pthread_cond_t*, const pthread_condattr_t*) = node_symbol("pthread_cond_init");
    // 查条件通知函数，保存到模块静态指针，不在此唤醒线程。
    signal_worker = node_symbol("pthread_cond_signal");
    // 查绝对时间等待函数，下面先检查三项地址都存在；地址类型不能自行证明完整ABI一致。
    wait_for_worker = node_symbol("pthread_cond_timedwait");
    // 任一符号缺失则立即结束，不调用空函数指针，也不设置错误消息到某个请求。
    if (!initialize || !signal_worker || !wait_for_worker) return;
    // 声明局部条件变量属性对象，尚未完成属性初始化。
    pthread_condattr_t attributes;
    // 属性初始化非0就返回；还没成功初始化的attributes不在此调用destroy。
    if (pthread_condattr_init(&attributes) != 0) return;
    // 先把属性时钟设为CLOCK_MONOTONIC，要求返回0；&&短路且赋值表达式继续下一行。
    worker_ready = pthread_condattr_setclock(&attributes, CLOCK_MONOTONIC) == 0 &&
        // 设时钟成功后才按属性初始化worker_changed；两步都成功才把ready置true，否则false，不尝试其他时钟。
        initialize(&worker_changed, &attributes) == 0;
    // 销毁局部属性，不销毁已经创建的条件变量；返回状态未检查，静态条件变量在本实现没有逐任务销毁。
    pthread_condattr_destroy(&attributes);
}

// pthread私有读取入口：接未使用的void*参数，调用实际reader写worker_result，再持锁标完成、交接或丢弃迟到数据，返回空指针线程结果。
// 例如原调用者超时离开后读取才完成，此线程释放结果并解busy；不调用N-API，也不访问已经可能释放的原job。读函数若不返回，后面的交接不会执行。
static void* read_on_private_thread(void* unused) {
    // 显式转void说明参数有意不用；调用方传0，没有对象要在此释放。
    (void)unused;
    // 不持worker_mutex执行可能阻塞的X11读取，只写共享结果；busy门禁阻止别的请求启动第二个读者。
    read_clipboard(&worker_result);
    // 读取结束后获取互斥锁，与等待方同步；本实现未检查加锁状态码，按锁API正常工作约定继续。
    pthread_mutex_lock(&worker_mutex);
    // 持锁标记reader已完成，等待方唤醒后以此决定是否取结果。
    worker_finished = true;
    // 原调用者已不再等待则走迟到清理；不限于正常超时，也可能是等待API返回其他错误。
    if (!worker_waiting) {
        // 释放迟到读结果的C缓冲，free接受空指针；不把这份数据再交给已经离开的请求。
        free(worker_result.data); // The caller timed out; discard the late result.
        // 迟到结果处理后释放busy门禁，使后续请求可以重新读取；指针未在本行清零，新任务稍后会整体覆盖worker_result。
        worker_busy = false;
    }
    // 持锁通知条件变量上可能等待的调用者；不是JS事件、也不直接结算Promise，通知状态未检查。
    signal_worker(&worker_changed);
    // 释放互斥锁，等待方重获锁后可观察finished和结果；返回状态未检查。
    pthread_mutex_unlock(&worker_mutex);
    // 以空void*结束线程函数；这不是JS null，也不等于强行结束其他线程。
    return 0;
}

// 共享N-API execute回调调用的平台主体，接原任务指针、返回void：先准备条件变量，再在空闲时启动一个私有读者并等约3秒截止。
// 读取及时完成便把缓冲所有权/格式/错误转到job，忙、初始化失败、建线程失败或等待未完成则保持原job默认UNAVAILABLE，正常完成桥接可返回undefined。
// 例如A等超时而私有读者仍在，B不再排第二个reader；原读者最终结束才恢复可用。3秒只针对条件等待，锁竞争/调度/原生API异常等不提供整个函数硬时限。
static void clipboard_execute(clipboard_job* job) {
    // pthread_once协调一次初始化并等该初始化器返回，函数状态未检查；普通初始化早返回不因ready=false自动重跑。
    pthread_once(&worker_once, initialize_worker_condition);
    // 条件变量不可用就结束，不写job.error，所以默认结果仍与不可用一致。
    if (!worker_ready) return;
    // 持锁检查和改变共享状态，防两个工作线程都看到空闲后各启动一个reader。
    pthread_mutex_lock(&worker_mutex);
    // 只在没有活动私有读取时进入；busy时跳过整个分支并到末尾解锁，不再等3秒。
    if (!worker_busy) {
        // 连等号从右向左赋true，同时记读取在途和当前调用者在等；这不是对两个独立bool的原子硬件赋值，正确性依靠持锁。
        worker_busy = worker_waiting = true;
        // 新一轮先清finished，不能把上次完成标志拿来当这次成功。
        worker_finished = false;
        // C复合字面量建立清零任务，只指定operation，再赋值覆盖共享结构；不复制原job的deferred/work等宿主句柄给私有线程。
        worker_result = (clipboard_job){.operation = job->operation};
        // 声明保存绝对截止的秒/纳秒结构，下一句请求时钟填写它。
        struct timespec deadline;
        // 按与条件属性相同的单调时钟取当前值，未检查返回码；不能说时钟失败也有完整超时兜底。
        clock_gettime(CLOCK_MONOTONIC, &deadline);
        // 只把秒字段加3而保留纳秒，给X11主体自身约2秒传输截止多留时间报告错误；不是3秒后强制杀线程。
        deadline.tv_sec += 3; // Allow the two-second transfer deadline to report its own error first.
        // 准备接pthread线程句柄，不是JS Promise或N-API async_work句柄。
        pthread_t thread;
        // 创建默认属性线程并传0给入口，返回0才进入等待；worker_mutex仍被调用者持有，私有reader可先读，完成交接时再来争锁。
        if (pthread_create(&thread, 0, read_on_private_thread, 0) == 0) {
            // 请求分离线程，使正常结束后可自行回收线程资源，不需pthread_join；未检查detach是否成功，也不因detach而中止读取。
            pthread_detach(thread);
            // Only this bounded wait occupies libuv. Other callers return unavailable.
            // 未完成且等待返回0才继续循环；条件等待原子释放互斥锁、醒来后重获锁，所以别的请求能检查busy，reader也能交结果。
            // 同一绝对deadline反复使用，醒来不重置3秒；循环重查finished以应对通知/伪唤醒，非0（含超时/其他错误）则退出空循环体。
            while (!worker_finished && wait_for_worker(&worker_changed, &worker_mutex, &deadline) == 0) {}
            // 退出等待后再看finished，而非仅凭等待状态判成功；截止附近已经完成也可以采用结果。
            if (worker_finished) {
                // 把结果数据指针移交job，未复制整块字节；之后由共享完成回调释放，私有线程在有等待者的路径不会另free这块。
                job->data = worker_result.data;
                // 复制相应长度字段，具体单位服从结果格式。
                job->length = worker_result.length;
                // 复制EMPTY/UTF8/LATIN1/BUFFER等格式，完成阶段据此建JS值。
                job->format = worker_result.format;
                // 复制reader记录的静态错误消息指针，不在这里throw或reject。
                job->error = worker_result.error;
                // 已完成且交接后解除busy，下次可新建reader；旧结构残留指针只作旧值，不再由旧线程释放。
                worker_busy = false;
            }
        // pthread_create非0进入失败分支，没有启动本次私有线程。
        } else {
            // 恢复空闲，原job不写入专门建线程错误，仍走默认不可用。
            worker_busy = false;
        }
        // 当前调用者不再等待；若reader还在busy保持true，它完成后会看到waiting=false并释放迟到缓冲。
        worker_waiting = false;
    }
    // 释放互斥锁并结束平台执行；正常异步桥接随后才回JS线程转换/结算，不在此调用系统命令或重试reader。
    pthread_mutex_unlock(&worker_mutex);
}
