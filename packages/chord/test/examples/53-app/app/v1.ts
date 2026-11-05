// 文件导读
// 所属：packages/chord/test/examples/53-app/app，notes 应用的 API v1（import 说明符 @notes/app/v1），
// 由 server 和 worker 两类宿主共享；真实应用通常把这样的文件放在 src/api/v1.ts。
// 作用：决定插件能 import 到哪些名字——Chord 的契约构造器子集、kit 的启动数据对象和 Files、应用自己的
// host kind（Project）以及首页 Sections 注册表。
// 上游：start.ts 的 API.modules 和 worker.ts 的 startWorker 使用同一份 API；插件构建按 kind 提供这些模块名，
// 于是插件源码里的 `@notes/app/v1` 会解析到本文件，而不是运行时的 node_modules。
// 下游：../../../../src/index.ts 的公共 API 与 ../../../../src/node/app/index.ts 的 kit 对象。本文件不执行
// 逻辑、不读写数据。
// 能力清单：
// - 再导出 arr/constant/defineFacet/defineRegistry/defineState/defineTable/int/local/method/obj/remote/str：
//   插件编写 schema、契约和 facet 时使用的构造器；
// - AppInfo/Files/WorkerInfo：kit 在宿主上提供的启动数据对象与每主机文件存储；
// - Project：应用定义的 host kind，每个项目对应一个 worker 进程；
// - Sections：首页区块注册表，只声明名称、版本和类型；它的 provider 由 home 插件提供。
// 典型用法（示例）：
//   import { defineFacet, Sections } from "@notes/app/v1";
//   export default defineFacet((_host, self) => self.contribute(Sections, { title: "Notes", path: "/notes/:id" }));
// 阅读顺序：先看再导出列表和 Project，再看 Sections 的两个泛型参数；插件侧用法见 plugins/home 与 plugins/notes。
// 注意：`export ... from` 只转发名字，不会在本文件创建局部绑定；AppInfo 等运行时值来自 kit。
//
// The notes app's API, version 1, shared by every host kind (`@notes/app/v1`): what its plugins import from their
// host. The part of Chord the app supports, the kit's start-data objects and files, the app's own host kind (a
// project, one worker per project) and its registry of home-page sections. The API only declares the registry: its
// provider is the home plugin of the app's required root, not base code. Examples 53 to 55 run this app; a real app
// keeps it in `src/api/v1.ts`.

// 本文件自己也要调用 defineRegistry/hostKind/str 这三个运行时函数，所以单独 import；
// 其余构造器只出现在再导出列表里，不需要局部绑定。
import { defineRegistry, hostKind, str } from "../../../../src/index.ts";

// 整块再导出：插件从 @notes/app/v1 能拿到的 Chord 能力就是这些，避免它们直接依赖 src/ 的相对路径。
export {
	arr,
	constant,
	defineFacet,
	defineRegistry,
	defineState,
	defineTable,
	int,
	local,
	method,
	obj,
	remote,
	str,
} from "../../../../src/index.ts";
// kit 的对象：AppInfo/WorkerInfo 是各宿主的启动数据，Files 是每主机文件存储。
// 这里导出的是运行时值；它们的契约形状由 src/node/app 的实现决定。
export { AppInfo, Files, WorkerInfo } from "../../../../src/node/app/index.ts";

// hostKind(名字, params schema)：声明一种宿主地址。str() 是运行时 schema，地址构造时会检查参数；
// 地址的 key 由 kind 和参数字段拼成，例如 Project({ id: "p1" }) 得到 "project|p1"。
/** A project of the app: its own worker process, store and files. */
export const Project = hostKind("project", { id: str() });

// defineRegistry<贡献类型, 合并值类型>：名称和 version 是运行时数据；compose 不在这里声明，
// 而由 provider 的 facet 用 host.serve(Sections, { compose }) 提供，因此核心 API 只负责声明注册表。
// 这里每个贡献是 { title, path }，合并后的值是标题字符串数组。
/** The home page's sections, one per contributing plugin (title and the path it links to). */
export const Sections = defineRegistry<{ readonly title: string; readonly path: string }, string[]>("notes.sections", {
	version: 1,
});
