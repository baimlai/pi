/**
 * pi-doom platform implementation for doomgeneric
 *
 * Minimal implementation - no sound, just framebuffer and input.
 */

/*
 * 文件导读（doom-overlay 的 C 平台适配层）
 *
 * 所属与构建：本文件位于 `doom-overlay/doom/`，由 `build.sh` 复制进上游 doomgeneric 源码树，
 * 再与 DOOM 的 C 源文件一起用 Emscripten 编译成 `build/doom.js` + `build/doom.wasm`。
 * 它不是独立的可执行程序，也不直接与 JavaScript 共享对象；跨语言边界只有数字指针和函数调用。
 *
 * 上游如何进入：doomgeneric 引擎在初始化、每帧、取键、计时时调用这里实现的 `DG_*` 回调；
 * `doom-engine.ts` 通过 Emscripten 导出调用 `_DG_GetFrameBuffer`、`_DG_GetScreenWidth/Height`、
 * `_DG_PushKeyEvent`，并直接调用上游的 `_doomgeneric_Create`/`_doomgeneric_Tick`。
 *
 * 能力清单：
 * - `DG_GetFrameBuffer`：返回引擎像素缓冲地址（32 位像素，格式为 0x00RRGGBB）。
 * - `DG_GetScreenWidth/Height`：返回编译宏确定的尺寸。
 * - `DG_PushKeyEvent`：JS 向固定容量环形队列写入按键。
 * - `DG_GetKey`：doomgeneric 从队列取按键。
 * - `DG_Init`/`DG_DrawFrame`/`DG_SleepMs`/`DG_SetWindowTitle`：平台钩子的空实现或无操作。
 * - `DG_GetTicksMs`：用 Emscripten 的 `emscripten_get_now()` 提供毫秒计时。
 *
 * 典型调用顺序：WASM 加载 -> C 的 `doomgeneric_Create` 调用 `DG_Init` -> JS 每帧调用
 * `_doomgeneric_Tick`，引擎内部调用 `DG_DrawFrame`/`DG_GetTicksMs`/`DG_GetKey` ->
 * JS 通过 `_DG_GetFrameBuffer` 读取同一块像素内存。
 *
 * 示例（C 侧，不是可运行命令）：JS 调用 `_DG_PushKeyEvent(1, 0xad)` 后，下一次
 * `DG_GetKey(&pressed, &key)` 读到 `pressed=1, key=0xad`，并返回 1；队列为空时返回 0。
 *
 * 建议阅读顺序：先看按键环形队列的状态，再看推送/取出函数，最后看空实现与计时。
 *
 * 边界：没有音频、没有线程/锁；Node 单线程调用使队列操作天然串行。队列满时新按键被丢弃，
 * 不通知调用方。`DG_GetTicksMs` 把 double 截断为 uint32，约 49.7 天后回绕。
 */

#include "doomgeneric.h"
#include "doomkeys.h"
#include <emscripten.h>
#include <stdint.h>

// Key event queue
// 固定大小 256 的环形缓冲区。读写索引相等表示空；写入前先算 next_write，
// 若 next_write 等于 read 说明队列已满，直接丢弃本次事件。
#define KEY_QUEUE_SIZE 256
static struct {
  /* 1 = 按下，0 = 松开；由 JS 传入 */
  int pressed;
  /* DOOM 键码，单字节（见 doomkeys.h） */
  unsigned char key;
} key_queue[KEY_QUEUE_SIZE];
/* DG_GetKey 从这里取 */
static int key_queue_read = 0;
/* DG_PushKeyEvent 写到这里 */
static int key_queue_write = 0;

// Get the framebuffer pointer for JS to read
// EMSCRIPTEN_KEEPALIVE 防止链接器删除该函数，并使其可由 JS 调用；
// 返回值是 WASM 线性内存中的地址，不是可解引用的宿主指针。DG_ScreenBuffer 由 doomgeneric 持有。
EMSCRIPTEN_KEEPALIVE
uint32_t *DG_GetFrameBuffer(void) { return DG_ScreenBuffer; }

// Get framebuffer dimensions
// 尺寸来自编译宏 DOOMGENERIC_RESX/RESY，与 build.sh 的 -D 参数对应。
EMSCRIPTEN_KEEPALIVE
int DG_GetScreenWidth(void) { return DOOMGENERIC_RESX; }

EMSCRIPTEN_KEEPALIVE
int DG_GetScreenHeight(void) { return DOOMGENERIC_RESY; }

// Push a key event from JavaScript
// 输入 pressed 非 0 表示按下，key 会被截断为 unsigned char；
// 队列满时静默丢弃，无返回值表示成功与否。
EMSCRIPTEN_KEEPALIVE
void DG_PushKeyEvent(int pressed, unsigned char key) {
  // 环形队列保留一个空槽来区分满/空，因此最多容纳 255 个事件。
  int next_write = (key_queue_write + 1) % KEY_QUEUE_SIZE;
  if (next_write != key_queue_read) {
    key_queue[key_queue_write].pressed = pressed;
    key_queue[key_queue_write].key = key;
    key_queue_write = next_write;
  }
}

// doomgeneric 平台钩子：本实现不需要额外初始化。
void DG_Init(void) {
  // Nothing to initialize
}

// 引擎调用本函数表示“一帧已画好”；像素已在 DG_ScreenBuffer，JS 会主动读取，
// 因此这里没有复制或提交操作。
void DG_DrawFrame(void) {
  // Frame is in DG_ScreenBuffer, JS reads via DG_GetFrameBuffer
}

// doomgeneric 可能请求平台睡眠；计时完全由 JS 的定时器驱动，所以这里不阻塞。
void DG_SleepMs(uint32_t ms) {
  // No-op - JS handles timing
  // 强转 void 明确表示“有意不使用参数”，避免编译器未使用参数警告。
  (void)ms;
}

// 返回自 Emscripten 运行时初始化以来的毫秒数；double 转 uint32 会截断，
// 运行约 49.7 天后回绕，对游戏计时通常可接受。
uint32_t DG_GetTicksMs(void) {
  return (uint32_t)emscripten_get_now();
}

// 从环形队列取出一个事件：成功时写入 *pressed/*key 并返回 1，空队列返回 0。
// 指针参数由 doomgeneric 提供，调用方保证非空。
int DG_GetKey(int *pressed, unsigned char *key) {
  if (key_queue_read != key_queue_write) {
    *pressed = key_queue[key_queue_read].pressed;
    *key = key_queue[key_queue_read].key;
    // 取走后推进读索引并回绕。
    key_queue_read = (key_queue_read + 1) % KEY_QUEUE_SIZE;
    return 1;
  }
  return 0;
}

// 无窗口系统，标题设置是空操作；同样用 (void) 消除未使用参数警告。
void DG_SetWindowTitle(const char *title) {
  (void)title;
}
