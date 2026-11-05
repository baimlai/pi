# pi-schema 的包配置

本页配套解释不适合直接加入注释的 [package.json](package.json) 和 [tsconfig.build.json](tsconfig.build.json)。JSON 的键名和字符串都用双引号，数组写在 `[]` 中，对象写在 `{}` 中；标准 JSON 不支持 `//` 注释或末尾逗号。因此说明放在这里，配置正文保持原样。

## package.json：别人怎样找到这个包

| 字段 | 当前含义与例子 |
| --- | --- |
| `name` | 包名是 `@earendil-works/pi-schema`；前面的 `@earendil-works/` 是 npm 作用域，应用通过这个完整名字导入。 |
| `version` | 当前包版本为 `1.5.0`，不是 JSON Schema 的规范版本；支持的规范版本另外由校验选项选择。 |
| `description` | 包的英文介绍：把规则编译成普通函数闭包，支持 draft 2020-12 与 draft 7；它只是元数据，不执行校验。 |
| `type: "module"` | 声明本包的 `.js` 文件按 ECMAScript 模块解释，可使用 `import`/`export`。它不负责把 TypeScript 转成 JavaScript。 |
| `main` | 传统包入口指向构建后的 `./dist/index.js`。文件需要先经构建生成。 |
| `types` | 传统类型入口指向 `./dist/index.d.ts`，给 TypeScript 提供声明；声明文件不会检查实际用户输入。 |
| `exports` | 明确列出允许消费者导入的两个包路径及各自的条件入口，详见下表。 |
| `sideEffects: false` | 向打包器声明本包模块可以按无副作用模块处理，便于删除未使用的导入。它不是运行时沙箱，也不是对每个导出函数的承诺。 |
| `files` | 发布文件清单包含 `dist`、英文 README、CHANGELOG 和 LICENSES；npm 还有自动包含的包元数据等规则，不能把此数组当成发布归档的全部路径。学习说明与测试夹具不在此数组中。 |
| `scripts` | 命令的名称到命令文本的映射；读取此 JSON 本身不会执行命令，详见后文。 |
| `keywords` | `json-schema`、`validation`、`validator`、`csp` 是包检索标签，不是程序选项。 |
| `author`、`license` | 作者与本包许可的元数据；第三方格式实现和测试数据仍保留各自的来源与许可。 |
| `repository` | `type: "git"` 表示 Git 仓库；`url` 指向整个 pi 仓库，`directory` 指出本包在仓库内的 `packages/schema` 目录。不会自动拉取代码。 |
| `engines.node` | `>=22.19.0` 声明 Node 版本下限；安装工具如何处理不兼容环境取决于其设置，不是 JSON 在程序启动时执行的版本检查。 |
| `devDependencies` | 固定版本的开发、测试和基准依赖；此文件没有 `dependencies` 运行依赖项。具体用途见后文。 |

`exports` 中的 `"."` 表示包本身，`"./formats"` 表示子路径：

| 导入路径 | `source` 条件 | `types` 条件 | `import` 条件 |
| --- | --- | --- | --- |
| `@earendil-works/pi-schema` | `./src/index.ts` | `./dist/index.d.ts` | `./dist/index.js` |
| `@earendil-works/pi-schema/formats` | `./src/formats/index.ts` | `./dist/formats/index.d.ts` | `./dist/formats/index.js` |

条件导出让解析工具按自己的条件集合选择路径；`source` 是这里约定的条件名，普通 Node 导入不会仅因为仓库里存在源码就自动选择它。本包的 [vitest.config.ts](vitest.config.ts) 为 Vite 和 SSR 解析显式启用 `source`；根类型检查也有自己的路径映射。`types` 提供开发时的类型信息，`import` 指向运行代码，不能把两者混为运行时校验。

例子：应用导入 `compile` 后还要调用 `compile(schema)` 得到校验器，再调用 `validator.check(value)` 才检查数据。导入 `/formats` 得到格式函数表后，还要显式把它交给 `compile` 的 `formats` 选项才启用相应格式检查。

## scripts：命令会做什么

以下命令文本在本包目录运行时，`../../` 指向仓库根目录。

