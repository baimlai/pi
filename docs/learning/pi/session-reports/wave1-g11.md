# 组 g11

状态：完成

## 完成文件

- packages/chord/src/node/app/app.ts：完整；核对 `startServer`/`RunningApp` 对 `createServerHost`、`Http`/`HttpFacet`、`Sessions`、`createWorkers`/`createPlugins`、`openStore`、`files`/`layout`/`secrets`/`info`/`invite`/`pairing`/`archive` 的调用与 `AppOptions` 约束；运行 app.test.ts：15 项中 13 通过，2 项失败为 macOS realpath 差异（见风险）。
- packages/chord/src/node/app/archive.ts：完整；核对 `openStore`/`importStore`、`encodeJsonl`、`writeTar`/`readTar`、`Files` 的导出与导入顺序；archive.test.ts 通过。
- packages/chord/src/node/app/data.ts：完整；核对 store 地址到文件路径的映射、`randomBytes` 与 `ChordError` 用法；无独立测试，由 app.test.ts/worker.test.ts 间接覆盖。
- packages/chord/src/node/app/ephemeral-sessions.ts：完整；核对 `Sessions` 契约、`principal`/`AppUser`、60 秒宽限与上限淘汰逻辑；ephemeral-sessions.test.ts 通过。
- packages/chord/src/node/app/ephemeral.ts：完整；核对 `Sessions` facet、`Http` 路由、`OWNER` 与 ephemeral 用户 principal；ephemeral.test.ts 通过。
- packages/chord/src/node/app/files.ts：完整；核对 `Uploads`、`Assets`、容量检查与 `realpath`/`stat` 边界；files.test.ts 7 项中 6 通过，1 项因 macOS 无 `/proc/self/fd` 失败（见风险）。
- packages/chord/src/node/app/index.ts：完整；核对全部再导出的源文件与公开符号；由包级导入和 app 测试间接覆盖。
- packages/chord/src/node/app/info.ts：完整；核对 `defineState`/`change` 文档、`Http` 路由与 `AppInfo` 字段；info.test.ts 部分失败为 macOS realpath 差异（见风险）。
- packages/chord/src/node/app/invite.ts：完整；核对 `Sessions.issue`、一次性 token 的 URL fragment 交付与 `Http` 公开路由；invite.test.ts 通过。
- packages/chord/src/node/app/layout.ts：完整；核对 `dataDir` 下 `store`/`files`/`run`/`owner`/`lock` 路径布局与权限创建；layout.test.ts 通过。
- packages/chord/src/node/app/owner.ts：完整；核对 owner token 文件读写、`OWNER` principal 与 `timingSafeEqual`/哈希比较；owner.test.ts 通过。
- packages/chord/src/node/app/pairing.ts：完整；核对 `Pairings` 限额/过期/单向 token 交付、`Sessions.issue` 与 `PAIR_PATH` 四条路由；pairing.test.ts 通过。
- packages/chord/src/node/app/secrets.ts：完整；核对 `newToken`/`hashToken`/`writeSecret` 的 `randomBytes`、SHA-256 与 0600 文件语义；secrets.test.ts 通过。
- packages/chord/src/node/app/sessions.ts：完整；核对 `Sessions` 契约、token 摘要存储、滑过期与撤销、cookie 读取；sessions.test.ts 通过。
- packages/chord/src/node/app/tar.ts：完整；核对 `writeTar`/`readTar` 的 ustar 字段、校验和、路径信任边界与 `ByteReader`；tar.test.ts 通过。
- packages/chord/src/node/app/uploads.ts：完整；核对 `Uploads` 的 offset 接受、并发写集合、`finish` rename 与过期/关闭清理；uploads.test.ts 通过。
- packages/chord/src/node/app/users.ts：完整；核对 `AppUser`/`Users` 类型与 `defineState` 的用户列表文档；users.test.ts 通过。
- packages/chord/src/node/app/worker.ts：完整；核对 `startWorker` 对 `createWorkerHost`、worker 契约与 `workerMain` 的调用；worker.test.ts 通过。

## 未完成或风险

- 全部 18 个文件均已完成，diff 为纯新增注释行（18 个文件删除行均为 0，新增行全部匹配 `^[[:space:]]*//`），未改动代码、缩进、字符串或生成文件。
- 运行命令（在 /Users/baiml/PycharmProjects/pi/packages/chord 下）：
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/node/app/archive.test.ts test/node/app/ephemeral-sessions.test.ts test/node/app/ephemeral.test.ts test/node/app/files.test.ts test/node/app/info.test.ts test/node/app/invite.test.ts test/node/app/layout.test.ts test/node/app/owner.test.ts test/node/app/pairing.test.ts test/node/app/secrets.test.ts test/node/app/sessions.test.ts test/node/app/tar.test.ts test/node/app/uploads.test.ts test/node/app/users.test.ts`
  结果：Test Files 2 failed | 12 passed (14)；Tests 2 failed | 57 passed (59)。
  失败项：files.test.ts 的上传上限用例在 macOS 上读取 `/proc/self/fd` 得到 ENOENT；info.test.ts 的 AppInfo 用例期望 `/var/...`，实际 realpath 为 `/private/var/...`。
- 运行命令：
  `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/node/app/app.test.ts test/node/app/worker.test.ts`
  结果：Test Files 1 failed | 1 passed (2)；Tests 2 failed | 14 passed (16)。worker.test.ts 全通过；app.test.ts 的两处失败同样是 `/var` 与 `/private/var` 的 macOS realpath 差异（AppInfo dataDir 与第二个服务器锁消息），与注释改动无关。
- 按任务约束未运行 `npm run check`、`npm run build`、全仓格式化或任何 git 写操作；因此类型检查和构建未在本组验证。
