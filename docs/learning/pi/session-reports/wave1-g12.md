# 组 g12

状态：完成

## 完成文件

- packages/chord/src/node/http/admission.ts：完整；核对 `admit` 对 `Incoming.header/forwarded/request` 的调用、`relay.verify` 返回值与 `isOrigin` 校验、`Admitted`/`Refused`/`Provenance`/`Connection`/`HttpRelay` 类型，以及 `refused`/`isForeign`/`isNavigation`/`originAccepted` 的判定顺序；由 test/node/http/admission.test.ts 覆盖并通过。
- packages/chord/src/node/http/authenticate.ts：完整；核对 `defineRegistry` 生成的 `Authenticators`、`RegistryTable` 的贡献顺序、`Authenticator` 返回 `undefined` 表示让位、`context.abortSignal` 与 `failed` 回调；由 authenticate.test.ts 覆盖并通过。
- packages/chord/src/node/http/cookies.ts：完整；核对 `cookie`/`readCookie`/`readSignedCookie` 的 HMAC-SHA256 载荷（名字、编码值、到期秒）、`timingSafeEqual` 恒定时间比较、`Set-Cookie` 属性与 `Secure` 条件；由 cookies.test.ts 覆盖并通过。
- packages/chord/src/node/http/file.ts：完整；核对 `fileResponse` 对 `realpath`/`stat`/`open`/`FileHandle.read` 的调用、`root` 真实路径包含判断、`ctx.abortSignal` 关闭句柄与短读处理；由 file.test.ts 覆盖并通过。
- packages/chord/src/node/http/headers.ts：完整；核对 `AnswerHeaders` 的 TOKEN/FIELD_VALUE 校验、`Nonces` 的 4 KiB 池与 16 字节游标、`DefaultHeaders.of` 的固定安全头、`Router.framers/csp/scripts` 合并及 `WeakMap<Router, ...>` 缓存；由 headers.test.ts 覆盖并通过。
- packages/chord/src/node/http/http.ts：完整；核对 `createHttp` 的 `defineFacet`、`Http`/`Authenticators`/`HttpListener` 注册表、`#serve` 的准入/认证/路由/`answerOf` 流程、`#resolve`/`#follow` 重试、`Upgrades` 与 `close` 排空；由 http.test.ts 覆盖并通过。
- packages/chord/src/node/http/incoming.ts：完整；核对 `Incoming` 契约、`webIncoming` 对 `Request` 的惰性委托、`isForwarding` 的头名集合；无同名测试文件，由 admission.test.ts 直接导入覆盖并通过。
- packages/chord/src/node/http/index.ts：完整；核对全部再导出符号与源模块导出一致；纯 barrel，无独立测试，由包级导入间接覆盖。
- packages/chord/src/node/http/node.ts：完整；核对 `NodeListener`、`NodeIncoming`、`nodeRequest`、`connectionOf` 的 origin-form/Host/WireRefusal 处理、`pump`/`bodyOf` 背压与 `ByteLengthQueuingStrategy`；由 node.test.ts 覆盖并通过。
- packages/chord/src/node/http/request.ts：完整；核对 `WebRequest` 对 `Incoming.request()` 的惰性构造、`splitUrl` 切分、`body` 的 `#taken` 单次读取/`releaseLock`/413/400 路径与 `json` 解析；由 request.test.ts 覆盖并通过。
- packages/chord/src/node/http/response.ts：完整；核对 `answerOf` 的默认头与路由头合并、`whole` 的 204/205/304、Range 206/416、Content-Disposition、CSP sandbox 与 pulled stream 读取；由 response.test.ts 覆盖并通过。
- packages/chord/src/node/http/router.ts：完整；核对 `composeRouter` 的冲突先报、`METHOD /pattern` 精确/参数/尾部 `*` 优先级、HEAD 回退 GET、`UNCARRIED` 与 `Http`/`Router`/`RouteMatch` 类型；由 router.test.ts 覆盖并通过。
- packages/chord/src/node/http/upgrades.ts：完整；核对 `Upgrades.link/socket`、`limitedSocket` 的 4 MiB 未发送上限、15 秒心跳/终止、`revoke` 按 allowed/relay/handler 撤销与 `upgrade` 的 `maxPayload`；由 upgrades.test.ts 覆盖，20 项中 19 项通过，1 项为 HEAD 既有失败（见风险）。

运行命令（在 /Users/baiml/PycharmProjects/pi/packages/chord 下）：
`node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/node/http`
结果：Test Files 10 passed | 1 failed (11)；Tests 110 passed | 1 failed | 1 skipped (112)。

## 未完成或风险

- 13 个文件均已完成，无剩余注释缺口。`git diff --numstat` 显示全部文件删除行为 0；逐行检查新增行均为可带缩进的 `//` 注释，未改动代码、字符串、模板内容或导出。另用词法扫描确认所有新增行都位于代码上下文（不在模板字符串、普通字符串或块注释内）。
- upgrades.test.ts 的 “takes frames of at most 1 MiB unless links.options says otherwise (Opus's audit H2)” 失败：发送 1 MiB+1 帧后客户端收到关闭码 1006，而测试期望 1009。在 HEAD 0663b2360 的独立临时 worktree 中运行同一测试复现相同失败（20 项中 19 通过），确认与本组注释改动无关；临时 worktree 已删除。
- index.ts 为再导出入口，本目录没有独立测试；incoming.ts 由 admission.test.ts 间接覆盖。其余 11 个模块均有同名测试。
- 按任务约束未运行 `npm run check`、`npm run build`、全仓格式化或任何 git 写操作；类型检查与构建未在本组验证，语法可解析性由 vitest 转译和测试执行间接确认。
