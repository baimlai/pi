# pi 源码精读：从一次 query 到每个模块

这套材料是一套可自学的课程，不只是路由表。它按三个层次组织：

1. **上帝视角**：先用一条真实 query 走完整条链路，再用四条贯穿式追踪看清“消息、工具调用、上下文、事件”各自的一生。
2. **模块深潜**：进入入口、Agent 循环、会话、模型访问、模式五个模块，拆到函数内部、子函数、数据变化和设计原因。
3. **速查与排障**：术语表统一叫法，排障地图按“现象 -> 层 -> 数据 -> 函数”定位问题。

源码里的中文注释解释“这一行在做什么”；这套材料解释“它在整条链路的哪一段、为什么需要、下一步去哪”。

## 先读哪一篇

1. **第一次读**：先看 [COURSE.md](COURSE.md) 的课程地图，选一条学习路径；然后读 [00-full-chain](00-full-chain/README.md)，跟着一条 `pi -p "读取 README.md 前 20 行并总结"` 从命令行走到最终回答。
2. **建立串联**：读 [traces](traces/README.md) 的四条追踪。它们不按文件组织，而按“一个东西从生到死”组织，适合把各模块接起来。
3. **补齐细节**：按兴趣进入下面五个模块。每篇都有“学完能回答”“大白话总览”“运行示例”“函数拆解”“自测/练习”，读完能回到全链路。
4. **查词与排障**：卡住时查 [GLOSSARY.md](GLOSSARY.md) 和 [DEBUG_MAP.md](DEBUG_MAP.md)，不要从头翻代码。
5. **跳代码**：模块里的路由表直接链到 `path#L行号`。在 IDE 的 Markdown 预览里点击会打开对应源码文件。网页版通过本地打开服务把点击转给当前 IDE，点击即在编辑器中打开文件并定位到行（启动方式见下文“为什么需要本地打开服务”）。

## 材料地图

| 层 | 文档 | 回答的问题 | 关键文件 |
| --- | --- | --- | --- |
| 课程 | [COURSE.md](COURSE.md) | 先学什么、每讲花多久、怎么自测、做什么练习 | 跨模块 |
| 主线 | [00 全链路](00-full-chain/README.md) | 一条 query 如何从参数变成回答，多轮又如何复用历史 | 跨模块 |
| 贯穿 | [traces](traces/README.md) | 一条消息/一次工具调用/一份上下文/一个事件，分别怎样穿过所有层 | 跨模块 |
| 模块 01 | [入口与装配](01-entry-and-config/README.md) | 进程启动后谁解析参数、选模型、装工具、建会话 | `cli.ts`、`main.ts`、`sdk.ts` |
| 模块 02 | [Agent 循环](02-agent-loop/README.md) | 模型请求、流式事件、工具执行、下一轮请求如何衔接 | `agent.ts`、`agent-loop.ts` |
| 模块 03 | [会话与上下文](03-session-and-context/README.md) | 消息怎样落盘、上下文从哪来、压缩何时发生 | `agent-session.ts`、`session-manager.ts` |
| 模块 04 | [模型访问](04-model-access/README.md) | 模型 ID 如何变成一次供应商 HTTP 请求，事件如何回来 | `model-runtime.ts`、`packages/ai` |
| 模块 05 | [模式与 TUI](05-modes-and-tui/README.md) | 打印、交互、RPC 三种模式各自怎样驱动同一个会话 | `print-mode.ts`、`interactive-mode.ts` |
| 速查 | [术语表](GLOSSARY.md) / [排障地图](DEBUG_MAP.md) | 这个词到底指什么；出现这个现象先去哪一层看 | 跨模块 |
| 维护 | [GUIDE.md](GUIDE.md)（仓库内 Skill：`.pi/skills/learning-courseware.md`） | 以后怎么新增、加厚、校验和同步这套材料 | 本文档体系 |

## 每篇模块文档的骨架

每篇模块文档按教学顺序组织，而不是按源码文件顺序：

