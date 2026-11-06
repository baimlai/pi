# 包清单与 daemon 构建

本页对应 `packages/env/package.json`、`tsconfig.build.json` 和 daemon 的构建输入。前两个文件使用 JSON，不能插入 `//` 注释，所以在这里逐项说明；原清单字段和值保持不变。Rust 手写源码的说明直接放在 `.rs` 文件中。

## package.json

| 字段 | 本包中的实际作用 |
| --- | --- |
| `name`、`version` | npm 包名与发布版本。`daemon/build.rs` 也读取此版本，编译进 daemon 的 `hello.version` 与 `--version` 输出；不使用 `daemon/Cargo.toml` 的 `0.1.0` 作为对外版本。 |
| `description` | 包用途文字：Rust daemon 运行在目标机器，TypeScript 客户端实现 Durable 的执行环境接口。 |
| `type: "module"` | 本包内 `.js` 按 ES module 解释；不是在运行时把 `.ts` 自动编译成 `.js`。 |
| `main`、`types` | 传统入口分别指向 `dist/index.js` 和声明文件 `dist/index.d.ts`。这些文件需要构建产生。 |
| `exports["."]` | 声明包根入口。支持 `source` 条件的工具可选 `src/index.ts`；类型解析器可选 `types`，ES module 可选 `import`，其余使用 `default`。这里没有为任意深层路径开放子入口。 |
| `sideEffects: false` | 给打包工具的声明，允许删除未使用导出对应的模块；不是在操作系统中禁止文件或进程副作用。实际调用远端操作仍会执行 I/O。 |
| `files` | npm 打包包含 `dist`、`bin`、`docs`、README 和 CHANGELOG；npm 自身另有必须包含/排除的规则。源码、测试和 Cargo 工程不是此白名单中的发布目录。 |
| `scripts.clean` | 调仓库的 `scripts/package-files.mjs clean dist` 清理本包构建输出。学习注释任务无需运行。 |
| `scripts.build` | `tsc -p tsconfig.build.json` 编译 TypeScript 客户端，输出 JS、声明与映射；不会编译 Rust。 |
| `scripts.build:daemon` | `cargo build --manifest-path daemon/Cargo.toml --locked` 编译 Rust 可执行程序；没有 `--release`，默认输出 `daemon/target/debug/pi-env`（Windows 加 `.exe`）。`--locked` 要求沿用已有依赖解析，若需要更新锁文件会失败。 |
| `scripts.test` | `vitest --run` 是包内完整测试入口，包含可被环境变量启用的真实 SSH 测试。学习任务按根规则选安全的指定文件，不直接调用完整入口。 |
| `scripts.prepublishOnly` | npm 发布生命周期钩子，顺序 clean、build；没有 `build:daemon`，也不负责生成各平台 `bin`。本次不发布、不运行钩子。 |
| `keywords` | npm 检索用标签，不参与协议选择或功能判断。 |
| `author`、`license`、`repository` | 作者、许可证与源码定位；`repository.directory` 指向 monorepo 内此包目录。 |
| `engines.node` | 声明 Node 最低要求 `22.19.0`；不是此包在每次导入时主动检查 Node 版本。 |
| `dependencies` | Chord 与 Durable 的精确版本。客户端的上下文、结果和环境契约来自这些包；编译路径另见下文。 |
| `devDependencies` | Vitest 的精确版本，只供开发/测试。Rust crates 不在 npm 依赖区声明。 |

例如，支持 `source` 条件的测试工具从包名找到 TypeScript 入口，不代表 Rust 的执行程序也已经存在。`test/daemon.ts` 会在模块加载时选 `PI_ENV_DAEMON` 或 debug 路径，并检查该文件存在；缺失就抛错，不会自动构建。

## tsconfig.build.json

| 字段 | 本包中的实际作用 |
| --- | --- |
| `extends` | 继承根 `tsconfig.base.json` 的严格检查、ES2024、Node16 模块规则、声明/源码映射等选项。TypeScript 的类型检查不等于对网络 JSON 数据做运行时校验。 |
| `compilerOptions.outDir` | 输出到本包 `dist`，不覆盖 `src`。 |
| `compilerOptions.paths` | 把 `@earendil-works/chord/context` 和 `@earendil-works/pi-durable/env` 的编译期解析分别指向相邻包的 `dist/.../index.d.ts`。这些声明应事先构建；`paths` 本身不会重写输出 JS 的包说明符，也不会下载依赖。 |
| `compilerOptions.rootDir` | 源码根目录 `src`；输出相对目录从这里计算。例如 `src/ssh.ts` 对应 `dist/ssh.js`。 |
| `include` | 起始文件集合为 `src/**/*.ts`，测试不从这里作为根文件进入。被源码导入的依赖仍由编译器解析。 |
| `exclude` | 从起始文件筛选中排除 `node_modules`、`dist` 和声明文件匹配项；这不是禁止导入这些路径。 |

`vitest.config.ts` 的 `defineConfig` 提供配置类型提示，`environment: "node"` 使测试在 Node 环境运行。两个 `conditions: ["source"]` 分别用于普通解析和服务端解析，允许工作区包使用源码分支。它们与上面的发布构建 `paths` 分工不同：测试尽可能从源码运行，发布构建引用其他包已构建的声明。

## Rust 输入与生成边界

`daemon/Cargo.toml` 是手写输入：crate 名称、Rust edition、精确直接依赖、按目标启用的系统调用库以及 release 优化设置。`rust-toolchain.toml` 固定工具链 `1.96.0` 并要求 rustfmt/clippy 组件。`build.rs` 是 Cargo 自动发现的手写构建脚本：它读 `../package.json`，通过 `cargo:rerun-if-changed` 声明重建依赖，通过 `cargo:rustc-env` 为 `main.rs` 的 `env!` 提供编译期版本。它用字符串切分读取可信清单，不是 JSON 校验器。

`daemon/Cargo.lock` 首行明确说明由 Cargo 自动生成。它记录直接和间接 crates 的具体版本、registry 来源、校验和及依赖关系，输入来自 Cargo 清单与 Cargo 解析结果。它不是需要逐行加中文的手写实现，本次不编辑、不更新，也不把其正文计为中文注释完成。它包含各目标依赖，不意味着本机每个平台模块都已编译。例如 `notify` 间接需要的另一版 `windows-sys` 可以与本包直接依赖版本并存，不能只因重复名字就删除。

`daemon/target/` 和 TypeScript 的 `dist/` 是构建产物。发布时，各平台 `bin/pi-env-<platform>-<arch>/pi-env[.exe]` 来自 `.github/workflows/env-daemons.yml`：按矩阵编译 `--release --locked --target ...`，复制为 CI artifacts，再由发布工作流下载到本包 `bin`。这些二进制不手工加注释；应修改手写输入后重新构建。Android 的两个目标依赖 NDK 链接器；Windows 构建启用静态 C runtime。此追溯只说明生成路径，不表示本机执行过 CI 矩阵或发布。

## 本次验证边界

学习说明不改变清单数据、协议或构建默认值。静态核对可以证明新增内容只是注释/配套文档；只有真正运行编译与测试，才能声称对应平台通过。Session 17 开始时，本机 PATH 没有 `cargo`、`rustc`，也没有默认 debug daemon，所以未安装工具链、未重建二进制、未把缺少依赖导致无法运行的集成测试记为通过。最终具体执行记录保存在学习分支的提交历史和 [学习日志](../../../docs/learning/pi/STUDY_LOG.md) 中。
