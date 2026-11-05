# 组 e04

状态：完成

说明：只改注释，未改代码、类型、默认值、字符串、模板字面量或原英文文档。统一验证结果：

- 11 个 TypeScript 文件全部通过仓库内 `esbuild` 的 transform 语法解析（输出到 `/tmp/e04-parse`，退出码 0）。这是语法转换检查，不是 `tsc` 类型检查。
- `bash -n packages/coding-agent/examples/extensions/doom-overlay/doom/build.sh` 通过。
- `git diff --check` 通过。
- 用 `git diff -U0` 检查新增/删除行：没有非注释的代码行进入 diff；删除侧均为被替换的旧中文注释。
- 未运行 `npm run check`、`npm run build`、全仓格式化、真实示例或网络/QEMU/emcc 测试（任务禁止，且相关示例需要外部条件）。

## 完成文件

- `packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts`：完整；核对 `ProviderConfigInput`/`ProviderConfig`、`OAuthLoginCallbacks`/`OAuthCredentials`、`SimpleStreamOptions`（`onPayload`/`onResponse` 为可选）、`AssistantMessageEventStream`、`collapseSystemMessages`、`getCurrentSystemPrompt`、`getCurrentTools`、`calculateCost`、`ToolCallArgumentsStream`、Anthropic SDK 0.52 的 `Anthropic` 与 `messages.stream`；补充文件导读、PKCE/OAuth、消息与工具转换、流事件、usage/错误路径。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts`：完整；核对 `anthropicMessagesApi().streamSimple`、`openAIResponsesApi().streamSimple`、`Model<Api>`、`SimpleStreamOptions`、`ThinkingLevelMap`、`OAuthCredentials`、direct access 响应；补充缓存单槽/固定 TTL、OAuth、后端分流、`forceAdaptiveThinking`、错误路径。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/test.ts`：完整；核对 `registerApiProvider`、`streamSimple`、`getAgentDir`、`Model`/`Context` 与 auth.json 的 OAuth 条目形状；补充 argv、凭证读取、退出码和旧路径风险。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/doom-overlay/doom-component.ts`：完整；核对 pi-tui `Component`/`TUI`/`isKeyRelease`、`DoomEngine` 的 tick/帧/按键接口；补充半块渲染、35 FPS 循环、Q 退出和清理逻辑。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/doom-overlay/doom-engine.ts`：完整；核对 `DoomModule` 的 C 导出、Emscripten `FS_createPath`/`FS_createDataFile`/`getValue`/`setValue`、WASM 内存 argv 构造；补充 init/preRun、帧转换与按键队列。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/doom-overlay/doom-keys.ts`：完整；核对 pi-tui `Key`/`matchesKey`/`parseKey`；补充 DoomKeys 编码、WASD/Shift、控制字符与数字字符串比较边界。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/doom-overlay/doom/build.sh`：完整；补充脚本用途、环境变量、clone/copy、emcc 参数、输出、幂等性与 CI 边界。`bash -n` 通过。
- `packages/coding-agent/examples/extensions/doom-overlay/doom/doomgeneric_pi.c`：完整；补充 C 平台适配层的构建关系、环形队列（实际最多 255 事件）、帧缓冲、按键、空钩子与 `DG_GetTicksMs` 的 uint32 回绕。未用 emcc 编译，原因见风险。
- `packages/coding-agent/examples/extensions/doom-overlay/index.ts`：完整；核对 `ExtensionAPI`、`ctx.ui.custom` 的 overlay 选项、`DoomEngine`/`DoomOverlayComponent` 调用；补充 WAD 选择、引擎缓存、覆盖层生命周期与错误清理。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/doom-overlay/wad-finder.ts`：完整；核对 `existsSync`、`fetch`、`gunzipSync`、`writeFileSync`；补充查找顺序、HOME 缺失时 `~/x` 变成 `/x`、下载无超时/哈希校验。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/dynamic-resources/index.ts`：完整；核对 `ExtensionAPI`、`resources_discover` 回调合同、`loadThemeFromPath`/`createTheme` 的读取关系；补充资源路径与主题字段含义。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/gondolin/index.ts`：完整；核对 `VM`/`RealFSProvider`、内置 `ReadOperations`/`WriteOperations`/`EditOperations`/`LsOperations`/`FindOperations`/`BashOperations`、`GrepToolInput`、`truncateHead`/`truncateLine`；补充路径映射、find/grep 实现、VM 生命周期、七个工具与 `user_bash`/`before_agent_start`。esbuild 解析通过。
- `packages/coding-agent/examples/extensions/with-deps/index.ts`：完整；核对 `ExtensionAPI`、TypeBox `Type`、`ms` 2.1.3 与 `@types/ms`；补充清单/依赖解析、工具 schema、`ms("")` 抛错与非空非法字符串返回 undefined 的差异。esbuild 解析通过。

## 未修改的数据/配置文件

- `packages/coding-agent/examples/extensions/custom-provider-anthropic/.gitignore`：忽略本地 `node_modules/`，由 git 读取。
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/package.json`：私有扩展清单，`pi.extensions` 指向 `./index.ts`，固定 `@anthropic-ai/sdk` 0.52.0；由扩展加载器和 npm 读取。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/.gitignore`：忽略 `node_modules/`，由 git 读取。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/package.json`：私有扩展清单，声明入口，无运行时依赖；由加载器和 npm 读取。
- `packages/coding-agent/examples/extensions/doom-overlay/.gitignore`：忽略首次运行自动下载的 `doom1.wad`，由 git 读取。
- `packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js`：Emscripten 生成物，由 `build.sh` 从 doomgeneric C 源码和 `doomgeneric_pi.c` 生成，由 `doom-engine.ts` 通过 `new Function` 加载；禁止手改，故未编辑。
- `packages/coding-agent/examples/extensions/dynamic-resources/dynamic.json`：主题数据，由资源加载器/`loadThemeFromPath` 读取；JSON 不能写注释，字段语义已写入同目录 `index.ts` 文件头和 `LEARNING.md`。
- `packages/coding-agent/examples/extensions/gondolin/.gitignore`：忽略 `node_modules/`，由 git 读取。
- `packages/coding-agent/examples/extensions/gondolin/package.json`：私有扩展清单，固定 `@earendil-works/gondolin` 0.14.0；由加载器和 npm 读取。
- `packages/coding-agent/examples/extensions/with-deps/.gitignore`：忽略本地 `node_modules/`，由 git 读取；保留原有说明性注释，未改写。
- `packages/coding-agent/examples/extensions/with-deps/package.json`：私有扩展清单，固定 `ms` 2.1.3 与 `@types/ms` 2.1.0；由加载器和 npm 读取。

