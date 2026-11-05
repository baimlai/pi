/**
 * The `tool_search` tool as an extension. The CLI loads it as a built-in extension; SDK users add
 * `createToolSearchExtension()` to their extension factories.
 *
 * `tool_search` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`.
 */

// 工具搜索的注册入口：CLI 默认加载这个扩展，SDK 可把工厂加入自己的扩展列表；实际分词、排名与激活在 tool.ts。
import type { ExtensionFactory } from "../../core/extensions/types.ts";
// import type 只给返回工厂的签名提供编译检查；工具创建器是运行时依赖。
import { createToolSearchToolDefinition } from "./tool.ts";

/** 创建扩展工厂；被宿主调用时注册 tool_search，并注入当前工具目录接口，注册后默认不激活。 */
export function createToolSearchExtension(): ExtensionFactory {
	// 闭包接收 pi，执行期间可访问当下注册/激活的工具，不保存一个永远过期的工具数组。
	return (pi) => {
		// tools:pi 只使用查询/设置工具集合的方法；后写 defaultActive:false 覆盖默认激活状态，不代表现在执行搜索。
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
	};
}

// 默认导出工厂实例，加载器调用它才实际注册工具。
export default createToolSearchExtension();
