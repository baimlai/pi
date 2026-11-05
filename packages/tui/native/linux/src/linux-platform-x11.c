// Linux的X11剪贴板读取主体：经XCB连接DISPLAY对应的X服务器，选择文本/图片目标格式，通过窗口属性接收普通或INCR分块数据。
// clipboard-worker.h把这里的实际reader放在私有线程，clipboard.h负责入队和转JS值；此模块只导出getText/getImage，不拥有或写入用户剪贴板。
// 读取会连接本机或DISPLAY指定的远端服务器、建立未显示的小窗口并交换协议消息；2秒是共享协议deadline，不覆盖所有libxcb阻塞，外层等待超时也不会强杀线程。
// 引入XCB核心连接/事件及基础X协议声明；include只是编译期展开，不在此建立显示连接。
#include <xcb/xcb.h>
// 提供strlen/memcpy/memset；这里的长度按字节或协议元素计，不统一当Unicode字符数。
#include <string.h>
// 引入xcb_poll_for_reply等扩展层API，供按cookie序号非阻塞探测回复。
#include <xcb/xcbext.h>
// 提供线程局部errno和EINTR，用来识别poll被信号中断后是否重试。
#include <errno.h>
// 提供pollfd/POLLIN/poll，等待X连接文件描述符可读，不是查询终端键盘输入。
#include <poll.h>
// 提供timespec和单调时钟函数，后面转换成毫秒deadline。
#include <time.h>
// 展开共享私有读取线程和N-API桥接实现；本文件稍后定义其声明的read_clipboard，不因include就启动线程。
#include "clipboard-worker.h"

// 最多累计50×1024×1024字节，即50MiB正文；u表示无符号常量，额外分配的末尾NUL不计入此上限。
#define MAX_CLIPBOARD_BYTES (50u * 1024u * 1024u)
// 协议发现/回复/分块共用2000毫秒预算，不是每一个分块各重置2秒。
#define CLIPBOARD_TIMEOUT_MS 2000

// 文本目标优先级表，元素是指向常量字符的常量指针；static保留模块内存储，依次尝试匹配而非按对方广告顺序挑。
static const char* const text_types[] = {
    // 优先两种charset拼写，再UTF8_STRING/text/plain，最后旧STRING；最终只有STRING走Latin-1，其他文本目标按UTF-8交JS。
    "text/plain;charset=utf-8", "text/plain;charset=UTF-8", "UTF8_STRING", "text/plain", "STRING",
};
// 图片目标也按此本地顺序优先；只选择字节格式，不在本文件解码或转码图片。
static const char* const image_types[] = {
    // 依次偏好PNG、JPEG、WebP、GIF、BMP、TIFF，传回具体原字节而非统一转换成PNG。
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp", "image/tiff",
};

