// macOS原生模块主体：同步查询当前修饰键，后台读/写文本、读图片及Finder文件路径；native-platform.ts加载.node后调用这些导出。
// build.sh用Objective-C/ARC编译本文件和共享头；N-API负责JS边界，AppKit/CoreGraphics负责实际系统操作，注册导出本身不读取剪贴板。
// #import在预处理时引入框架声明并避免重复引入；AppKit提供NSPasteboard/NSImage等能力，不是JS import或立即创建界面。
#import <AppKit/AppKit.h>
// 引入CoreGraphics的事件标志类型、修饰键掩码和会话状态查询函数。
#import <CoreGraphics/CoreGraphics.h>
// 引入NSString/NSData/NSURL/NSArray等基础对象；Objective-C对象指针和下方C字节指针的生命周期管理不同。
#import <Foundation/Foundation.h>
// C运行库声明供共享任务内存分配等使用，不会因为include就分配内存。
#include <stdlib.h>
// 引入strcmp/strlen/memcpy，用于名字比较、字节求长和复制。
#include <string.h>
// 在展开共享头之前打开写入功能，编入clipboard_copy和setText回调；这是编译期开关，不是运行时授权。
#define PI_CLIPBOARD_WRITE
// 共享头给出clipboard_job、异步任务桥接、JS结果转换和N-API动态符号工具；本文件实现其中声明的clipboard_execute。
#include "../../clipboard.h"

// 把NUL结尾的C键名转换成CoreGraphics位掩码，返回0表示不认识；输入指针须有效，不修改文字、不查询键盘。
// 例如"option"映射Alternate掩码；strcmp精确区分大小写，所以"Shift"不匹配。static把函数限制在当前编译单元。
static CGEventFlags modifier_mask_for_name(const char* name) {
    // strcmp返回0表示相同；命中shift就立刻返回Shift掩码，不继续比较。
    if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
    // command表示macOS Command键，不是执行shell命令。
    if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
    // control精确映射Control掩码，不与Command混用。
    if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
    // option对应系统名Alternate，即通常所说的Alt/Option修饰键。
    if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
    // 所有名字都未命中则返回空掩码，不抛JS错误。
    return 0;
}

// 作为isModifierPressed的N-API回调：接宿主env/info，读取首个JS字符串，查询当前会话标志，再返回JS布尔句柄。
// 例如传"shift"检查调用这一刻的合并会话状态，不是还原某次终端事件，也不区分左右Shift；缺参数/未知名字等路径保留false。
// 参数和返回创建API并非全部保证成功；创建布尔值失败尝试fail，其他宿主异常也没有统一清理或恢复机制。
static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
    // 动态查取参数API并转成函数指针；类型转换不执行API，也不验证宿主ABI。
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    // 声明UTF-8字符串提取函数指针，赋值表达式跨到下一行。
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 =
        // 按符号名查找并转换地址，尚未从JS参数取文字。
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    // 查将C bool变成JS布尔值的API，下面另外检查这个指针。
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    // 默认认为未按下，只有有效名字且对应位出现时才改true。
    bool pressed = false;
    // 两个参数读取函数都存在才解析，&&短路避免调用空函数指针。
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        // argc先声明可容纳1个参数，再通过地址让API更新数量；本函数不逐个处理额外参数。
        size_t argc = 1;
        // 建立1个空句柄槽，{0}清零；C空指针不是JS null值本身。
        napi_value args[1] = {0};
        // 要求取参状态0、至少一个参数且有句柄；后两个0表示不索取this值和附加data，失败时不进入查询。
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            // 16字节C数组先清零，容量含末尾NUL；这是字节上限，不是最多16个Unicode字符。
            char name[16] = {0};
            // copied接收实际复制的UTF-8字节数，后面未用它验证完整名称或是否发生截断。
            size_t copied = 0;
            // 把首参按UTF-8读入固定缓冲，sizeof(name)包含终止空间；只判API状态，不自动把任意JS值转字符串。
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                // 按得到的NUL结尾文字查掩码；C字符串在首个NUL停下，未单独验证原JS字符串没有内嵌NUL。
                CGEventFlags mask = modifier_mask_for_name(name);
                // 只有已识别名字才查询系统，未知名字直接保留false。
                if (mask != 0) {
                    // 读取当前登录会话所有事件源合并的修饰标志；不是只看物理键盘HID，也不等待下一次按键。
                    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
                    // 按位与&取目标位，再与0比较成C bool；不会修改原flags。
                    pressed = (flags & mask) != 0;
                }
            }
        }
    }

    // 准备接返回的JS值句柄，初始0仍不是真正JS false。
    napi_value result = 0;
    // 创建API缺失或返回非0都走错误路径；||短路保证指针存在才调用，通过&result写句柄。
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        // 共享fail尝试设置JS异常并返回undefined句柄；本处不把失败包装成Promise。
        return fail(env, "Could not inspect modifier state");
    }
    // 正常路径返回API创建的布尔值句柄，不直接把C bool当napi_value。
    return result;
}

