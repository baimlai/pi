// 为平台原生模块提供最小 N-API 类型与动态符号工具；clipboard.h 和平台 C/Objective-C 实现包含本头，构建时不依赖完整 Node 头或特定运行时链接库。
// N-API 是 JS 运行时供原生模块调用的接口；ABI 是底层参数、返回和调用约定。本文件手写函数指针签名，实际符号在模块运行时从宿主查找，不因声明类型就验证宿主 ABI。
// 头文件保护：第一次包含时尚无 PI_NAPI_H 才展开后续正文，同一编译单元重复包含会跳过。
#ifndef PI_NAPI_H
// 定义保护宏，确保下一次 include 不再重复这些 typedef/函数定义；宏在预处理阶段生效。
#define PI_NAPI_H

// Resolve the small N-API surface we use from Node or Bun, without Node headers
// or a link-time dependency on a particular runtime.
// 提供 C 的 bool/true/false 定义，供后面的 N-API 布尔参数使用。
#include <stdbool.h>
// 提供 size_t 等内存大小类型，不是 JS number；实际位宽由目标平台决定。
#include <stddef.h>
// 提供 uint16_t/uint32_t 等精确宽度整数，便于按 UTF-16 码元和数组索引传参。
#include <stdint.h>
// 编译目标定义 _WIN32 时采用 Windows 类型/符号查找分支，依据是编译目标而非运行时 process.platform。
#ifdef _WIN32
// 从系统 Windows SDK 引入句柄、GetModuleHandle/GetProcAddress 等声明。
#include <windows.h>
// Windows 的回调/函数指针使用 __cdecl 调用约定，匹配本接口期望的宿主约定。
#define PI_NAPI_CALL __cdecl
// 给模块初始化入口添加 DLL 导出标记，使宿主能按约定名字找到它。
#define PI_NAPI_EXPORT __declspec(dllexport)
// 非 Windows 编译目标改用下方动态链接符号接口和可见性标记。
#else
// 提供 dlsym/RTLD_DEFAULT，后面只查询已加载进程的可见符号，不在这里 dlopen 新库。
#include <dlfcn.h>
// 非 Windows 分支把调用约定宏展开为空，使用该平台默认规则。
#define PI_NAPI_CALL
// 显式默认可见性用于保留需要公开的原生导出，其他代码可按构建参数隐藏。
#define PI_NAPI_EXPORT __attribute__((visibility("default")))
// 结束平台条件；下面类型两边共用，前面的宏已选好各自展开形式。
#endif

// 把 -1 转成无符号 size_t 得到最大可表示值，作为字符串自动长度哨兵；按 NUL（值0的终止字符）求长，不是真分配这么多字节。
#define NAPI_AUTO_LENGTH ((size_t)-1)