// 取单调时钟的整数毫秒，返回int64_t，无外部状态修改；例如相隔约0.5秒的两个结果差约500，用于差值/截止而非日历时间。
// clock_gettime返回状态未检查；不能承诺系统时钟调用失败时也能得到有效期限。
static int64_t monotonic_ms(void) {
    // 声明秒/纳秒结构，尚未由本行初始化内容。
    struct timespec now;
    // 把CLOCK_MONOTONIC当前值写到now，不受通常的墙钟日期跳变直接影响。
    clock_gettime(CLOCK_MONOTONIC, &now);
    // 先转64位再把秒乘1000，加纳秒整数除1000000；不足1毫秒部分被截去，不是四舍五入。
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

// 一次属性读取或累计传输的数据结构，typedef命名为property_data；字节长度、元素数量、每元素位数和类型Atom分开保存。
typedef struct {
    // 拥有的C字节缓冲，追加工具用realloc扩容；不是XCB回复对象内部借用的指针。
    unsigned char* data;
    // 正文总字节数，不含工具额外补的末尾0；即使图片也按字节计。
    size_t length;
    // 协议元素数量，元素大小由format决定，不能直接等同length。
    uint32_t items;
    // X属性每元素位数，合法读取只接受8/16/32；不是图片宽度、颜色深度或MIME编号。
    uint8_t format;
    // 属性类型的32位Atom标识，例ATOM表示原子列表、STRING表示旧文本；它和format是独立字段。
    xcb_atom_t type;
// 结束结构并定义C类型名，声明本身不分配一份传输缓冲。
} property_data;

// 一次显示连接/接收窗口及协议Atom/截止时间的上下文；不是系统剪贴板内容的永久缓存。
typedef struct {
    // XCB连接对象指针，失败连接也可非NULL，必须用connection_has_error判断；最终由close_clipboard断开。
    xcb_connection_t* connection;
    // 本读取器临时接收窗口的XID，不是进程窗口指针或终端行列。
    xcb_window_t window;
    // CLIPBOARD selection的Atom，表示读取常规剪贴板，而非鼠标选中的PRIMARY。
    xcb_atom_t clipboard;
    // PI_CLIPBOARD属性名Atom，所有者把转换结果写到本窗口这个属性。
    xcb_atom_t property;
    // TARGETS目标Atom，用来问所有者能提供哪些格式。
    xcb_atom_t targets;
    // INCR类型Atom，用来识别需要属性变化握手的增量传输。
    xcb_atom_t incr;
    // 整次协议操作共用的单调毫秒绝对deadline，循环不断减它，不每轮续期。
    int64_t deadline;
// 给结构命名x11_clipboard，栈上变量由open_clipboard清零并填写。
} x11_clipboard;

// 将length字节追加到result并补NUL，成功true、超限/分配失败false；不修改输入bytes，不负责释放整个result。
// 例如已有3字节再加2字节，正文length变5，另留第6字节为0；图片正文长度也不包含该0。依赖调用流程维持result.length≤上限。
static bool append_bytes(property_data* result, const unsigned char* bytes, size_t length) {
    // 用剩余额度做减法检查新块，避免直接把两长度相加再比较；假定已有length未超MAX，不能当任意损坏结构的完整验证器。
    if (length > MAX_CLIPBOARD_BYTES - result->length) return false;
    // 为旧正文+新正文+1个NUL重分配，先存局部指针，失败时旧result.data仍可由调用者释放。
    unsigned char* data = realloc(result->data, result->length + length + 1);
    // 扩容失败返回false，不覆盖旧指针或更新length。
    if (!data) return false;
    // 从旧末尾开始复制确切length字节，调用方须提供有效且不与目标重叠的源范围。
    memcpy(data + result->length, bytes, length);
    // 复制后更新正文长度，未把终止符算进去。
    result->length += length;
    // 在新正文末尾写0，便于C文本使用；二进制图片中间的0不会在此被裁掉。
    data[result->length] = 0;
    // 扩容/复制成功后才把新指针保存回result。
    result->data = data;
    // 返回追加成功；没有在此更新type/format/items，元数据由调用方处理。
    return true;
}

// Share one deadline across discovery, replies, and incremental chunks.
// Connection setup and flushing are libxcb calls on the private thread.
// 等X连接可读，接上下文返回bool；在共享deadline内poll，只有EINTR才重新计算剩余时间重试，超时/连接错误等返回false。
// 例如poll被信号中断不会给它重新分配完整2秒；这里只等套接字可读，不解析回复或保证数据就是所需事件。
static bool wait_for_input(x11_clipboard* clipboard) {
    // 无限语法循环由deadline/错误/可读分支返回结束，不是持续忙等不阻塞。
    for (;;) {
        // 每次用同一绝对截止减当前毫秒，信号重试也消耗原预算。
        int64_t remaining = clipboard->deadline - monotonic_ms();
        // 没有剩余时间或XCB已进入错误状态就false，||短路时不必再问连接。
        if (remaining <= 0 || xcb_connection_has_error(clipboard->connection)) return false;
        // pollfd依次存连接fd、关心POLLIN、初始revents=0；不是创建新套接字。
        struct pollfd descriptor = {xcb_get_file_descriptor(clipboard->connection), POLLIN, 0};
        // 只监视1个fd，剩余毫秒转int作最长等待参数；正常本流程从2秒预算得来，不另处理任意超大deadline的强转。
        int ready = poll(&descriptor, 1, (int)remaining);
        // poll非负就返回是否至少一个事件且含POLLIN；超时0为false，只含HUP/ERR而无IN不算可读，不是逐种错误分别报。
        if (ready >= 0) return ready && (descriptor.revents & POLLIN);
        // poll负值只在errno为EINTR时回到循环，其他错误立即false，不把中断当成功可读。
        if (errno != EINTR) return false;
    }
}

// 按请求cookie序号等待回复，成功返回需调用者free的通用指针，失败/无回复返回0；会flush并在共用期限内poll。
// 例如intern_atom把返回地址当对应reply类型读；收到协议错误时丢错误详情并可返回空reply，超时后声明不再接收该序号回复。flush自身可阻塞，非整个函数硬时限。
static void* wait_for_reply(x11_clipboard* clipboard, unsigned sequence) {
    // 先flush已排请求；XCB文档说明它可能等到发送完成，失败在此早返，不先走下面discard。
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    // 只在共享截止前继续探测，不为这次请求重设deadline。
    while (monotonic_ms() < clipboard->deadline) {
        // 每次探测的reply输出指针先置空。
        void* reply = 0;
        // 协议错误对象输出指针也先置空，后面单独释放。
        xcb_generic_error_t* error = 0;
        // 非阻塞查询给定sequence是否已有回复/错误结果，通过两个地址输出对象；此调用不是xcb_wait_for_reply的无期限等待。
        if (xcb_poll_for_reply(clipboard->connection, sequence, &reply, &error)) {
            // 丢弃协议错误对象（空指针可free），不把其错误码传到JS。
            free(error);
            // 把reply所有权交调用者；即使探测表示已处理，出错时reply仍可能为空。
            return reply;
        }
        // 暂时没有回复才等fd可读；等待false就退出，不继续自旋。
        if (!wait_for_input(clipboard)) break;
    }
    // 期限耗尽或等待失败后丢弃该sequence后续回复/关联错误，XCB此API不等待回复真的到达；不取消远端已经处理的请求。
    xcb_discard_reply(clipboard->connection, sequence);
    // 统一返回空指针让上层失败，不在此创建Error。
    return 0;
}

// 在共享截止内取某一种X事件，接type返回需free的事件指针或0；先flush，再丢弃其他事件并等待更多输入。
// 例如等SelectionNotify时遇旧PropertyNotify会释放后继续；本方法只筛事件编号，不替调用者核selection/target/property等字段。
static xcb_generic_event_t* wait_for_event(x11_clipboard* clipboard, uint8_t type) {
    // 先发送排队请求，flush失败早返；这一步可能阻塞在XCB内部。
    if (xcb_flush(clipboard->connection) <= 0) return 0;
    // 沿同一deadline循环，不每次遇无关事件延长期限。
    while (monotonic_ms() < clipboard->deadline) {
        // 非阻塞取队列/连接上的下一事件或协议错误，暂无事件也可返回空；结果需调用者释放。
        xcb_generic_event_t* event = xcb_poll_for_event(clipboard->connection);
        // 有事件对象才读其响应类型。
        if (event) {
            // 清response_type最高的发送事件标记后与所需type比较，匹配就交出指针，不在此释放它。
            if ((event->response_type & 0x7f) == type) return event;
            // 不匹配的事件/错误对象直接释放，不保存在备用队列。
            free(event);
        // 本轮无事件时才等fd可读，若等失败就退出。
        } else if (!wait_for_input(clipboard)) {
            // 离开等待循环，不继续读取过期事件。
            break;
        }
    }
    // 失败/超时返回空，未把协议错误对象内容附到返回值。
    return 0;
}

// 读取本接收窗口上的指定属性并复制正文，接remove控制读取后的删除请求、写result，返回是否成功复制；回复对象始终在本函数正常路径free。
// 流程是发GetProperty→等回复→核格式/长度/是否剩尾→复制；例如format32的10项为40字节。这里检查线上元数据，不信任只看C字段类型就认为长度有效。
static bool read_property(x11_clipboard* clipboard, bool remove, property_data* result) {
    // 发送属性查询，得到携带请求序号的cookie；调用表达式跨下面两行参数。
    xcb_get_property_cookie_t cookie = xcb_get_property(
        // 传连接、remove删除标记、接收窗口XID和固定属性名；删除由X协议按属性读取规则执行，不是删除文件。
        clipboard->connection, remove, clipboard->window, clipboard->property,
        // 接受任意属性类型，从偏移0读，long_length按4字节单位所以传MAX/4；不因format8就把这个参数也当单字节数。
        XCB_GET_PROPERTY_TYPE_ANY, 0, MAX_CLIPBOARD_BYTES / 4
    );
    // 用cookie.sequence等回复并作为GetProperty回复读取，void*按C规则可转换到此对象指针。
    xcb_get_property_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    // 没有回复直接false，没有可free的回复对象。
    if (!reply) return false;
    // 先记未成功复制，只有全部元数据检查和append成功才改true。
    bool copied = false;
    // 线上format只允许每元素8/16/32位，0或其他值不作为有效数据。
    bool valid_format = reply->format == 8 || reply->format == 16 || reply->format == 32;
    // 先把value_len提升64位再乘每元素字节数，避免32位乘法先溢出；此行还没据valid_format排除异常format。
    uint64_t length = (uint64_t)reply->value_len * (reply->format / 8);
    // 要求回复没有未读取尾部、type非NONE且format有效，&&短路，条件继续下一行。
    if (reply->bytes_after == 0 && reply->type != XCB_NONE && valid_format &&
        // 正文不能超过50MiB，也不能超reply声明的附加载荷4字节单元长度；这是上界检查，不要求等于含填充的reply.length*4。
        length <= MAX_CLIPBOARD_BYTES && length <= (uint64_t)reply->length * 4) {
        // 记录协议类型Atom供后续格式选择/INCR检测。
        result->type = reply->type;
        // 记录每元素位数，而非把它改成字节。
        result->format = reply->format;
        // 保存协议元素数量，和字节length分开。
        result->items = reply->value_len;
        // 取reply内部正文指针并复制到result独立缓冲，转换到size_t前已限制50MiB；append失败仍保留false。
        copied = append_bytes(result, xcb_get_property_value(reply), (size_t)length);
    }
    // 释放XCB原回复及其内部载荷，不释放已复制到result的数据。
    free(reply);
    // 返回复制状态；前面可能已写元数据，false不意味着result所有字段仍完全原样。
    return copied;
}

// 把INCR的一块数据接到累计result，接只读chunk返回成功bool；先核元数据一致/元素计数无溢出，再追加字节并累计items。
// 例如先收UTF8格式8位块，末尾零元素块也须保持类型/格式一致，不能用不同格式的空块骗过结束判断；失败不由本函数统一free累计缓冲。
static bool append_property(property_data* result, const property_data* chunk) {
    // 块格式非8/16/32任一种就失败，后面的||继续列不合法条件。
    if ((chunk->format != 8 && chunk->format != 16 && chunk->format != 32) ||
        // 没有类型Atom也拒绝，不能把NONE块当有效结束帧。
        chunk->type == XCB_NONE ||
        // 以64位核“元素数×每元素字节数”等于chunk.length，不接受元数据与实际块长度不一致。
        (uint64_t)chunk->items * (chunk->format / 8) != chunk->length ||
        // 累计结果已有类型时要求新块type和format相同；首块result.type为NONE时才允许确立格式。
        (result->type != XCB_NONE && (result->type != chunk->type || result->format != chunk->format)) ||
        // 新块items不得超过uint32剩余空间；任一前置条件真就返回false，不先累加再检查回绕。
        chunk->items > UINT32_MAX - result->items) return false;
    // 元数据合格后复制正文，byte预算/分配失败仍false；不借用chunk.data作为最终存储。
    if (!append_bytes(result, chunk->data, chunk->length)) return false;
    // 追加成功后保存一致的类型。
    result->type = chunk->type;
    // 保存每元素位数，空结束块也会走这里。
    result->format = chunk->format;
    // 累计元素数量，前面已经验证不越uint32上限。
    result->items += chunk->items;
    // 返回本块成功并入，chunk自身缓冲仍由调用者释放。
    return true;
}

// 请求所有者把CLIPBOARD转换成指定target并写入本窗口属性，接上下文/Atom/空结果结构，返回传输是否正常结束。
// 先等SelectionNotify并读属性；普通数据直接结束，INCR则丢握手头、删除属性确认、逐块读/删/累计到零元素终止。true可以是没有所有者/不提供此格式，不能等同一定拿到了非空正文。
// 会改本接收窗口的属性、发转换请求但不抢selection所有权；失败可能留下部分result.data，由上层read_selection或preferred_target释放，不提供所有者内容的原子快照。
static bool request_selection(x11_clipboard* clipboard, xcb_atom_t target, property_data* result) {
    // 清零输出结构，调用者须按当前流程传空结果；不会先释放它原有指针，不能当可重复覆盖任意结果的通用工具。
    memset(result, 0, sizeof(*result));
    // 先删除旧接收属性，避免把前一次值当这次转换结果；这里未检查void cookie的异步错误。
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);
    // 向服务器提交selection转换请求，参数续到下面两行。
    xcb_convert_selection(
        // 指定当前连接、本接收窗口和CLIPBOARD selection，不更换selection所有者。
        clipboard->connection, clipboard->window, clipboard->clipboard,
        // 指定所需格式、承接结果的属性名和CURRENT_TIME时间标记；不向对方发送本机日历时间。
        target, clipboard->property, XCB_CURRENT_TIME
    );

    // 持续等匹配选择通知，底层wait_for_event共用期限以限制正常协议等待。
    while (true) {
        // 按事件类型拿SelectionNotify并转具体结构指针，不靠C强转验证事件所有字段。
        xcb_selection_notify_event_t* event = (xcb_selection_notify_event_t*)wait_for_event(clipboard, XCB_SELECTION_NOTIFY);
        // 没有通知则失败，空结果或已有部分结果的所有权仍在调用流程。
        if (!event) return false;
        // 仅核selection与target等于本次请求；未另核requestor/time或通知property恰等固定属性名。
        bool matches = event->selection == clipboard->clipboard && event->target == target;
        // property非NONE表示所有者通知有结果；这里只看有无标记，下一次实际读取仍使用上下文固定属性。
        bool received = event->property != XCB_NONE;
        // 所需比较值已存到bool局部，先释放事件，后面不再访问event字段。
        free(event);
        // 不属于本selection/target就继续等待，不把无关通知作为结果。
        if (!matches) continue;
        // 匹配通知但property为NONE，按无所有者或不支持target正常结束，result仍清零；不是传输错误false。
        if (!received) return true; // No owner, or the owner does not offer this target.
        // 先不删属性地读取结果；GetProperty失败则false，INCR头也先作为普通属性获取。
        if (!read_property(clipboard, false, result)) return false;
        // 首份属性已读到，离开选择通知循环。
        break;
    }
    // 不是INCR类型就直接true；调用者再据类型解释正文，不进入分块握手。
    if (result->type != clipboard->incr) return true;

    // INCR首属性只是握手信息，释放刚复制的头部数据；不按其中宣告长度预分配结果。
    free(result->data);
    // 再次清零结果，真实分块的类型/格式由后续首块建立。
    memset(result, 0, sizeof(*result));
    // 删除INCR头属性作为接收方准备就绪确认，让所有者发送下一块；删除请求后由等待函数flush。
    xcb_delete_property(clipboard->connection, clipboard->window, clipboard->property);

    // 逐次等待新属性通知，底层仍使用原deadline，不因收到一块而续期。
    while (true) {
        // 读取PropertyNotify并转为具体事件，通知对象本身不包含完整块字节。
        xcb_property_notify_event_t* event = (xcb_property_notify_event_t*)wait_for_event(clipboard, XCB_PROPERTY_NOTIFY);
        // 超时/失败直接false，累计过的result保留给上层统一清理。
        if (!event) return false;
        // 仅接受固定property且状态NEW_VALUE的通知，不把删除通知当新块；此处未另核事件window字段。
        bool matches = event->atom == clipboard->property && event->state == XCB_PROPERTY_NEW_VALUE;
        // 取完匹配标志后释放通知对象。
        free(event);
        // 其他属性或删除通知继续跳过，不读取旧值。
        if (!matches) continue;

        // 每块用新的清零property_data，本块临时字节和累计result分开拥有。
        property_data chunk = {0};
        // 读取并请求删除本块属性，删除让所有者推进下一块；失败时当前新chunk未取得可成功交付的缓冲。
        if (!read_property(clipboard, true, &chunk)) return false;
        // 先核元数据并复制追加到累计result，保存成功标志，不能只凭长度为0认结束。
        bool appended = append_property(result, &chunk);
        // 零元素是协议结束标记，和字符串内容恰好为0字节值不同。
        bool finished = chunk.items == 0;
        // 累计器持有独立副本，所以不论append成功与否都释放本块临时缓冲。
        free(chunk.data);
        // 追加/元数据验证失败就false，即使这是零元素块也不能判成功。
        if (!appended) return false;
        // 已验证并追加的零元素块终止成功；否则继续等下一块。
        if (finished) return true;
    }
}

