# 内置主题 JSON 导读

本目录的 `dark.json` 与 `light.json` 是交互模式的内置深色/浅色主题。JSON 不允许注释，因此字段含义、加载链和修改约束集中写在这里；两个文件本身只保存数据。

## 加载链

- `theme-schema.ts`：用 TypeBox 定义主题文件的结构、必需颜色槽和值类型；`main.ts` 在读取用户主题前安装验证器。内置主题不需要通过这份 schema 才能使用。
- `theme.ts`：`loadTheme` 读取主题 JSON，`createTheme` 把颜色值解析成 TUI 的 `Color`。`vars` 先形成变量表，`colors`/`export` 中的字符串可以引用变量名。
- `theme-controller.ts`：按设置和终端外观选择 `dark` 或 `light`，并处理热加载与用户主题目录。
- `system-theme.ts`：从终端上报色生成系统主题，是另一条颜色来源，不读取这两个文件。

## 字段

- `$schema`：编辑器补全/校验用的 schema URL；运行时不会按该 URL 下载验证器。
- `name`：主题名，不能包含 `/`，斜杠保留给自动明暗主题配置。
- `appearance`：`dark` 或 `light`；省略时由使用方从颜色推断。
- `vars`：可复用颜色变量。键是变量名，值是颜色字符串或 0..255 的终端调色板索引。
- `colors`：终端界面颜色槽，覆盖文本、边框、选中背景、用户/自定义消息、工具执行状态、Markdown、diff、语法高亮和 thinking 级别。每个槽是否必需由 `theme-tokens.ts` 的 `fallback` 决定：没有 fallback 的槽必填，有 fallback 的可省略。
- `export`：HTML 导出页面使用的背景色槽（`pageBg`、`cardBg`、`infoBg`），与终端主题分开。

颜色值支持 hex、OKLCH/OKHSL、变量名，以及空字符串（表示终端默认色）；整数表示 256 色索引。schema 只检查值的形状（字符串或 0..255 整数），变量引用是否存在、颜色语法是否可解析由 `theme.ts` 和 TUI 的 `parseColor` 在运行时处理。

## 修改约束

- 两个内置主题应保持同一组颜色 token；只改某一侧会造成明暗主题行为不一致。
- 新增 token 需要同时修改 `theme-tokens.ts`、schema 生成路径和两个 JSON；没有 fallback 时它是必填项。
- `colors` 不允许未知键，拼错的 token 会被 schema 拒绝，不会被静默忽略。
- 这些 JSON 是手写数据，不是生成产物；修改后运行主题相关测试，例如 `packages/coding-agent/test/theme-style.test.ts` 和 `theme-controller.test.ts`。