// 在N-API工作线程执行一次系统剪贴板操作，接收已准备的任务并写回data/length/format/error，返回void，不在此创建JS值或结算Promise。
// 流程按WRITE/TEXT/FILES/图片分支处理；例如文件路径转成各带NUL的UTF-8块，完成回调再建JS数组。
// 会实际读取或改变系统剪贴板；无本函数超时/取消器，@autoreleasepool不是异常捕获。写入先清空再写，不提供回滚或跨调用原子快照。
static void clipboard_execute(clipboard_job* job) {
    // 给后台线程这一段建立自动释放池，退出时释放池中临时对象；ARC管理对象引用，C malloc/calloc缓冲仍由共享桥接释放。
    @autoreleasepool {
        // Objective-C方括号向NSPasteboard类发generalPasteboard消息，取得系统通用剪贴板对象，不是复制一份独立剪贴板。
        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
        // 对象为nil时走打开失败分支，不继续向其写入。
        if (!pasteboard) {
            // 记录静态错误消息，后续共享完成回调尝试拒绝JS Promise。
            job->error = "Could not open clipboard";
        // 写请求才读取job.data里的输入副本；这些字节已在JS调用线程准备好。
        } else if (job->operation == CLIPBOARD_WRITE) {
            // 先alloc再以明确字节长度按UTF-8初始化NSString；不依赖输入的NUL终止，也不把length当UTF-16字符数。
            NSString* text = [[NSString alloc] initWithBytes:job->data length:job->length encoding:NSUTF8StringEncoding];
            // 初始化返回nil表示不能得到字符串；代码统一使用下一行错误文案。
            if (!text) {
                // 记录UTF-8输入无效文案，不在此重试其他编码。
                job->error = "Clipboard text is not valid UTF-8";
                // 在清空剪贴板前结束，输入缓冲仍归共享任务完成阶段释放。
                return;
            }
            // 清掉已有内容以准备写入，返回的changeCount未检查；之后写失败也不会恢复旧内容。
            [pasteboard clearContents];
            // 尝试以文本类型写NSString，BOOL为NO才记错误；成功不写回读结果，WRITE完成通常兑现undefined。
            if (![pasteboard setString:text forType:NSPasteboardTypeString]) job->error = "Could not set clipboard text";
        // 读取文本请求进入此分支，与写操作分开。
        } else if (job->operation == CLIPBOARD_TEXT) {
            // 向剪贴板请求文本类型的NSString，Cocoa负责提供对象；不是先把整个剪贴板存到本地文件。
            NSString* text = [pasteboard stringForType:NSPasteboardTypeString];
            // 没有取得字符串时记为空内容；这里不细分缺文本和底层返回nil的其他原因。
            if (!text) {
                // EMPTY使共享完成回调尝试返回JS null，区别于UNAVAILABLE的undefined。
                job->format = CLIPBOARD_EMPTY;
            // 点语法调用UTF8String getter，若拿不到C字节指针就记录编码错误。
            } else if (!text.UTF8String) {
                // 保留错误给完成阶段处理，不把编码失败当成功空字符串。
                job->error = "Could not encode clipboard text";
            // 有可用UTF-8表示才进入复制分支。
            } else {
                // 按UTF-8编码字节长度复制到任务独立缓冲，标UTF8；空NSString仍可形成长度0的有效字符串，不借用自动释放对象的内部指针。
                clipboard_copy(job, text.UTF8String, [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding], CLIPBOARD_UTF8);
            }
        // 文件路径请求进入单独分支，不把Finder图标当作要读取的图片。
        } else if (job->operation == CLIPBOARD_FILES) {
            // 向NSPasteboard读NSURL对象；@[[NSURL class]]是只含一个Class对象的NSArray字面量，方法参数继续到下一行。
            NSArray* urls = [pasteboard readObjectsForClasses:@[[NSURL class]]
                // @{...}是NSDictionary字面量，@YES把布尔值装成NSNumber；此选项仅允许file URL，不检查目标文件存在或可读。
                options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}];
            // 总大小从0字节起，下面先完整计算一次再统一分配。
            size_t total = 0;
            // Objective-C快速枚举按数组顺序走NSURL；urls为nil/空数组时不执行循环体。
            for (NSURL* url in urls) {
                // 取得规范UTF-8、NUL结尾的文件系统路径；SDK说明此内部表示不能越过其自动释放上下文借用。
                const char* path = url.fileSystemRepresentation;
                // 缺路径指针则跳过这一项，不造空路径替代。
                if (!path) continue;
                // strlen求NUL前字节数，不含终止符，不按用户可见字符数计。
                size_t length = strlen(path);
                // 先排除length为SIZE_MAX，再用减法验证total+length+1不溢出；||短路避免在首条件成立时继续无符号减法。
                if (length == SIZE_MAX || total > SIZE_MAX - length - 1) {
                    // 超出size_t可表示范围则写错误，不尝试部分返回。
                    job->error = "Clipboard file paths are too large";
                    // 此时尚未分配paths，直接结束当前平台工作。
                    return;
                }
                // 每条路径加正文长度和自己的1个NUL，确保拼接后仍能逐项拆分。
                total += length + 1;
            }
            // 没有可复制字节（例如无文件URL、nil结果或全被跳过）就按空内容处理；nil读取失败也未在这里另分错误。
            if (total == 0) {
                // 记EMPTY，完成时返回null，不返回一个空JS数组。
                job->format = CLIPBOARD_EMPTY;
                // 无需分配路径块，结束本次执行。
                return;
            }
            // 分配total字节的清零C内存，macOS共享分配器实际使用calloc；对象ARC不接管这块内存。
            char* paths = clipboard_alloc(total);
            // 分配返回空指针就不能继续写路径。
            if (!paths) {
                // 记录内存不足，不把分配失败当无文件。
                job->error = "Out of memory";
                // 结束，后面不会对空paths做memcpy。
                return;
            }
            // 可移动写指针先指向新块首字节，paths保留原始起点以便交付/释放。
            char* cursor = paths;
            // 第二遍枚举同一urls数组，逐条复制，不再向剪贴板请求新数组。
            for (NSURL* url in urls) {
                // 重新取这一项的路径表示，仍在同一个自动释放池范围内使用。
                const char* path = url.fileSystemRepresentation;
                // 同样忽略缺路径指针的项。
                if (!path) continue;
                // 再按字节求这一项的正文长度，复制顺序与首遍一致。
                size_t length = strlen(path);
                // 复制length+1字节，把这一项的NUL也写入；例如两项形成“路径A、NUL、路径B、NUL”的布局。
                memcpy(cursor, path, length + 1);
                // char*加length+1恰好前进这么多字节，下一项紧接当前终止符之后。
                cursor += length + 1;
            }
            // 把缓冲所有权交给任务；共享完成回调转换JS数组后释放原始paths地址，不释放已经前移的cursor。
            job->data = paths;
            // length记整块字节数，包含每项NUL，供共享路径解析器限制扫描范围。
            job->length = total;
            // 标PATHS格式，完成阶段按UTF-8逐段解码；这里只交付路径文字，不读取那些文件。
            job->format = CLIPBOARD_PATHS;
        // 已知调用入口剩下的是IMAGE；实现用最终else处理，未再对任意其他枚举值做运行时校验。
        } else {
            // @[]列PNG/TIFF类型，availableTypeFromArray查询可提供类型；都没有就走空图片，而非尝试任意其他格式。
            if (![pasteboard availableTypeFromArray:@[ NSPasteboardTypePNG, NSPasteboardTypeTIFF ]]) {
                // 明确没有可用PNG/TIFF类型时标EMPTY，完成返回null。
                job->format = CLIPBOARD_EMPTY;
                // 提前结束，不创建NSImage或编码图片。
                return;
            }
            // 优先取剪贴板提供的PNG NSData；拿到数据不在本函数再次检查PNG字节签名。
            NSData* png = [pasteboard dataForType:NSPasteboardTypePNG];
            // 只有PNG数据为nil才尝试图片对象/TIFF转码路径，零长度但非nil的NSData仍视为已取到。
            if (!png) {
                // 由剪贴板构造NSImage，可能返回nil；不是打开图片浏览器或从用户路径读文件。
                NSImage* image = [[NSImage alloc] initWithPasteboard:pasteboard];
                // 点语法取TIFF表示；给nil对象发消息得到nil，因此image失败也可继续下一行的空值分支。
                NSData* tiff = image.TIFFRepresentation;
                // 三元只在有TIFF数据时创建位图表示，否则nil；不保证创建一定成功。
                NSBitmapImageRep* bitmap = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
                // 有位图才编码成PNG，@{}为空属性字典；编码失败保留nil，不返回原始TIFF作为成功结果。
                png = bitmap ? [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
            }
            // PNG对象非nil就按bytes/length复制成任务独立缓冲，标BUFFER；完成阶段再复制成JS Buffer，不借用NSData内存。
            if (png) clipboard_copy(job, png.bytes, png.length, CLIPBOARD_BUFFER);
            // 类型提示存在但最终没取得PNG对象时记错误，而不是EMPTY/null。
            else job->error = "Clipboard does not contain an image";
        }
    }
}

