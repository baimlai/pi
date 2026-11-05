// Fixture plugin (slice 10): the worker facet, serving `Notes` at the worker's address with the label of `label.ts`.

import { constant, defineFacet, hostKind, remote, str } from "@earendil-works/chord";
import { label } from "./label.ts";

// 夹具自行携带 session 合同，按字符串 id 确定 worker 地址；不依赖 server 运行时的模块令牌相等。
const Session = hostKind("session", { id: str() });

// 声明远端 Notes：以 id 路由到对应 Session，main 变体只有字符串 label；版本和结构指纹用于绑定匹配。
const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	// 用对象参数 id 计算同 id 的地址；例如 s1 路由到 session|s1。
	hostAddress: ({ id }) => Session({ id }),
	variants: { main: { state: { label: str() } } },
});

// 注册工厂，把对象参数 id 与构建时导入的 label 拼成恒定状态；例如 s1 与 v1 得到 "s1 v1"。
// 工厂省略不用的 principal/self 形参；没有磁盘或网络副作用，新代码发布后 reference 可重绑定新标签。
export default defineFacet((host) =>
	// 返回远端要求的 main 变体与成员；模板字符串仅构造标签，不表示地址或版本验证。
	host.serve(Notes, ({ id }) => ({ variant: "main", members: { label: constant(`${id} ${label}`) } })),
);
