// Fixture plugin (slice 7c): a facet reading a file of its own plugin through `pluginFile`.

import { readFileSync } from "node:fs";
import { constant, defineFacet } from "@earendil-works/chord";
import { pluginFile } from "@earendil-works/chord/plugins";
import { Files } from "../contracts/contract.ts";

// 默认导出 facet，加载时注册 Files 的工厂；工厂取 assets/data.txt 并返回固定可观察 text。
// 例如夹具文件文本带末尾换行，trim 后才暴露；pluginFile 把路径限制在当前插件目录，readFileSync 的错误会使激活失败。
// 这是同步文件读取夹具，用于测试插件文件解析；这里不声明 self.open 原生资源。
export default defineFacet((host) =>
	// setup 只注册工厂；工厂稍后执行 readFileSync，constant 包装的文本不会再随文件改写自动变化。
	host.serve(Files, () => ({ text: constant(readFileSync(pluginFile("assets/data.txt"), "utf8").trim()) })),
);
