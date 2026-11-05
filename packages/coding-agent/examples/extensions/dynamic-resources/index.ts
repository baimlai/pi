// 通过资源发现钩子返回扩展旁边的技能、提示模板和主题路径；本文件不直接读取这些资源。

// dirname 取父目录，join 根据平台规则拼接路径。
import { dirname, join } from "node:path";
// ES 模块的 import.meta.url 是 URL，转成本地路径后才能交给路径函数。
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 以本扩展源码位置定位配套资源，不依赖用户从哪个目录启动 Pi。
const baseDir = dirname(fileURLToPath(import.meta.url));

// 入口注册资源发现回调，返回值为空。例：宿主发 resources_discover 后得到这里三个绝对路径；存在性和内容校验由加载方处理。
export default function (pi: ExtensionAPI) {
	// 收到发现事件才返回资源路径对象，没有文件写入或网络请求。
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
