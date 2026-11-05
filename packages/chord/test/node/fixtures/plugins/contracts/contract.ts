// Fixture plugin (slice 7c): contracts only, no facet; the other fixtures import (copy) it.

import { hostKind, int, local, method, remote, str } from "@earendil-works/chord";

/** The host kind of the fixtures' worker. */
// 声明无地址参数的 worker 种类；Worker() 才产生具体地址，此行不启动进程。
export const Worker = hostKind("test.worker");

/** Notes on the worker: a label, a count and `add`. */
// 远端合同 Notes：版本 1、无对象参数，main 变体有字符串 label、整数 count 和无参整数返回方法 add。
// 这些是声明与开发期类型来源；对象实例由 facet 提供，方法参数会在提供端运行时校验，结果和状态不会因此逐次验证。
export const Notes = remote("test.notes", {
	version: 1,
	params: {},
	// 地址函数忽略空参数并指向唯一 Worker()；声明里的箭头函数只是返回地址，未进行网络请求。
	hostAddress: () => Worker(),
	// method(undefined,int()) 表示调用 add(ctx)，没有业务参数，结果按合同为整数；该 schema 不在每次返回时校验结果。
	variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } },
});

/** The notes' label on the server. */
// local 表示只在同一个宿主可取得；空 params 让它具备 host 生命周期，label 是只读观察状态成员。
export const Index = local("test.index", { version: 1, params: {}, members: { label: str() } });

/** A file of a plugin read through `pluginFile`. */
// 另一个本地空参数合同，只暴露 text；读取磁盘是在 files 夹具的工厂中，本声明不执行文件 I/O。
export const Files = local("test.files", { version: 1, params: {}, members: { text: str() } });
