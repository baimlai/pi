// 普通 Node 的 jiti 懒转译入口；上游 loader 第一次真正导入外部扩展时才动态加载本文件。
// 本文件仅重导出 createJiti 工厂，不在这里创建加载器或执行扩展；已安装 jiti 实现会在确实需要转译时再加载 Babel。
// Normal Node runtimes use jiti's lazy transform so Babel is loaded only when
// native loading fails and an extension needs transformation.
// 值重导出可调用工厂；例如 loader 取得它后再传 import.meta.url/选项创建实例，重导出本身不会运行这次工厂调用。
export { createJiti } from "jiti";
