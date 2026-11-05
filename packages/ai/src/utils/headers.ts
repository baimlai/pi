// HTTP/Provider 请求头适配；把浏览器 Headers 或多层带删除标记的配置，变成网络适配器使用的普通对象。
// ProviderHeaders 允许值为 null；null 的含义是删除前面来源的同名请求头。
import type { ProviderHeaders } from "../types.ts";

// 用途：Headers 转普通对象。输入标准 Headers，输出字符串键值表；例 Headers({"X-Test":"a"}) 可转成供扩展观察的对象；不修改输入。
export function headersToRecord(headers: Headers): Record<string, string> {
	// Record<K,V> 表示每个字符串键对应一个字符串值；先创建空对象。
	const result: Record<string, string> = {};
	// 遍历键值对并数组解构，Headers 自身处理了标准请求头名称规则。
	for (const [key, value] of headers.entries()) {
		// 用动态键写进普通对象；方括号取变量值作属性名。
		result[key] = value;
	}
	// 返回转换后的独立对象。
	return result;
}

// 用途：按来源顺序合并请求头，后面覆盖前面，同名忽略大小写。例 [{X:A}, {x:null}] 最终删除 X；结果为空则返回 undefined。
export function providerHeadersToRecord(
	// 剩余参数 ... 接收任意多个来源；每项允许没提供。
	...headerSources: (ProviderHeaders | undefined)[]
): Record<string, string> | undefined {
	// Map 的键保存小写名称用于比较；值是“保留原拼写的名称、值”二元组。
	const merged = new Map<string, [string, string]>();
	// 按传入顺序处理，形成“默认 → 模型 → 本次请求”等覆盖关系。
	for (const source of headerSources) {
		// 缺失来源当空对象；entries 转为键值对再解构。
		for (const [name, value] of Object.entries(source ?? {})) {
			// 请求头大小写不敏感，因此 X-Test 与 x-test 应视为同一项。
			const normalizedName = name.toLowerCase();
			// 先移除旧值；若新值是 null 就仅删除，不再放回。
			merged.delete(normalizedName);
			// 非 null 才保存新值，并保留最新来源提供的名称拼写。
			if (value !== null) merged.set(normalizedName, [name, value]);
		}
	}
	// 有头时把二元组转成对象；没有头时返回 undefined，让上层采用“未提供”语义。
	return merged.size > 0 ? Object.fromEntries(merged.values()) : undefined;
}
