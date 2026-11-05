// X11协议/内存回归fixture：直接包含真实读取实现以测试内部static辅助，也可充当隔离X服务器上的受控剪贴板owner制造拒绝、坏元数据或半传输。
// native-clipboard-linux.test.ts编译并用不同argv模式驱动；metadata只跑内存断言，text/image和owner分支实际连DISPLAY，owner还会改变该服务器的CLIPBOARD所有者。
// 引入XCB声明；此文件不是通用剪贴板服务，只维护单个受控传输状态，不能在日常桌面会话随意执行。
#include <xcb/xcb.h>
// C assert失败终止测试；其中有调用真实生产函数的表达式，NDEBUG会连调用一起删掉，按测试默认启用断言解释。
#include <assert.h>
// 提供bool/true/false类型与常量。
#include <stdbool.h>
// 提供puts/fflush，把ready/requested等同步信号交父测试进程。
#include <stdio.h>
// 提供真实realloc/free，先定义包装器再启用宏替换以免递归。
#include <stdlib.h>
// 提供strcmp/memcpy等字节/字符串工具，实际生产源也复用这些声明。
#include <string.h>

// Track only allocations made by the clipboard implementation, not libxcb.
// This makes the partial-transfer leak regression deterministic, unlike RSS.
// 64槽静态指针账本初始全0，仅跟踪经过包装realloc的实现分配，不跟踪libxcb/全部进程内存。
static void* allocations[64];
// 配套每槽已分配字节数初始0；槽位与allocations逐项对应。
static size_t sizes[64];
// 当前跟踪存活字节总量，静态初值0，不是分配调用次数。
static size_t allocated_bytes;
// 跟踪峰值字节数，用来证明错误前确实收过部分数据，不只是在零分配路径碰巧没泄漏。
static size_t peak_bytes;

// 受跟踪realloc包装器，接旧指针/新大小返回真实结果；找到旧槽或NULL对应空槽，成功后更新当前/峰值字节账本。
// 例如4字节正文加NUL要5字节，再追加变9字节时总账替换旧5；固定最多64槽，断言是fixture前提，不是通用任意分配器。
static void* tracked_realloc(void* pointer, size_t size) {
    // 从账本第0槽开始查旧指针，pointer为NULL时会找第一个空槽。
    size_t index = 0;
    // 在64槽内逐项按地址比较，不解引用待重分配内存。
    while (index < 64 && allocations[index] != pointer) index++;
    // 断言能找到槽位；若禁assert且满表，后面的索引没有独立运行时保护。
    assert(index < 64);
    // 调用真实realloc，宏尚未启用；失败时旧分配仍由原指针拥有。
    void* result = realloc(pointer, size);
    // 仅非空成功结果才更新账本，当前生产调用大小至少1，不靠此包装支持realloc(ptr,0)全部平台语义。
    if (result) {
        // 从总量扣旧槽大小再加新大小，不把一次扩容同时算成两份永久分配。
        allocated_bytes = allocated_bytes - sizes[index] + size;
        // 记录此槽新大小。
        sizes[index] = size;
        // 记录重分配后可能变化的地址。
        allocations[index] = result;
        // 当前总量创新高才提升峰值，free不降低peak。
        if (allocated_bytes > peak_bytes) peak_bytes = allocated_bytes;
    }
    // 返回实际新指针或失败NULL，调用者仍按正常realloc规则处理。
    return result;
}

// 受跟踪free包装器，接地址返回void；若在账本就扣量/清槽，最后仍调用真实free，没跟踪的XCB对象也可正常释放。
static void tracked_free(void* pointer) {
    // 非空地址才扫64槽，NULL直接跳到真实free(NULL)。
    for (size_t index = 0; pointer && index < 64; index++) {
        // 按指针相等找到该次分配，不以内容相同认为同一缓冲。
        if (allocations[index] == pointer) {
            // 从当前总字节数扣此槽大小。
            allocated_bytes -= sizes[index];
            // 大小清0，准备复用槽。
            sizes[index] = 0;
            // 指针也清NULL，之后tracked_realloc(NULL,...)可使用它。
            allocations[index] = 0;
            // 找到一次就退出账本循环，不重复扣多个槽。
            break;
        }
    }
    // 最终交真实free；若指针不在账本也不伪造扣账，调用方仍须传可释放地址。
    free(pointer);
}