// 按NUL结尾的短常量名字取得/创建服务器Atom，返回32位标识或NONE；发请求并在共用期限内等回复，释放回复对象。
// 例如CLIPBOARD与image/png都是协议名字而非本机文件路径；false的only_if_exists允许服务器尚无此名时创建，未缓存到全局跨连接表。
static xcb_atom_t intern_atom(x11_clipboard* clipboard, const char* name) {
    // 发送InternAtom，false允许创建，strlen取名字字节数；API name_len为16位，本文件传入的固定名字都很短，未做通用长字符串校验。
    xcb_intern_atom_cookie_t cookie = xcb_intern_atom(clipboard->connection, false, strlen(name), name);
    // 按cookie序号等待并把通用回复作为InternAtom结构读取。
    xcb_intern_atom_reply_t* reply = wait_for_reply(clipboard, cookie.sequence);
    // 没有回复返回XCB_NONE，不抛JS错误。
    if (!reply) return XCB_NONE;
    // 在free前把Atom整数复制到局部。
    xcb_atom_t atom = reply->atom;
    // 释放XCB回复，Atom只是服务器编号，不需也不能拿来free。
    free(reply);
    // 交回编号，后续上下文或目标数组保存它。
    return atom;
}

// 准备一次X11读取上下文：清零→设期限→按DISPLAY连接→选screen→建未映射1×1接收窗口→查询四个协议Atom，返回是否具备后续流程所需编号。
// 例如DISPLAY可指定远端服务器，不保证只走本机；连接/flush可能阻塞，窗口请求没有逐个同步验错。false也可能已经有连接，调用者仍须close_clipboard。
static bool open_clipboard(x11_clipboard* clipboard) {
    // 先清零所有字段，保证早失败时connection等能被末尾清理判断；不先释放旧上下文，当前按新栈变量调用。
    memset(clipboard, 0, sizeof(*clipboard));
    // 从建连接前开始算共享2秒deadline；后续发现/传输沿用，连接耗时也会消耗预算，但不是以此强制中断xcb_connect。
    clipboard->deadline = monotonic_ms() + CLIPBOARD_TIMEOUT_MS;
    // 准备接DISPLAY选择的screen编号，默认先0。
    int screen_number = 0;
    // displayname为0让XCB使用DISPLAY环境并输出screen编号；即使失败它也返回可检查/清理的非NULL连接对象。
    clipboard->connection = xcb_connect(0, &screen_number);
    // 用错误状态而非指针非空判断是否连接正常，失败交上层清理该对象。
    if (xcb_connection_has_error(clipboard->connection)) return false;
    // 从连接建立信息取得各screen根窗口迭代器，data/rem/index是XCB结构，不是JS数组。
    xcb_screen_iterator_t screens = xcb_setup_roots_iterator(xcb_get_setup(clipboard->connection));
    // 只要目标screen编号还大于0且仍有screen就推进；后置--即使判不进循环也会改变局部screen_number，不再使用原编号。
    while (screen_number-- > 0 && screens.rem) xcb_screen_next(&screens);
    // 没有可用screen就失败，不在这里换DISPLAY或新连接。
    if (!screens.rem) return false;

    // 从连接分配窗口XID，未在此单独核失败的ID，也尚未等服务器确认建窗。
    clipboard->window = xcb_generate_id(clipboard->connection);
    // 事件掩码只订阅该接收窗口属性变化，用于INCR握手通知。
    uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    // 发送创建窗口请求，下面三行列参数，返回cookie未在本函数检查。
    xcb_create_window(
        // 使用父窗口深度，指定新XID；不加载或创建终端TUI组件。
        clipboard->connection, XCB_COPY_FROM_PARENT, clipboard->window,
        // 根窗口作parent，位置0/0、大小1×1、边框0、InputOutput类；这里只创建未映射窗口，没有调用map使它显示。
        screens.data->root, 0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
        // visual也继承父窗口，value_mask声明后面的值是事件掩码，&mask传对应属性值地址。
        XCB_COPY_FROM_PARENT, XCB_CW_EVENT_MASK, &mask
    );
    // 取得CLIPBOARD selection名字Atom，不查询或抢走它的owner。
    clipboard->clipboard = intern_atom(clipboard, "CLIPBOARD");
    // 取得本窗口接收属性名PI_CLIPBOARD的Atom。
    clipboard->property = intern_atom(clipboard, "PI_CLIPBOARD");
    // 取得TARGETS格式发现目标的Atom。
    clipboard->targets = intern_atom(clipboard, "TARGETS");
    // 取得INCR增量传输类型Atom，用来识别首属性是否握手头。
    clipboard->incr = intern_atom(clipboard, "INCR");
    // 四个编号都非0才返回true，C逻辑&&结果转换为bool；不代表已有内容或后续传输必成功。
    return clipboard->clipboard && clipboard->property && clipboard->targets && clipboard->incr;
}

