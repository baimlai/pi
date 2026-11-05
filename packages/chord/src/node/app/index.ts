// Chord v2's app kit (`@earendil-works/chord/app`; slice 13): `startServer` on the server and `startWorker` in a
// worker's entry, the start-data objects, sessions and the owner's sign-in, device pairing, the files of each host,
// export and import per address, and the optional plugins (users, invites, ephemeral login).

// 所属：packages/chord/src/node/app，app kit 的公开入口（@earendil-works/chord/app，slice 13）。
// 职责边界：只重导出契约、类型与启动函数，不包含启动逻辑；上游是应用 import，下游是各实现文件。
// 结果与错误：re-export 不改变行为；类型和运行时常量由源模块决定。
// 能力清单：App/AppApi/AppError/AppKind/AppOptions/AppPlugins/AppWorkerKind/Server/startServer 来自 app.ts；ARCHIVE_FORMAT/ArchiveManifest 来自 archive.ts；EphemeralUser/ephemeralLoginFacet 来自 ephemeral.ts；FileInfo/Files/FilesCaps 来自 files.ts；AppInfo/WorkerInfo 来自 info.ts；inviteFacet 来自 invite.ts；OWNER/OwnerPrincipal 来自 owner.ts；SESSION_COOKIE/SessionInfo/SessionKind/Sessions 来自 sessions.ts；defineUsers 来自 users.ts；startWorker/WorkerOptions 来自 worker.ts。
// 组合顺序：应用通常先导入 startServer/Server 与插件契约，再按需导入 Files、Sessions、defineUsers 等；type-only 导入不保留运行时值。
// 示例：import { startServer, Server, Files } from '@earendil-works/chord/app';
// 建议阅读顺序：先看 app.ts 的 AppOptions/App，再看本文件列出的各契约，最后按功能跳到实现文件。
export {
	type App,
	type AppApi,
	type AppError,
	type AppKind,
	type AppOptions,
	type AppPlugins,
	type AppWorkerKind,
	Server,
	startServer,
} from "./app.ts";
export { ARCHIVE_FORMAT, type ArchiveManifest } from "./archive.ts";
export { type EphemeralUser, ephemeralLoginFacet } from "./ephemeral.ts";
export { type FileInfo, Files, type FilesCaps } from "./files.ts";
export { AppInfo, WorkerInfo } from "./info.ts";
export { inviteFacet } from "./invite.ts";
export { OWNER, type OwnerPrincipal } from "./owner.ts";
export { SESSION_COOKIE, type SessionInfo, type SessionKind, Sessions } from "./sessions.ts";
export { defineUsers } from "./users.ts";
export { startWorker, type WorkerOptions } from "./worker.ts";