// typedef 为 void* 起别名：env 是宿主上下文的不透明指针，只透传，不解引用成自定义结构。
// 这些轻量别名都落成 void*，C 编译器无法像官方不同结构指针那样区分它们；不能靠名字就认为任意句柄可互换。
typedef void* napi_env;
// napi_value 表示 JS 值句柄；C 空指针0和真正的 JS null/undefined 值句柄含义不同。
typedef void* napi_value;
// 本次 JS→原生调用的信息句柄，由获取参数的 API 读取，不是参数数组本身。
typedef void* napi_callback_info;
// 异步工作项句柄，保存到任务后用于入队/删除，不是系统线程句柄。
typedef void* napi_async_work;
// Promise 的待结算句柄，交 resolve/reject API 使用；它和返回给 JS 的 Promise 值是两项输出。
typedef void* napi_deferred;
// 函数指针 typedef：括号内 *名字 表示可指向函数，前面的 void 是返回类型；执行回调接 env 和任务 data，在工作线程运行，不应操作 JS 值。
typedef void (PI_NAPI_CALL *napi_async_execute_callback)(napi_env, void*);
// 完成回调接 env、整型状态和同一任务 data，回到 JS 运行时所属线程处理结果；这里用 int 表示 N-API 状态，0 代表成功。
typedef void (PI_NAPI_CALL *napi_async_complete_callback)(napi_env, int, void*);
// 创建异步工作的函数指针：接 env、异步资源/名字、执行/完成回调、用户 data，并通过末尾 napi_async_work* 写工作句柄；返回状态码，声明本身不排任务。
typedef int (PI_NAPI_CALL *napi_create_async_work_fn)(napi_env, napi_value, napi_value, napi_async_execute_callback, napi_async_complete_callback, void*, napi_async_work*);
// 创建空 JS 数组的函数指针，napi_value* 是输出参数地址；返回 int 状态而非直接返回数组。
typedef int (PI_NAPI_CALL *napi_create_array_fn)(napi_env, napi_value*);
// 入队/删除异步工作共用的签名：env 加工作句柄返回状态码；具体调用哪项功能由查到的符号名字决定。
typedef int (PI_NAPI_CALL *napi_async_work_fn)(napi_env, napi_async_work);
// 创建 Promise 的签名通过两个输出指针分别写 deferred 和 JS Promise 句柄；调用成功也尚未执行剪贴板。
typedef int (PI_NAPI_CALL *napi_create_promise_fn)(napi_env, napi_deferred*, napi_value*);
// resolve/reject deferred 共用 env、待结算句柄、JS 结果值三个参数，返回状态；兑现还是拒绝由动态符号选择。
typedef int (PI_NAPI_CALL *napi_settle_deferred_fn)(napi_env, napi_deferred, napi_value);
// 创建 JS Error 对象：接可选错误码值、消息值，通过输出指针返回对象；创建 Error 不等于立即 throw。
typedef int (PI_NAPI_CALL *napi_create_error_fn)(napi_env, napi_value, napi_value, napi_value*);
// JS 可调用的原生回调签名：输入 env/info，直接返回 napi_value；和返回状态码的 API 函数指针不同。
typedef napi_value (PI_NAPI_CALL *napi_callback)(napi_env, napi_callback_info);
// 创建 Buffer 副本的签名：输入字节数和只读源地址，可选输出新缓冲地址 void**，并输出 JS Buffer 值；不借用源指针作为最终 JS 内存。
typedef int (PI_NAPI_CALL *napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
// 创建 JS 函数的签名：UTF-8 名称/长度、原生回调与用户数据作为输入，最后写出函数值；实际调用回调发生在后来 JS 调用函数时。
typedef int (PI_NAPI_CALL *napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
// 按 UTF-8 字节建立 JS 字符串，size_t 长度按字节计；同样签名也用于查找 Latin-1 创建函数，但编码语义由符号决定。
typedef int (PI_NAPI_CALL *napi_create_string_utf8_fn)(napi_env, const char*, size_t, napi_value*);
// 按 16 位码元创建 JS 字符串，长度按 uint16_t 元素数而非字节数；调用方要先选对编码/单位。
typedef int (PI_NAPI_CALL *napi_create_string_utf16_fn)(napi_env, const uint16_t*, size_t, napi_value*);
// 把 C bool 转为 JS 布尔值，最后一个指针输出结果句柄，返回的 int 是 API 状态。
typedef int (PI_NAPI_CALL *napi_get_boolean_fn)(napi_env, bool, napi_value*);
// 读取调用参数：argc* 输入缓冲容量并被更新，argv 接参数，后面可选 this 值输出与 void**附加数据输出；本项目可传0表示不需要这些输出。
typedef int (PI_NAPI_CALL *napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
// 获取 undefined/null 等单值共用 env 和值输出指针的签名；通过不同符号取得不同 JS 值。
typedef int (PI_NAPI_CALL *napi_get_value_fn)(napi_env, napi_value*);
// 把 JS 字符串读为 UTF-8：可写目标、容量和实际长度输出；目标0/容量0用于先查询所需长度，不进行任意 JS 值的自动字符串强转。
typedef int (PI_NAPI_CALL *napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);
// UTF-16 版本以 uint16_t 缓冲区和码元容量/长度传参；和 UTF-8 的字节单位分开，调用时需为末尾 NUL 额外留空间。
typedef int (PI_NAPI_CALL *napi_get_value_string_utf16_fn)(napi_env, napi_value, uint16_t*, size_t, size_t*);
// 按 UTF-8 属性名给 JS 对象设置某个 JS 值，返回状态；exports 的挂方法工具会用它。
typedef int (PI_NAPI_CALL *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
// 按 uint32_t 索引设置 JS 数组/对象元素，返回状态；文件路径数组依次用它放入字符串。
typedef int (PI_NAPI_CALL *napi_set_element_fn)(napi_env, napi_value, uint32_t, napi_value);
// 抛 JS Error 的签名接 C 字符串错误码/消息，code 可空；设置运行时异常状态，不会像 C++ throw 一样自动终止后续 C 语句。
typedef int (PI_NAPI_CALL *napi_throw_error_fn)(napi_env, const char*, const char*);

// 按名字查宿主已导出的函数地址，成功返回 void*，没找到返回空指针；不加载新库、不缓存结果或验证函数签名。
// 例：node_symbol("napi_get_boolean") 的结果需再转成对应函数指针并检查。static 让工具只在包含本头的编译单元内使用，不能跨模块按此名直接导入。
static void* node_symbol(const char* name) {
// 以下分支由预处理选择，编译后不会保留两套操作系统调用。
#ifdef _WIN32
    // 先取当前主程序模块句柄，参数0表示当前进程可执行模块，不额外 LoadLibrary。
    HMODULE module = GetModuleHandleA(0);
    // 有模块才按 name 查导出，转换为通用指针；三元另一支用0表达没地址。
    void* proc = module ? (void*)GetProcAddress(module, name) : 0;
    // 主程序已导出此名就直接返回，不再查 node.dll。
    if (proc) return proc;
    // 否则尝试当前进程中已经加载的 node.dll，未找到不会主动把 DLL 装进来。
    module = GetModuleHandleA("node.dll");
    // 只有取得该模块句柄才查符号，否则返回空地址；不在这里生成 JS 异常。
    return module ? (void*)GetProcAddress(module, name) : 0;
// 非 Windows 的实现改为 POSIX 风格符号查询。
#else
    // 在默认可见的已加载符号集合查 name，可能来自宿主或其依赖；未另外读 dlerror 的错误原因。
    return dlsym(RTLD_DEFAULT, name);
// 结束平台实现选择，两个分支都直接返回查找结果。
#endif
}

// 尝试取得 JS undefined 的值句柄供返回路径使用，无参数值读取；env 为宿主上下文。
// 例：fail 在设置异常后调用它作为 C 回调返回值。符号缺失会保留空指针，API 返回状态也未检查，因此不保证任何异常宿主上都拿到有效句柄。
static napi_value undefined_value(napi_env env) {
    // 动态查符号并转为共用的单值获取函数指针；类型转换不执行该 API。
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_undefined");
    // 先以 C 空指针初始化结果，尚不是真正的 JS undefined。
    napi_value result = 0;
    // 存在函数才调用，通过 &result 写句柄；没有检查返回的状态码。
    if (get_value) get_value(env, &result);
    // 返回当前结果，可能是取得的 JS 值，也可能仍为空。
    return result;
}

// 尝试取得 JS null 句柄，流程与 undefined_value 一样，返回当前结果而非保证成功。
// 例：剪贴板格式标为空时，完成回调用它兑现 null；无符号/调用失败没有独立抛错处理。
static napi_value null_value(napi_env env) {
    // 本次查的是 napi_get_null，虽然使用相同函数指针签名，含义不同。
    napi_get_value_fn get_value = (napi_get_value_fn)node_symbol("napi_get_null");
    // 空指针占位，等待 API 输出 JS null 的真实句柄。
    napi_value result = 0;
    // 有符号才尝试赋结果，状态未检查。
    if (get_value) get_value(env, &result);
    // 返回结果，C 的0不能直接等同于 JS null。
    return result;
}

// 尝试向 env 设置一个 JS 错误，并返回 undefined 句柄；消息是调用方提供的 NUL 终止字符串，不释放该消息。
// 例：队列准备失败调用 fail(env,"Out of memory")。没有抛错符号时不会凭空制造异常，返回值也受 undefined_value 的有限检查约束。
static napi_value fail(napi_env env, const char* message) {
    // 按名字查抛错函数，指针可能为空。
    napi_throw_error_fn napi_throw_error = (napi_throw_error_fn)node_symbol("napi_throw_error");
    // 若存在就以空错误码、指定消息设置 JS 异常；忽略状态，下一句 C 仍继续执行。
    if (napi_throw_error) napi_throw_error(env, 0, message);
    // 返回共享 undefined_value 的结果，异常是否已经设置由前一步实际成功与否决定。
    return undefined_value(env);
}

// 尝试把一个原生回调挂为 exports 的命名 JS 函数，返回 void；先查两个符号、创建函数，再设置属性，不立即执行 callback。
// 例：name="getText" 时导出调用入口。缺符号/创建失败便不设置；属性设置的状态也未检查，因此不保证全部导出一定安装成功。
static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
    // 取得创建 JS 函数的宿主 API 地址。
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    // 声明设置对象属性的函数指针，赋值在下一行继续。
    napi_set_named_property_fn napi_set_named_property =
        // 查所需的属性设置符号；这是C强制类型转换，不是完整ABI验证。
        (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    // 用于接收新 JS 函数的句柄，初值为空。
    napi_value fn = 0;
    // 两个符号必须都有才执行下一行创建；&& 短路避免调用空函数指针。
    if (napi_create_function && napi_set_named_property &&
        // 按 NUL 终止 name 自动求长，关联 callback、无额外用户 data，通过 &fn 输出；只有状态0才进设置分支。
        napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &fn) == 0) {
        // 给原 exports 设置 name 属性为新函数，返回状态未用；没有复制 exports 或执行回调。
        napi_set_named_property(env, exports, name, fn);
    }
}

// 结束整份头文件保护，与最前面的 PI_NAPI_H 条件配对。
#endif