// 关闭一次上下文，接指针返回void；非空连接交XCB断开并释放内部资源，没有另发显式DestroyWindow或把字段归零，按本流程只清理一次。
static void close_clipboard(x11_clipboard* clipboard) {
    // connection存在才断开，包括错误连接；重复调用旧非空悬挂指针不受本函数保护。
    if (clipboard->connection) xcb_disconnect(clipboard->connection);
}

// 根据image选择本地优先格式，查询所有者TARGETS并在*target输出首个共同Atom，返回流程成功bool；不在本函数读取最终正文。
// 例如所有者同时给PNG/JPEG就选本地表先列的PNG；合法广告无共同格式也可true并保持target=NONE。拒绝TARGETS时文本尝试UTF8_STRING兜底，图片不盲猜，协议坏元数据/超时可false。
static bool preferred_target(x11_clipboard* clipboard, bool image, xcb_atom_t* target) {
    // 条件选择图片或文本常量指针表，不复制所有名字；const限制经此视图修改字符和元素指针。
    const char* const* types = image ? image_types : text_types;
    // 图片固定6种、文本5种，与上面数组定义配套，未自动用sizeof计算数量。
    size_t type_count = image ? 6 : 5;
    // 栈上最多6个Atom槽，下面只读写type_count个已填项，不依赖剩余未初始化槽。
    xcb_atom_t wanted[6];
    // 按本地偏好顺序逐个解析格式名字。
    for (size_t index = 0; index < type_count; index++) {
        // 在当前连接取得该格式Atom，可能创建服务器名字，仍未请求该格式正文。
        wanted[index] = intern_atom(clipboard, types[index]);
        // 任一格式名字解析失败就false，不继续用部分wanted列表。
        if (wanted[index] == XCB_NONE) return false;
    }

    // 创建空TARGETS接收结果，待发现流程填正文/格式。
    property_data targets = {0};
    // 把TARGETS自身作为转换目标，所有者按协议把可提供格式的Atom数组写来；true可能没有正文。
    bool received = request_selection(clipboard, clipboard->targets, &targets);
    // 要求返回属性类型是ATOM且每元素32位，后面的&&继续核字节布局。
    bool valid = targets.type == XCB_ATOM_ATOM && targets.format == 32 &&
        // 元素数应等于字节长度/Atom大小且整除；本机XCB Atom是uint32，检查不依赖把任意字节直接强转就当合法列表。
        targets.items == targets.length / sizeof(xcb_atom_t) && targets.length % sizeof(xcb_atom_t) == 0;
    // 发现请求成功且元数据合格才遍历广告列表。
    if (received && valid) {
        // 把独立分配的正文按Atom数组读取；这里只解释数值列表，不读取名字字符串。
        xcb_atom_t* offered = (xcb_atom_t*)targets.data;
        // 外层按本地wanted顺序优先，保证服务端广告顺序不改变偏好。
        for (size_t wanted_index = 0; wanted_index < type_count; wanted_index++) {
            // 内层在所有广告元素里找当前偏好Atom。
            for (uint32_t offered_index = 0; offered_index < targets.items; offered_index++) {
                // 同一个服务器里的整数Atom相等就是同目标类型。
                if (offered[offered_index] == wanted[wanted_index]) {
                    // 命中后先释放临时TARGETS字节表。
                    free(targets.data);
                    // 经输出指针保存选中Atom，*target不是修改格式名字常量。
                    *target = wanted[wanted_index];
                    // 成功返回，最终正文稍后由read_selection再请求。
                    return true;
                }
            }
        }
    }
    // 无匹配或发现无有效表时也释放TARGETS缓冲，free接受空；仍可读结构中的数值字段，不能再读被释放的data。
    free(targets.data);
    // Some owners refuse TARGETS but still serve text directly.
    // 发现正常但type为NONE且请求文本时启用兜底；它不区分无owner和owner不肯列TARGETS，图片模式不走此分支。
    if (received && !image && targets.type == XCB_NONE) {
        // 输出UTF8_STRING Atom，后面会直接尝试该正文格式，不先证明所有者确实支持。
        *target = intern_atom(clipboard, "UTF8_STRING");
        // 能解析这个名字就true，真正读取仍可能空/失败。
        return *target != XCB_NONE;
    }
    // 发现成功并且（表合法或type为NONE）才true；合法表无共同类型、图片无广告等均可保留target=NONE，坏类型/布局通常false。
    return received && (valid || targets.type == XCB_NONE);
}

