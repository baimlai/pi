// coding-agent的Radius标识/网关入口；复用AI配置的轻量文字规范化，读环境但不联网/登录。
// normalize对未以http(s)://开头的值补https://，再去末尾斜杠，不做URL解析/可信端点验证。
import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";

// 内置Radius提供商ID，用于认证/模型配置查找，不是完整服务地址。
export const RADIUS_PROVIDER_ID = "radius";
// 网关覆盖环境变量的键名常量，后面用方括号动态读该键。
export const ENV_RADIUS_GATEWAY = "PI_RADIUS_GATEWAY";
/** MCP endpoint of the gateway the built-in Radius provider signs in to. */
// 模块求值时按固定DEFAULT网关拼/mcp；不读取PI_RADIUS_GATEWAY，之后改环境也不重算此常量。
export const RADIUS_MCP_URL = `${normalizeRadiusGatewayUrl(DEFAULT_RADIUS_GATEWAY)}/mcp`;

/** Radius gateway origin, honoring the `PI_RADIUS_GATEWAY` override. */
// 获取当前网关文字，返回补协议/去尾斜杠结果，无网络；例PI_RADIUS_GATEWAY="example.test/"→https://example.test。
// 每次动态读env，??只对未设置回退默认，空串也会送规范化；这与上面固定RADIUS_MCP_URL是两条规则。
export function getRadiusGatewayUrl(): string {
	// 索引取env值再选择默认；规范化不trim空格，不检验主机存在/HTTPS可信。
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
