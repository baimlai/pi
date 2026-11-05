# Chord 示例目录导读

本目录是 Chord v2 的可运行示例集合。每个编号对应 `packages/chord/docs/slices.md` 里的一个主题切片，既是维护者手动运行的验证脚本，也是用户学习 API 的参考。示例不是单元测试：它们直接打印过程与结果，失败时以未捕获异常或断言退出。

## 两种布局

- **单文件示例**（`01-objects.ts` 到 `34-versions.ts`）：一个文件就是完整程序，从 `../../src/index.ts` 等源码入口导入 API，顺序执行并打印结果。
- **目录示例**（`35-plugins/` 到 `60-session-sync/`）：`main.ts` 是入口，`plugins/`、`app/`、`web/`、`tui/` 等子目录是它加载的插件或应用文件。部分目录里还有数据夹具（例如 `rates.json`）和独立的 `package.json`。

单文件示例的编号并不连续：`26`、`27` 等编号属于其他系列，缺失编号不代表文件损坏。

## 运行方式

从 `packages/chord` 目录运行，使用 Node 的源码条件导出和 TypeScript 类型剥离：

```bash
node --conditions=source --experimental-strip-types test/examples/01-objects.ts
node --conditions=source --experimental-strip-types test/examples/37-plugin-imports/main.ts
```

每个 `main.ts` 或单文件示例的文件头都写了该示例自己的准确命令、前置条件（临时目录、假 npm、浏览器构建等）和预期输出。以文件头为准；上面的命令只是通用形式。

示例可能创建临时目录、启动本地服务器或 worker、写文件；多数在结束时清理。运行前读文件头的副作用说明。

## 插件目录与 `package.json`

带 `package.json` 的目录是被 Chord 插件加载器发现的插件包。清单字段：

- `name`：插件身份，决定日志、依赖引用和 `plugins.build([...])` 里使用的名字。示例使用 `@example/clock`、`@acme/hello` 这类私有作用域名。
- `private`：防止误发布到 npm；示例全部为 `true`。
- `type: "module"`：插件源码按 ES 模块解析。
- `main`：仅出现在被当作依赖包的 `deps/` 示例里，指向包入口文件。
- `dependencies`：插件构建时需要内联的 npm 依赖。`file:` 依赖指向示例目录内的本地包，避免访问网络。
- `chord.external`：构建时保持外部引用的包名。它在脚本运行时由宿主提供，不被打进插件产物。
- `exports`：依赖包可被子路径导入时使用。

JSON 不能写注释，因此清单含义集中写在这里。构建边界如下：插件自己的文件、同根其他插件的相对路径文件、以及 `dependencies` 会被内联；宿主包（应用传入的模块）、`chord.external` 和 Node 内置模块保持外部；`__dirname`、`__filename` 在构建产物中不可用。`37-plugin-imports` 和 `50-plugin-imports` 专门演示这些规则。

## 建议阅读顺序

1. 先读 `01-objects.ts` 到 `12-routes.ts`，建立对象、文档、派生、监视、调用、路由的基本模型。
2. 再读 `13-relay.ts` 到 `25-export-import.ts`，理解跨主机、流控、任务、表、迁移和导入导出。
3. 然后从 `35-plugins/main.ts` 开始读目录示例，按编号跟进插件失败、导入、监视、HTTP、worker、应用、Web/TUI 和会话同步。
4. 需要某层实现细节时，回到 `packages/chord/src` 对应模块和 `design.md` 的章节。