// 选择合适目标并读正文，接上下文/image/空结果，返回是否正常完成；没有共同目标也算正常空结果，传输失败则释放并清零部分缓冲。
// 例如INCR已收一块后超时，request_selection留的部分字节在这里统一free，避免只返回false却泄漏；没有回退到另一种格式再重试的循环。
static bool read_selection(x11_clipboard* clipboard, bool image, property_data* result) {
    // 目标初始NONE，preferred_target可在无共同格式时让它保持不变。
    xcb_atom_t target = XCB_NONE;
    // 先完成格式选择，失败时&&短路，不发送正文请求；赋值条件继续下一行。
    bool received = preferred_target(clipboard, image, &target) &&
        // 目标NONE直接视为正常空读取，否则按选中Atom请求正文；||短路避免把NONE当真实格式发转换。
        (target == XCB_NONE || request_selection(clipboard, target, result));
    // 发现或正文传输失败才清理部分result，不把正常空内容当错误。
    if (!received) {
        // 释放可能已经累计的普通/分块字节，空指针也安全。
        free(result->data);
        // 清零指针/长度/元数据，调用者不会把半份内容当成功返回。
        memset(result, 0, sizeof(*result));
    }
    // 返回总体成功标志，不代表result.length必须大于0。
    return received;
}

