# 扩展示例目录导读：清单、构建产物与资源边界

本目录的 `.ts` 文件是 pi coding-agent 的扩展示例，`README.md` 按功能分类列出了每个示例。这里补充 README 没有展开的工程边界：示例如何被加载、子目录里的 `package.json` 有什么作用，以及哪些文件是生成物、不能手改。

## 加载方式

单个 `.ts` 文件可以直接作为扩展加载：

```bash
pi --extension examples/extensions/permission-gate.ts
```

带 `package.json` 的目录是一个可安装的扩展包。清单中的 `pi.extensions` 数组告诉 pi 该包的入口文件，例如 `["index.ts"]`；`name` 是包身份，`private: true` 防止误发布，`type: "module"` 按 ES 模块解析。`dependencies`/`devDependencies` 是该扩展示例自己的依赖，不影响 pi 本体。

`custom-provider-anthropic/`、`custom-provider-gitlab-duo/`、`gondolin/`、`with-deps/` 都使用这种目录形式；它们各自的入口代码文件头解释了如何注册 provider、工具或资源。

## 数据与资源文件

- `dynamic-resources/dynamic.json` 是 `index.ts` 通过 `resources_discover` 加载的数据夹具；JSON 不能写注释，字段含义由该示例的入口文件头说明。
- `dynamic-resources/`、`plan-mode/`、`subagent/` 的代码文件按目录组织，同目录文件共同构成一个示例，不要拆开单独运行。

## 生成物与不手改的文件

- `doom-overlay/doom/build/doom.js` 是 Emscripten 产物，由 `doom-overlay/doom/build.sh` 编译 `doomgeneric_pi.c`、`doomgeneric` 上游源码和 DOOM 引擎 C 文件生成；它旁边的 `doom.wasm` 通常也由同一次构建产生。不要手改 `doom.js`；要调整分辨率或导出函数，改 `build.sh` 的环境变量/编译参数后重新构建。
- `doom-overlay/.gitignore` 忽略 `doom1.wad`，它在首次运行时下载/查找，不属于仓库内容。
- 其他 `.gitignore` 是各示例包的本地依赖/产物忽略规则，不含可执行逻辑。

## 建议阅读顺序

1. 先读 `README.md` 的功能分类，选一个主题。
2. 打开对应 `.ts` 的文件导读，确认它注册的事件、工具或 UI；涉及子目录时从入口 `index.ts` 进入。
3. 需要扩展 API 细节时，读 `packages/coding-agent/docs/extensions.md` 和 `src/core/extensions` 的实现。