1. **学完能回答**：先给可验证的问题，带着问题读。
2. **一句话职责 + 大白话总览**：这个模块只负责什么，用类比和反例建立直觉。
3. **关键概念**：先区分容易混的词，再进入代码。
4. **运行示例**：一条具体输入，以及它在模块内部产生的对象、字段和事件。
5. **在链路中的位置**：上游是谁、下游是谁、对应全链路哪一步。
6. **文件路由 / 函数路由**：稳定 ID、符号、行号；链接可直接跳源码。
7. **关键函数拆解**：职责、输入、输出、内部步骤、子函数、数据变化、失败分支、设计原因。
8. **数据变化 / 事件序列**：同一份数据在各阶段长什么样。
9. **设计取舍**：为什么这样分层，换一种写法会坏在哪。
10. **自测 / 动手练习**：能否用自己的话复述，能否在源码里找到证据。
11. **常见误解**：读代码时最容易反过来的点。
12. **继续阅读**：前后模块和贯穿追踪。

路由 ID 形如 `M02.loop.run`：`M02` 是模块，`loop` 是机制或文件，`run` 是函数。ID 不随行号变化；行号漂移时只更新链接。

## 学习闭环

每讲不要从第一行读到最后一行，按这个循环走：

1. **预测**：看函数名和调用点，先猜它会做什么、返回什么。
2. **读源码**：读整个函数和它调用的关键子函数，不靠搜索片段。
3. **跑或观察**：用 JSON 事件模式（`pi --mode json -p "..."`）、会话 JSONL、测试或网页路由观察真实行为。
4. **复述**：不看文档，用自己的话讲出“输入 -> 步骤 -> 输出 -> 失败分支”。
5. **做练习**：改一个参数、加一条日志、画一张数据流图，验证理解。
6. **记录问题**：把没懂的点写成问题，回到对应模块或排障地图。

## 两个版本

- **Markdown**：本目录。适合在 IDE 里读，路由会打开源码文件，也可以提交到 GitHub。
- **网页**：`index.html` 单文件，CSS、JS、页面内容全部内联，不依赖网络。适合连续阅读、搜索和直接跳回 IDE。

网页由 Markdown 生成，不单独维护：

```bash
# 校验所有链接的文件、行号和文档锚点
node docs/learning/pi/modules-chain/build.mjs --check

# 校验并按链接标题里的符号修正行号漂移
node docs/learning/pi/modules-chain/build.mjs --fix

# 重新生成 index.html；默认面向 WebStorm
node docs/learning/pi/modules-chain/build.mjs

# 生成并启动本地打开服务（在 IDE 内置 Preview 里点击跳转需要它）
node docs/learning/pi/modules-chain/build.mjs --serve

# 换 IDE 时重新生成（vscode / pycharm / webstorm）
node docs/learning/pi/modules-chain/build.mjs --serve --ide=pycharm
```

### 为什么需要本地打开服务

WebStorm 的内置 Preview 使用 JCEF（内嵌 Chromium）。页面里跳到 `webstorm://...` 这类自定义协议时，JCEF 不会交给操作系统，而是显示 `ERR_UNKNOWN_URL_SCHEME` 并把当前预览页替换成错误页。这是内嵌浏览器的限制，不是链接写错了；同一个 URL 从终端用 `open` 打开是正常的。

所以网页不再让预览页直接跳协议。点击路由芯片时，页面请求 `http://127.0.0.1:4917/open`，由本地服务执行 `open "webstorm://..."`，IDE 打开源码并定位到行，文档页保持在原处。启动方式：

```bash
node docs/learning/pi/modules-chain/build.mjs --serve
```

然后任选一种方式打开页面：

- 在 WebStorm 里继续用 Preview 打开 `index.html`（`file://` 页面也能访问本地服务）。
- 或直接访问 `http://127.0.0.1:4917/`，用内置预览或 Chrome 都可以。

服务只监听 `127.0.0.1`，只接受仓库内的文件路径。端口冲突时加 `--port=4918`，页面里的服务地址会随生成结果更新。不启动服务时，点击芯片会复制 `path:line` 并提示，不会把预览页跳坏。

目标 IDE 默认是 WebStorm，`--ide=vscode` / `--ide=pycharm` 可切换；服务打开源码和链接里的协议使用同一个目标。按住 Alt 点击芯片复制 `path:line`，按住 Shift 点击复制 `path`。

打开网页：

```bash
open docs/learning/pi/modules-chain/index.html
```

## 与源码注释的关系

- 源码注释回答“这一行/这个函数的意图”。
- 本文档回答“这个函数在整条链路的哪一段，为什么需要它”。
- 路由表里的行号是快照。代码变动后先跑 `--check`，再跑 `--fix`；符号找不到时脚本会报错，不会静默改错位置。

维护规则见 [GUIDE.md](GUIDE.md)。
