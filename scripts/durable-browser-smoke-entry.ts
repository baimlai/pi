// 文件导读
// 所属：仓库根 scripts/ 的浏览器冒烟入口，供 check-browser-smoke.mjs 用 esbuild 打包，不直接运行。
// 职责：把 pi-durable 主入口与 env、storage/jsonl、storage/sqlite 三个子路径入口放进浏览器构建图，
//   若这些公开入口意外引入 Node 专用内置模块或适配器，esbuild 的平台检查/打包会暴露问题。
// 上游：scripts/check-browser-smoke.mjs 把它作为 esbuild 的 entry point，platform=browser。
// 输入：无；输出：无（本文件只在构建期被分析，console.log 不会执行）。
// 副作用：无运行时副作用；构建脚本会把结果写到临时目录。
// 失败路径：入口无法解析、引入 node:* 内置模块或 platform 不兼容时，esbuild 构建失败，父脚本以 1 退出。
// 示例：node scripts/check-browser-smoke.mjs   # 内部打包本入口
// 建议阅读顺序：先看四个命名空间导入，再看末尾的存活引用。
// 让四个 Durable 公共入口进入浏览器构建图；这证明打包边界，不证明数据库或文件适配器运行成功。
// * as 把公开导出收进命名空间对象，主入口应适用于浏览器。
import * as durable from "@earendil-works/pi-durable";
// 加载环境接口入口，不在此选择 Node 文件系统环境。
import * as environment from "@earendil-works/pi-durable/env";
// 保留 JSONL 抽象入口，实际 I/O 仍须由适配器提供。
import * as jsonl from "@earendil-works/pi-durable/storage/jsonl";
// 保留 SQLite 抽象入口，本行不打开数据库。
import * as sqlite from "@earendil-works/pi-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
// 引用四个命名空间的键，避免它们全部被当成未用代码删除；构建脚本只打包并检查输入图，不执行本行。
// Object.keys 在运行时也只是读取导出名；由于文件从不执行，它只服务于打包期 tree-shaking 分析。
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
