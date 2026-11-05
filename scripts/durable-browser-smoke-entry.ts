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
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
