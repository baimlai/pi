# 动态资源示例

`index.ts` 在 `resources_discover` 事件返回同目录三个资源的路径；返回路径并不立即加载、执行或验证文件。宿主后续分别解析技能、提示模板和主题。

`dynamic.json` 保持标准 JSON，没有插入注释。`$schema` 为编辑器提供主题 schema 地址，地址本身不保证运行时校验已经执行。`name` 是主题名。

`vars` 把重复使用的颜色命名，例如 `blue` 对应 `#5f87ff`。`colors` 把界面角色映射到变量名、直接十六进制颜色或空字符串；例如 `border: "blue"` 使用该变量，`customMessageLabel` 直接给颜色，`text: ""` 使用终端默认颜色。角色涵盖边框/通知、用户与自定义消息、工具状态与差异、Markdown、代码语法、思考档位及 bash 提示；这些是颜色配置，不会执行对应工具或改变模型思考设置。`export` 的三个背景色供会话 HTML 导出使用。

例：加载并选择 `dynamic-resources` 主题后，边框颜色取 `vars.blue`，并非读取名为 blue 的文件。配套 `SKILL.md` 与 `dynamic.md` 仍保留原始英文提示内容，避免改变传给模型的文本。