// getFilePaths的JS原生回调，接宿主env/info，返回共享队列准备器的Promise句柄或同步失败返回值；不在当前调用线程遍历Finder内容。
// 例如平台工作把两条路径打包，完成回调再兑现string[]；队列/符号准备失败仍可能同步抛JS错误，入队后工作也可能在本回调返回前开始。
static napi_value PI_NAPI_CALL get_clipboard_file_paths(napi_env env, napi_callback_info info) {
    // 用FILES操作标签复用任务分配、异步入队、结果转换与释放流程，不给此回调额外参数解析逻辑。
    return queue_clipboard(env, info, CLIPBOARD_FILES);
}

// Node装载模块时按约定名字调用注册入口，输入env及exports对象，返回同一exports句柄；把五个C回调挂成JS方法，不立即调用这些方法。
// PI_NAPI_EXPORT给入口默认可见性，供宿主查找；set_function_export是尽力设置，缺符号/创建失败等没有逐项安装成功保证。
PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    // 注册同步isModifierPressed，只有JS后来调用才查询系统标志。
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    // 注册共享getText回调，后来调用时入队TEXT工作。
    set_function_export(env, exports, "getText", get_clipboard_text);
    // 注册由PI_CLIPBOARD_WRITE编入的setText回调，后来调用才准备并写入系统剪贴板。
    set_function_export(env, exports, "setText", set_clipboard_text);
    // 注册共享getImage回调，结果类型由平台格式和完成阶段决定。
    set_function_export(env, exports, "getImage", get_clipboard_image);
    // 注册本文件的getFilePaths入口，不把路径功能塞进getImage回调。
    set_function_export(env, exports, "getFilePaths", get_clipboard_file_paths);
    // 返回传入的exports对象，未创建第二份独立导出表。
    return exports;
}