| 名称与原命令 | 流程、结果和副作用 |
| --- | --- |
| `clean`: `node ../../scripts/package-files.mjs clean dist` | 启动 Node 执行仓库的文件助手；`clean` 分支对传入的 `dist` 递归删除，`force: true` 允许目标不存在。它删除的是构建输出，不是类型检查。 |
| `build`: `tsc -p tsconfig.build.json` | `-p` 指定项目配置；编译本包源码并把构建结果写入 `dist`。它使用下面的构建配置，不使用根配置的 `noEmit` 设置。 |
| `test`: `vitest --run` | `--run` 表示执行一次后退出；范围由 Vitest 配置、默认发现规则和命令行选择决定。不能据此把整个仓库测试称作只包含离线用例。 |
| `bench`: `node --expose-gc test/bench/all.ts` | 显式开放 `global.gc`，运行基准总入口；总入口顺序启动一致性、速度、禁代码生成的速度、准备开销、内存、打包体积六组子程序，读取/清理中间 JSON 并写汇总。这会执行基准和写文件。 |
| `prepublishOnly`: `npm run clean && npm run build` | `&&` 表示前一条成功后才运行后一条；这是 npm 发布前钩子。它先清旧输出再构建，文本中没有测试或发布命令。本轮仅解释，不运行发布钩子。 |

按仓库约定，验证时从本包选择具体测试，例如：

```sh
node ../../node_modules/vitest/dist/cli.js --run test/conformance.test.ts
```

这条命令运行一个测试文件，其夹具与已知预期失败见 [fixtures/STUDY_NOTES.md](test/fixtures/STUDY_NOTES.md)。不要把阅读配置当成运行了测试，也不要把 `build` 当成仓库统一的 `npm run check`。

## devDependencies：为什么只有开发依赖

版本号在当前清单中均为精确版本；本页列出当前用途，不建议更新或安装依赖。

| 依赖 | 当前版本 | 在仓库中的用途 |
| --- | --- | --- |
| `@cfworker/json-schema` | `4.1.1` | 基准候选，通过 `test/bench/candidates.ts` 适配。 |
| `@oh-my-pi/omptype` | `18.13.3` | 基准候选，同样在候选适配文件中导入。 |
| `ajv` | `8.20.0` | 基准候选，分别选择 draft 7 和 2020-12 入口；同时使用其本地 draft-07 meta-schema。 |
| `ajv-formats` | `3.0.1` | 在基准需要格式检查时给 Ajv 注册其自己的格式检查。 |
| `ata-validator` | `1.61.3` | 基准中的默认引擎与显式解释器候选。 |
| `typebox` | `1.3.27` | 测试构造 TypeBox schema、检查静态类型兼容，也参与基准；本包格式检查的改编源码另保存在 `src/formats/typebox/`，不是运行时从 npm TypeBox 加载。 |
| `vitest` | `4.1.12` | 测试框架与配置辅助函数。 |
| `zod` | `4.6.7` | 基准的原生规则及 JSON Schema 转换适配。 |

这些开发依赖与使用本包的应用不同：`src/index.ts` 的公共入口导出本包构造器、类型和校验器；基准候选的导入位于 `test/bench/`。30 份 TypeBox 格式源码属于已有第三方来源记录，本轮不改其正文，不将它们算作中文逐句注释完成。

## tsconfig.build.json：构建哪些文件，输出到哪里

| 字段 | 含义与边界 |
| --- | --- |
| `extends: "../../tsconfig.base.json"` | 继承仓库公共配置。路径相对这份配置文件；不是继承根 `tsconfig.json`，所以不会继承后者的 `noEmit: true`。 |
| `compilerOptions` | 对公共编译选项作本包覆盖；下面两项只负责目录边界与输出位置。 |
| `outDir: "./dist"` | 构建产物写到本包的 `dist`；例如 `src/index.ts` 对应 `dist/index.js`。 |
| `rootDir: "./src"` | 输出目录结构以 `src` 为根；它不是用于发现输入文件的过滤器，输入发现由 `include` 等规则处理。 |
| `include: ["src/**/*.ts"]` | `**/` 可以跨多层子目录，匹配源码树中的 TypeScript 文件；本包 `test/` 与 `vitest.config.ts` 不在此入口清单中。 |
| `exclude` | 排除 `node_modules`、`dist`、所有匹配的 `.d.ts` 声明文件及 `src` 内的 `.d.ts`。这是输入发现过滤；被源码导入的依赖仍可被编译器解析，不能理解成安全隔离。 |

继承的公共选项还决定：以 `ES2024` 为目标，使用 `Node16` 模块及解析方式，开启严格类型检查与仅可擦除的 TS 语法，保留明确的模块语法；输出声明文件、声明映射和源码映射，并把源码文本带入映射。`rewriteRelativeImportExtensions` 使输出中的相对 `.ts` 导入改用对应 JavaScript 扩展名。`types: ["node"]` 提供 Node 环境类型，不能在浏览器里凭空创建 Node API；`skipLibCheck` 跳过声明文件内部的类型检查，也不表示跳过手写源码。

例如 `src/index.ts` 的 `export type` 只存在于类型层；构建后 JavaScript 不包含这些类型声明，而 `.d.ts` 保留供消费者使用。用户输入是否满足 JSON Schema，最终仍由运行时 `check`/`errors` 等方法判断。