// 仅在下面include展开范围把realloc替为tracked_realloc，覆盖生产append_bytes分配。
#define realloc tracked_realloc
// 把该范围free替为tracked_free，跟踪生产错误清理，同时让未入账的XCB对象照常释放。
#define free tracked_free
// 包含真实X11源及其共享头，使本编译单元能直接调用static函数；不是复制一份测试镜像实现。
#include "../../native/linux/src/linux-platform-x11.c"
// 结束realloc宏替换，后面需统计时显式调用包装函数。
#undef realloc
// 恢复free名称，main里的事件释放正常调用C库。
#undef free

// 程序入口接argc/argv，返回退出码；metadata核内存元数据，text/image核失败清理，其他模式充当owner制造可控协议行为。
// 例如invalid发送一块后给错误类型的零元素终止块；partial发送一块后不结束，idle完全不回复。只检查参数个数，不对白名单外模式报专门错误。
int main(int argc, char** argv) {
    // 必须恰好1个模式参数（argc含程序名故为2），否则立即状态1。
    if (argc != 2) return 1;
    // metadata模式不建立X连接，直接测试append_property的受控输入。
    if (strcmp(argv[1], "metadata") == 0) {
        // 栈上准备一个Atom整数作正文，值是STRING编号；它不是这份属性自己的type标签。
        xcb_atom_t atom = XCB_ATOM_STRING;
        // C指定字段初始化构造合法32位ATOM列表块。
        property_data chunk = {
            // data借用栈上atom的字节视图，length是sizeof(atom)；append会复制，不接管这个栈地址。
            .data = (unsigned char*)&atom, .length = sizeof(atom),
            // 1个32位元素，属性类型ATOM；内容中那个元素恰好取STRING编号，类型和正文要分清。
            .items = 1, .format = 32, .type = XCB_ATOM_ATOM,
        };
        // 累计结果先清零，首次append可确立类型/格式并分配。
        property_data result = {0};
        // 断言第一份块成功追加，调用本身在assert表达式内。
        assert(append_property(&result, &chunk));
        // 再追加同一借用块，验证可连续累计，不把它误判为重复就跳过。
        assert(append_property(&result, &chunk));
        // 断言正文变两个Atom大小且元素数2，计量单位分别是字节/元素。
        assert(result.length == 2 * sizeof(atom) && result.items == 2);

        // 将新块format改8，故意不同于已累计的32。
        chunk.format = 8;
        // 元素数同时改sizeof(atom)，让总字节仍一致，专门触发格式不一致拒绝而非纯长度不符。
        chunk.items = sizeof(atom);
        // 断言格式改变的块不能并入。
        assert(!append_property(&result, &chunk));
        // 恢复format32，准备另一项破坏。
        chunk.format = 32;
        // 恢复1元素。
        chunk.items = 1;
        // 把块属性type改STRING，故意不同于累计ATOM。
        chunk.type = XCB_ATOM_STRING;
        // 断言类型改变也必须拒绝。
        assert(!append_property(&result, &chunk));
        // 恢复块类型ATOM。
        chunk.type = XCB_ATOM_ATOM;
        // 字节长度减1，与1个32位元素所需字节数不一致。
        chunk.length--;
        // 断言元素数/长度矛盾不能追加。
        assert(!append_property(&result, &chunk));
        // 这些失败后累计长度/项数仍是原2项；没有在本条比较全部原字节内容。
        assert(result.length == 2 * sizeof(atom) && result.items == 2);

        // The terminating chunk must agree with the preceding metadata too.
        // 把块长度和元素数同时清0，模拟终止块；连等号从右向左赋值。
        chunk.length = chunk.items = 0;
        // 零元素块仍故意给错误format8。
        chunk.format = 8;
        // 断言不能只见零长度就接受不同格式的结束标记。
        assert(!append_property(&result, &chunk));
        // 恢复与累计结果一致的32位格式。
        chunk.format = 32;
        // 这时合法空终止块应可追加，结果正文/项数不增加。
        assert(append_property(&result, &chunk));
        // 显式经跟踪free释放累计正文，保持账本扣减。
        tracked_free(result.data);
        // 断言被跟踪的累计字节全释放，不代表libxcb/系统资源的全面泄漏证明。
        assert(allocated_bytes == 0);
        // 输出validated供父测试精确比较。
        puts("validated");
        // 内存分支成功状态0结束，不进入owner路径。
        return 0;
    }
    // text/image模式是失败接收端测试：父测试另启invalid owner，当前进程使用真实读取路径。
    if (strcmp(argv[1], "text") == 0 || strcmp(argv[1], "image") == 0) {
        // 声明本次X连接上下文，open_clipboard负责初始化。
        x11_clipboard clipboard;
        // 断言真实连接/协议上下文准备成功；调用放在assert中，禁用断言会改变实际行为。
        assert(open_clipboard(&clipboard));
        // 待接收结果结构清零。
        property_data result = {0};
        // 按精确image模式选择图片，否则文本，调用真实read_selection并保存成功标志。
        bool received = read_selection(&clipboard, strcmp(argv[1], "image") == 0, &result);
        // 先关闭连接，再核失败/内存状态；不依赖进程退出掩盖连接清理。
        close_clipboard(&clipboard);
        // 预期坏元数据传输返回false，不是正常空内容true。
        assert(!received);
        // 失败路径应清空data指针和正文长度；没有逐项断言其他元数据。
        assert(!result.data && !result.length);
        // 峰值至少8192字节，证明临时接收块和累计副本曾同时分配（本场景每份约4096加NUL）；不是声明单块正文达到8192。
        assert(peak_bytes >= 8192); // Both the received chunk and accumulated data were allocated.
        // 随后跟踪存活字节必须回0，验证部分传输失败的清理。
        assert(allocated_bytes == 0);
        // 输出clean供父测试断言，不代表正常下载完成。
        puts("clean");
        // 失败清理按预期则以状态0结束该fixture。
        return 0;
    }

    // 其他模式进入受控owner路径，准备真实X11上下文。
    x11_clipboard clipboard;
    // 连接/建接收窗口等准备必须成功，否则断言终止。
    assert(open_clipboard(&clipboard));
    // 保存同一XCB连接引用，后续发事件/改属性都用它。
    xcb_connection_t* connection = clipboard.connection;
    // 取得UTF8_STRING目标Atom，供文本请求判断和广告。
    xcb_atom_t text = intern_atom(&clipboard, "UTF8_STRING");
    // 取得image/png Atom；fixture后面发的字节并非有效PNG，此处仅测试协议/字节传输。
    xcb_atom_t image = intern_atom(&clipboard, "image/png");
    // 把本窗口设为当前DISPLAY的CLIPBOARD owner，会改变该X服务器剪贴板所有权；安全边界来自父测试的独立Xvfb，而非本函数自行识别桌面。
    xcb_set_selection_owner(connection, clipboard.window, clipboard.clipboard, XCB_CURRENT_TIME);
    // Wait for the server to process selection ownership before reporting ready.
    // 再发InternAtom并等回复，利用同连接请求顺序确认前面的所有权请求已被服务器处理；不是直接读取owner值再断言相等。
    assert(intern_atom(&clipboard, "READY") != XCB_NONE);
    // 打印ready告诉父进程可以开始请求。
    puts("ready");
    // 立刻刷新stdout，避免管道缓冲让父测试一直等ready。
    fflush(stdout);

    // 当前正文传输请求者XID初始NONE，尚无接收方。
    xcb_window_t requestor = XCB_NONE;
    // 当前传输承接属性Atom初始NONE。
    xcb_atom_t property = XCB_NONE;
    // 当前请求目标初始NONE，后面按请求保存。
    xcb_atom_t target = XCB_NONE;
    // 记录是否已经发过第一块；全fixture一个状态，不为每个新请求重设，也非通用多客户端服务。
    bool sent_chunk = false;
    // 准备接事件对象指针，下一行循环赋值后再读取。
    xcb_generic_event_t* event;
    // 阻塞等事件并将指针赋给event；双括号强调条件中的赋值，连接结束/无事件错误返回NULL才退出。
    while ((event = xcb_wait_for_event(connection))) {
        // 屏蔽最高发送标志后取事件类型编号。
        uint8_t type = event->response_type & 0x7f;
        // 所有者收到SelectionRequest时进入转换响应路径。
        if (type == XCB_SELECTION_REQUEST) {
            // 按事件类型将通用指针当SelectionRequest读取，强转本身不验证线上各字段。
            xcb_selection_request_event_t* request = (xcb_selection_request_event_t*)event;
            // 打印requested供父测试同步观察请求已到。
            puts("requested");
            // 刷新管道输出，父测试可据此断开X服务器来制造故障。
            fflush(stdout);
            // idle模式完全不答这次转换，让读取方走期限失败。
            if (strcmp(argv[1], "idle") == 0) {
                // 提前释放本事件，避免continue跳过循环末尾释放。
                free(event);
                // 继续等下一事件，不发SelectionNotify或正文。
                continue;
            }
            // 默认回报请求指定的属性，拒绝格式时会改为NONE。
            xcb_atom_t response_property = request->property;
            // direct-text模式故意不广告TARGETS，只支持直接UTF8_STRING。
            if (strcmp(argv[1], "direct-text") == 0) {
                // 仅精确文本目标命中才提供正文。
                if (request->target == text) {
                    // 固定多字节样例，源码编译环境按测试UTF-8文字解释；不是从用户剪贴板读取的内容。
                    const char value[] = "café 日本語";
                    // 替换请求者窗口属性，参数跨下一行；生产reader随后会在同一属性取字节。
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                        // 属性类型UTF8_STRING、元素8位，sizeof(value)-1剔除C末尾NUL，长度按字节而非汉字/码元数。
                        request->property, text, 8, sizeof(value) - 1, value);
                // 其他目标（包括TARGETS）走拒绝通知。
                } else {
                    // 把响应property改NONE，告知不提供此目标而不是伪造空ATOM广告表。
                    response_property = XCB_NONE;
                }
            // 非direct-text模式正常响应TARGETS查询。
            } else if (request->target == clipboard.targets) {
                // 广告2项：UTF8_STRING与image/png，顺序不影响生产reader的本地格式优先级。
                xcb_atom_t targets[] = {text, image};
                // 把广告Atom数组写到请求者属性，参数续下一行。
                xcb_change_property(connection, XCB_PROP_MODE_REPLACE, request->requestor,
                    // 类型ATOM、元素32位、数量2，count不是数组总字节大小。
                    request->property, XCB_ATOM_ATOM, 32, 2, targets);
            // 其余正文目标进入INCR握手准备，没有独立白名单验证每一个请求目标。
            } else {
                // 保存当前接收方XID供以后观察它删属性。
                requestor = request->requestor;
                // 保存该接收方承接正文的属性Atom。
                property = request->property;
                // 保存请求目标，后面第一块以它作属性类型。
                target = request->target;
                // 准备订阅对方窗口属性变化事件，接收删除确认。
                uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
                // 在本客户端连接上为requestor窗口选择属性通知；不是把对方的全部事件路由改成自己。
                xcb_change_window_attributes(connection, requestor, XCB_CW_EVENT_MASK, &mask);
                // INCR头宣告一个8192值，fixture实际只发一份4096块再制造故障；生产reader不按宣告数预分配。
                uint32_t length = 8192;
                // 写INCR握手头到接收属性，参数续下一行。
                xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor,
                    // 属性类型INCR、每元素32位、1项，正文是length地址指向的整数值。
                    property, clipboard.incr, 32, 1, &length);
            }
            // union使选择通知结构和32字节发送视图共享存储，不是在内存里顺次放两份字段。
            union {
                // 具名selection视图供指定字段初始化。
                xcb_selection_notify_event_t selection;
                // 32字节字符视图满足xcb_send_event的固定事件载荷大小，不能只拿sizeof较短结构推断应发送长度。
                char bytes[32];
            // 定义notification变量并指定初始化selection成员，下面逐字段对应请求信息。
            } notification = { .selection = {
                // 回报事件类型SelectionNotify。
                .response_type = XCB_SELECTION_NOTIFY,
                // 沿用请求时间戳，不用本地Date或墙钟转换。
                .time = request->time,
                // 回报原请求窗口XID。
                .requestor = request->requestor,
                // 回报原selection Atom。
                .selection = request->selection,
                // 回报原target Atom。
                .target = request->target,
                // 成功时用原属性，拒绝时用先前改成的NONE。
                .property = response_property,
            } };
            // 向请求者定向发送32字节事件，propagate=false且事件掩码0，不开启对整个桌面的广播。
            xcb_send_event(connection, false, request->requestor, XCB_EVENT_MASK_NO_EVENT, notification.bytes);
            // flush尝试把排队写/通知送出；可能阻塞，返回状态未检查，不能仅凭调用便保证成功到达。
            xcb_flush(connection);
        // 属性变化事件进入INCR推进路径，而不是把任意鼠标/键盘事件当读取请求。
        } else if (type == XCB_PROPERTY_NOTIFY) {
            // 按类型解释成PropertyNotify。
            xcb_property_notify_event_t* notification = (xcb_property_notify_event_t*)event;
            // 要求来自当前保存的请求窗口和属性，条件继续下一行。
            if (notification->window == requestor && notification->atom == property &&
                // 还须是属性删除，作为接收者已读/准备下一块的确认；新增值通知不驱动这里发块。
                notification->state == XCB_PROPERTY_DELETE) {
                // 尚未发过第一块才进入发送分支。
                if (!sent_chunk) {
                    // 栈上4096字节清零正文，制造可计量的部分传输，不是有效PNG图像。
                    unsigned char chunk[4096] = {0};
                    // 用请求目标作属性类型、format8、4096个元素替换属性；XCB复制/排发送内容，不让服务端长期借用本栈缓冲。
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor, property, target, 8, sizeof(chunk), chunk);
                    // 记已发过一块，后续删除确认不再反复发送同块。
                    sent_chunk = true;
                // 第一块之后，仅invalid模式再发错误结束块；partial等其他模式故意不继续。
                } else if (strcmp(argv[1], "invalid") == 0) {
                    // Reject the terminating chunk after allocating the preceding data.
                    // 零元素终止块故意改类型ATOM/format32，与先前target/format8冲突，验证生产reader不能只见0项就宣布成功。
                    xcb_change_property(connection, XCB_PROP_MODE_REPLACE, requestor, property, XCB_ATOM_ATOM, 32, 0, 0);
                // 其余模式不发送正确零元素结束块，读取方应超时；这是受控故障，不是完整INCR实现。
                } // Otherwise never finish the transfer; the reader must time out.
                // 刷新本次属性更新（或无新更新的队列），返回状态未检查。
                xcb_flush(connection);
            }
        }
        // 本轮事件处理后释放XCB对象；idle已提前释放并continue，不会再到这里重复free。
        free(event);
    }
    // 事件循环结束后按正常控制流关闭X连接；父测试强杀fixture时并不保证走到这里。
    close_clipboard(&clipboard);
}
