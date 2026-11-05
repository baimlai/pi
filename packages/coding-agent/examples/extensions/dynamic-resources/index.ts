// 通过资源发现钩子返回扩展旁边的技能、提示模板和主题路径；本文件不直接读取这些资源。

/**
 * 文件导读（dynamic-resources 扩展示例入口）
 *
 * 所属与用途：本文件是 `packages/coding-agent/examples/extensions/dynamic-resources` 示例的
 * 入口，演示扩展如何在 `resources_discover` 事件中向宿主“发现”额外资源：一个技能文件、
 * 一个提示模板、一个主题 JSON。它只返回路径，不读取、不解析、也不执行这些文件。
 *
 * 上游如何进入：本目录没有 package.json，按单文件/目录扩展加载：
 *   pi --extension packages/coding-agent/examples/extensions/dynamic-resources
 * 宿主在构建会话资源时发出 `resources_discover`，调用本默认导出的回调。
 *
 * 下游读取方：
 * - `SKILL.md`：由技能加载器解析为可调用技能；
 * - `dynamic.md`：由提示模板加载器解析；
 * - `dynamic.json`：由主题加载器 `loadThemeFromPath`（内部调用 `createTheme`）解析。JSON 的字段含义：
 *   `$schema` 只是编辑器提示；`vars` 定义颜色变量；`colors` 把界面角色映射到变量名、
 *   十六进制色或空字符串（空串表示终端默认色）；`export` 提供 HTML 导出的三个背景色。
 *   这些颜色配置不会执行工具或改变模型推理设置。
 *
 * 能力清单：
 * - `baseDir`：根据 `import.meta.url` 定位本文件所在目录，不依赖启动时的工作目录。
 * - 默认导出：注册 `resources_discover` 回调，返回 `skillPaths`/`promptPaths`/`themePaths`。
 *
 * 典型运行与示例：
 *   1. 用上述命令启动 pi；
 *   2. 宿主发现资源后，技能/提示/主题出现在对应列表；
 *   3. 选择 `dynamic-resources` 主题，边框使用 `vars.blue`，`text: ""` 使用终端默认色。
 * 返回对象形如：
 *   { skillPaths: ["/.../SKILL.md"], promptPaths: ["/.../dynamic.md"], themePaths: ["/.../dynamic.json"] }
 * 这是真实回调形状；文件是否存在、格式是否合法由后续加载器决定，本示例不检查。
 *
 * 建议阅读顺序：先看 `baseDir` 的定位方式，再看默认导出注册的事件与返回字段；
 * 想了解主题字段时读同目录 `LEARNING.md` 和 `dynamic.json`，不要只根据文件名猜测。
 *
 * 失败行为：本文件不抛错；若资源文件缺失或 JSON 非法，问题会出现在宿主对应的加载流程中，
 * 而不是 `resources_discover` 回调里。
 */

// dirname 取父目录，join 根据平台规则拼接路径。
import { dirname, join } from "node:path";
// ES 模块的 import.meta.url 是 URL，转成本地路径后才能交给路径函数。
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 以本扩展源码位置定位配套资源，不依赖用户从哪个目录启动 Pi。
const baseDir = dirname(fileURLToPath(import.meta.url));

/**
 * 扩展默认导出：注册资源发现事件。
 *
 * 输入：`pi` 扩展 API。输出：无返回值（只注册监听器）。
 * 副作用：修改宿主内存中的事件监听表；不读文件、不发网络请求。
 * 错误路径：注册本身不抛错；回调返回值不符合类型时由编译期检查，运行时加载器自行处理。
 * 主要流程：调用 `pi.on("resources_discover", handler)`。
 *
 * 示例：加载扩展后，宿主在启动或重载发现资源时调用 handler，得到三个 `join(baseDir, ...)` 生成的绝对路径。
 */
export default function (pi: ExtensionAPI) {
	// 收到发现事件才返回资源路径对象，没有文件写入或网络请求。
	// handler 合同会传入 ResourcesDiscoverEvent 与上下文；本示例不使用，因此省略参数。
	// 返回值中的数组允许为空，但本示例固定返回三个路径。
	pi.on("resources_discover", () => {
		// 对象中的三个列表分别交给技能、提示和主题加载流程。
		return {
			// 技能路径指向旁边的 SKILL.md。
			skillPaths: [join(baseDir, "SKILL.md")],
			// 提示模板路径指向 dynamic.md。
			promptPaths: [join(baseDir, "dynamic.md")],
			// 主题路径指向 JSON 配置，字段说明见同目录 LEARNING.md。
			themePaths: [join(baseDir, "dynamic.json")],
		};
	});
}