## 未完成或风险

- 所有真实运行验证未执行：示例需要 pi 交互宿主、GitLab/Anthropic 网络与凭证、QEMU、Node >= 23.6、WASM 构建产物或 emcc；任务也禁止运行 `npm run check`、`npm run build`、仓库级格式化和安装。因此只能确认注释语法与 diff 不含代码变更，不能声称端到端成功。
- `packages/coding-agent/examples/extensions/custom-provider-anthropic/index.ts`：已记录的真实风险包括 `sanitizeSurrogates` 会把合法代理对（emoji）也替换成 U+FFFD；`message_delta` 的 usage 覆盖可能把 input/cache 字段清零；自定义流未实现 `onPayload`/`onResponse`、`toolChoice`、自定义 `fetch`/`env`；空 `apiKey` 在 SDK 构造时不会报错，请求通常以 401 失败；OAuth `state` 生成后未在回调中校验；`convertTools` 只保留 `properties`/`required`，运行时不校验 JSON Schema。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/index.ts`：direct access 缓存是模块级单槽，未按 GitLab token 区分，固定 25 分钟 TTL 不使用服务端实际过期时间；缓存未命中并发时可能重复请求；OAuth `state` 未校验；403 提示只是启发式排查方向。`/login` 和测试需要真实 GitLab 凭证，未运行。
- `packages/coding-agent/examples/extensions/custom-provider-gitlab-duo/test.ts`：读取 `join(getAgentDir(), "extensions", "auth.json")`，当前宿主实际路径是 `join(getAgentDir(), "auth.json")`；按当前版本通常 ENOENT。文件读取/JSON 解析异常经 `main().catch(console.error)` 只打印，退出码通常仍为 0；流内 error 事件也不改退出码。未运行。
- `packages/coding-agent/examples/extensions/doom-overlay/wad-finder.ts`：下载无超时、大小限制、哈希或重试，只校验 `IWAD` 魔数；并发调用可能同时下载并覆盖同一文件；HOME 未设置时 `~/x` 会解析成根路径 `/x`。未联网运行。
- `packages/coding-agent/examples/extensions/doom-overlay/doom-component.ts` / `doom-engine.ts`：C 按键队列保留一个空槽，实际最多 255 个事件，满时静默丢弃；`DG_GetTicksMs` 的 double 转 uint32 约 49.7 天回绕；`DoomEngine.init` 没有重复初始化门禁，重复调用会覆盖模块；类没有清理方法。覆盖层 `render` 只按宽度计算高度，终端实际高度由 TUI 裁剪。均未启动 QEMU/WASM 游戏验证。
- `packages/coding-agent/examples/extensions/gondolin/index.ts`：路径映射是纯词法判断，`isInsideHostPath` 会把 cwd 内名为 `..foo` 的条目误判为外部；symlink 的 realpath 限制来自 `RealFSProvider`，不是这些路径函数；`find` 忽略 `options.ignore`，只跳过 `.git`/`node_modules`；`grep` 整文件读入内存，行数上限为 `Number.MAX_SAFE_INTEGER`，实际只靠字节预算截断；`session_shutdown` 未等待在途的 `startVm`，启动完成后可能重新赋值 `vm`；`startVm` 在探测失败时不会关闭已创建的 VM。未运行 QEMU/Node 23.6 环境。
- `packages/coding-agent/examples/extensions/with-deps/index.ts`：`ms("")` 在已安装的 ms 2.1.3 中抛错，而 `ms("not-a-duration")` 返回 undefined，工具对两者都报告为执行失败；依赖需在示例目录单独安装，未运行真实工具调用。
- `packages/coding-agent/examples/extensions/dynamic-resources/index.ts`：只返回路径，不检查文件存在或格式；资源缺失/主题 JSON 非法会在后续加载器暴露，未在 pi 宿主中验证。
- 未改写 `docs/learning/pi/study-coverage.json`、`STUDY_PROGRESS.md`、`STUDY_LOG.md`、`SESSION_PLAN.md` 或其他代理报告。
