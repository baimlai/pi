/**
 * 文件导读
 *
 * 所属：packages/chord/test/examples/49-plugin-api/app/v3.ts，示例 49-52 共用的“应用 API v3”模块。
 * 演示什么：插件不直接 import Chord，而是 import 应用声明的 API 模块。v3.ts 既是 Chord 能力的转发层
 * （defineFacet、defineRegistry、local、method、str 等），又承载应用自己的契约 Greetings 和版本常量。
 * 上游/下游：main.ts 以 "@acme/app/v3" 为宿主包把本模块实例交给插件；plugins/hello 等 v3 插件从它导入 API。
 * 下游的 v2.ts 也 re-export 本模块的符号，形成“旧版本是薄封装”的结构。
 * 能力清单：Chord 的 defineFacet/defineRegistry/defineState/local/method/str/constant/int/obj；应用注册表 Greetings；API_VERSION。
 * 典型运行顺序：插件构建时按 api.versions 检查 import 路径；求值时宿主包实例提供此模块的真实导出。
 * 示例（真实签名）：const Greetings = defineRegistry<string, readonly string[]>("acme.greetings", { version: 1 });
 * 建议阅读顺序：先读 re-export 清单确认插件能用什么，再读 Greetings 的贡献类型与合成值类型。
 * 前置条件：仅作为宿主包被 import；直接执行本文件只会建立模块导出，不产生输出。
 */
// Acme's API, version 3, shared by every host kind (`@acme/app/v3`): what a plugin imports from its host. It re-exports
// the part of Chord Acme supports (plugins never import Chord directly) next to Acme's own part: the `Greetings`
// registry every kind has. Examples 49 to 52 build against it; a real app keeps it in `src/api/v3/`.

// defineRegistry 需要在本模块内部调用一次（创建 Greetings token），所以它是普通导入而不仅是 re-export。
// 路径 ../../../../src 从 test/examples/49-plugin-api/app/ 回到 packages/chord/src，直接引用 v2 源码。
import { defineRegistry } from "../../../../src/index.ts";

// 逐项 re-export：插件从 @acme/app/v3 拿到这些名字，它们的值是 Chord 的同一批函数。
// constant/int/obj/str 用于声明契约 schema；local/method/defineFacet/defineState 用于定义对象与 facet。
export {
	constant,
	defineFacet,
	defineRegistry,
	defineState,
	int,
	local,
	method,
	obj,
	str,
} from "../../../../src/index.ts";

// defineRegistry 的两个类型参数：C 是贡献者提交的值类型（这里每个插件贡献一条 string），
// V 是服务端 compose 后的读值类型（这里把表组合成只读字符串数组）。
// "acme.greetings" 是注册表名，必须符合名字字符规则；version 是贡献者编译时对应的注册表版本。
// 返回的 Registry<string, readonly string[]> 是插件与 main.ts 共享的 token：宿主按 name 找到同一注册表记录，
// 插件 bundle 里的另一份 token 副本也能对上，不依赖对象身份。
/** Lines of greeting, one per contributing plugin; the app's start-data facet serves it (composing them in order). */
export const Greetings = defineRegistry<string, readonly string[]>("acme.greetings", { version: 1 });

// API_VERSION 是普通的运行时字符串常量，类型被推断为字面量 "v3"；v2.ts 没有重新导出它，
// 因此 v2 插件的公开 API 面里没有这个新字段（v2.ts 可按需添加转发）。
/** The API's own version, for plugins that print it. */
export const API_VERSION = "v3";
