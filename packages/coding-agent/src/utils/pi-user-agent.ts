// 让 Pi 自己的目录检查、下载等管理请求沿用 pi-ai 的 User-Agent 格式，避免各处自己拼出不一致字符串。
import { formatUserAgent } from "@earendil-works/pi-ai";

/** pi's `User-Agent` for its own network requests; the same detailed form pi-ai sends to providers. */
/** 用指定版本生成管理请求的详细 User-Agent；例：getPiUserAgent(VERSION)，只返回字符串，不发送网络请求。 */
export function getPiUserAgent(version: string): string {
	// 对象字面量选择 detailed 策略；version 属性简写等价于 version: version，完整格式由共享函数决定。
	return formatUserAgent({ userAgent: "detailed", version });
}