// 由私有pthread调用的实际平台reader，接独立worker_result任务、写数据/格式/错误并返回void；不调用N-API或访问原JS值。
// 流程建连接→读文本/图片→转移缓冲→关闭连接；连接/准备失败保留UNAVAILABLE，已连接后的读取失败记录错误，正常无内容标EMPTY。例STRING正文标Latin-1，其余文本目标按UTF-8。
static void read_clipboard(clipboard_job* job) {
    // 栈上声明上下文，open_clipboard负责先清零；无成功返回也要走末尾close。
    x11_clipboard clipboard;
    // 只有上下文准备成功才开始格式发现/读取，失败不在这里设置job.error。
    if (open_clipboard(&clipboard)) {
        // 独立内容结果先清零，读失败时由read_selection清理。
        property_data contents = {0};
        // 操作恰是IMAGE就选图片目标表，否则当前正常入口为TEXT；读取false和空内容true不同。
        if (!read_selection(&clipboard, job->operation == CLIPBOARD_IMAGE, &contents)) {
            // 读取/协议验证失败记录静态错误消息，外层共享完成回调稍后尝试拒绝Promise。
            job->error = "Could not read X11 clipboard";
        // 读取正常完成则把内容所有权交任务，不再在这里free该缓冲。
        } else {
            // 保存独立字节缓冲指针，不把XCB回复内部内存直接借给JS。
            job->data = contents.data;
            // 保存正文长度，不含append_bytes补的末尾NUL。
            job->length = contents.length;
            // 没有data指针优先标EMPTY，即使请求图片也如此；非空指针且IMAGE的分支继续下一行，零字节但有缓冲不自动当空。
            job->format = !contents.data ? CLIPBOARD_EMPTY : job->operation == CLIPBOARD_IMAGE
                // 图片标BUFFER；文本类型恰为STRING才标LATIN1，其余标UTF8，类型名本身并不验证文字编码或图片签名。
                ? CLIPBOARD_BUFFER : contents.type == XCB_ATOM_STRING ? CLIPBOARD_LATIN1 : CLIPBOARD_UTF8;
        }
    }
    // 成功、准备失败或读取失败均在正常控制流末尾断开连接；进程崩溃等情况不保证还能执行这里。
    close_clipboard(&clipboard);
}

// 模块注册入口接env/exports，返回同一exports，挂getText/getImage两个共享异步入口；只是注册，不在加载时连DISPLAY或读取剪贴板。
// PI_NAPI_EXPORT保留宿主查找入口的可见性；set_function_export缺符号/创建失败等不是逐项强保证，此处也不提供setText或getFilePaths。
PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    // 将共享get_clipboard_text挂为getText，后来调用才准备TEXT任务并入队。
    set_function_export(env, exports, "getText", get_clipboard_text);
    // 将共享图片回调挂为getImage，后来调用才走IMAGE目标选择。
    set_function_export(env, exports, "getImage", get_clipboard_image);
    // 返回同一导出对象，不另复制JS方法表。
    return exports;
}
