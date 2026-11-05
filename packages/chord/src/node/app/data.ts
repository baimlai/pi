// A host's data on its worker (decision "App kit naming and export"): the kit's object a running worker serves, through
// which the server exports the worker's data without stopping it. The worker packs its own open store (its export holds
// the commit queue while it reads: one consistent point) and its finished files into the archive at the path the server
// names. Only the server may ask (its principal); the worker's plugins never see it.

// 所属：packages/chord/src/node/app，app kit 的 worker 数据导出契约（decision 'App kit naming and export'）。
// 职责边界：定义 HostData 远程契约和 hostDataFacet，只允许服务器 principal 请求 worker 打包自己的 store/files；不负责选择导出时机或目标路径。
// 上游：app.ts 的 exportData 在 worker 运行时通过 host.get(HostData, ...) 调用；下游：packStore 写归档，canonicalJson 比较身份。
// 结果与错误：exportTo 成功返回 null，打包错误向调用方传播；非服务器身份在对象创建时得到 forbidden。
// 能力清单：HostData 是远程契约（参数 address、方法 exportTo）；addressParam 把地址序列化成参数文本；hostDataFacet 构造授权 facet。
// 组合顺序：addressParam(address) → host.get(HostData) → exportTo({ path, manifest }) → packStore。
// 示例：const data = await app.host.get(HostData, { address: addressParam(addr) }, ctx); await data.exportTo({ path: '/tmp/a.tar', manifest: JSON.stringify(m) }, ctx)。
// 建议阅读顺序：先看 HostData 与方法签名，再看 addressParam，最后看 hostDataFacet 的身份比较。
import { BACKGROUND_CONTEXT } from "../../context/index.ts";
import { type Address, method, obj, remote, str } from "../../contracts/index.ts";
import { ChordError, type Principal } from "../../data/index.ts";
import { canonicalJson } from "../../data/principal.ts";
import { defineFacet, type Facet } from "../../host/index.ts";
import type { JsonValue } from "../../json.ts";
import type { Store } from "../../store/index.ts";
import { type ArchiveManifest, packStore } from "./archive.ts";

/** The data of the worker at `address` (its JSON, as `addressParam` writes it): `exportTo` packs it at `path`. */
// 这是 worker 提供给服务器的远程契约，address 参数是地址 JSON 文本；exportTo 没声明结果 schema，成功返回 null。
export const HostData = remote("chord.app.data", {
	version: 1,
	params: { address: str() },
	// The address a worker has: the server names it (`addressParam`); only its kind and params place the object.
	// 将地址参数解析为目标地址；as Address 只做静态断言，JSON.parse 仍可能抛错，不会验证整个 Address 形状。
	hostAddress: ({ address }) => JSON.parse(address) as Address,
	variants: { main: { methods: { exportTo: method(obj({ path: str(), manifest: str() })) } } },
});

/** `address` as `HostData`'s param. */
// 将 Address 的 kind/params/key 写成 JSON 字符串，供 HostData 参数传输；例如相同地址可据此定位 worker。
// 返回文本，无 I/O；不把地址对象的其他可能属性带入。
export function addressParam(address: Address): string {
	// 对象属性简写重建指定三字段，再进行 JSON 序列化。
	return JSON.stringify({ kind: address.kind, params: address.params, key: address.key });
}

/**
 * The kit's worker facet serving `HostData` for the worker's open `store` and its files directory `files`, to `server`
 * (the server's principal) only.
 */
// 创建仅服务器身份可用的导出 facet，持有打开的 store 和 files 路径，返回 Facet<P>。
// 例如服务器请求 exportTo({path,manifest},ctx)，worker 在自己进程读一致的 store 导出；不会先停 worker。
// 身份不符在工厂中抛 forbidden；打包的磁盘/取消错误由 exportTo 向调用方传播。
export function hostDataFacet<P extends Principal>(store: Store, files: string, server: P): Facet<P> {
	// canonicalJson 对字段排序得到稳定身份文本；BACKGROUND_CONTEXT 为本次计算提供遥测上下文，不表示用户请求。
	const serverKey = canonicalJson(server as JsonValue, BACKGROUND_CONTEXT);
	// 闭包保留 store/files/serverKey，加载时只声明 HostData 的服务工厂。
	return defineFacet<P>((host) =>
		// 远程工厂接收经链路确认的 principal；没有使用参数地址来决定权限。
		host.serve(HostData, (_params, principal) => {
			// 用规范 JSON 比较完整服务器身份，避免对象键插入顺序影响比较；这是授权规则，不是只看 kind。
			if (canonicalJson(principal as JsonValue, BACKGROUND_CONTEXT) !== serverKey) {
				// 身份不符使对象创建失败，拒绝本机任意路径导出能力。
				throw new ChordError({ code: "forbidden", message: "chord.app.data: the server's only" });
			}
			return {
				// 返回契约声明的 main 变体及它的方法成员。
				variant: "main",
				members: {
					// 方法先按清单文本打包到 path，再返回 null；示例中的 path 来自已授权服务器，并非任意客户端直传。
					exportTo: async ({ path, manifest }, ctx) => {
						// The server's own manifest for this address.
						// JSON.parse 解析服务器清单，as 仅静态断言；packStore 读取已打开 store 与完成文件并写归档。
						await packStore(store, files, JSON.parse(manifest) as ArchiveManifest, path, ctx);
						// 未提供结果 schema 的方法以 null 表示成功，只有打包完成才返回。
						return null;
					},
				},
			};
		}),
	);
}
