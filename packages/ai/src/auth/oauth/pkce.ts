// OAuth授权码流程共用PKCE材料生成器，依赖全局Web Crypto和btoa；调用方负责将两份值送到对应步骤。
/**
 * PKCE utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */

/**
 * Encode bytes as base64url string.
 */
/**
 * 把输入字节编码成URL安全的Base64文字，返回新字符串，无网络/存储操作。
 * 逐字节先构造btoa需要的二进制字符串，再替换+/并去掉填充；例：可作为OAuth verifier或SHA-256摘要的传输表示，不是加密。
 */
function base64urlEncode(bytes: Uint8Array): string {
	// let累加二进制字符，每个字符码对应一个输入字节。
	let binary = "";
	// for...of遍历Uint8Array中的数值，不是遍历UTF-8文本字符。
	for (const byte of bytes) {
		// 按0..255字节生成单字符，组成btoa可接收的二进制表示。
		binary += String.fromCharCode(byte);
	}
	// btoa生成Base64，正则全局换+/为-_并去掉=填充，得到base64url；输入字节不变。
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
/**
 * 生成一次PKCE verifier及对应S256 challenge，返回对象Promise，使用Web Crypto随机数与摘要。
 * 32随机字节→base64url verifier→UTF-8编码→SHA-256→base64url challenge；例：授权URL发送challenge，兑换授权码时提交同一次verifier。
 * 只生成配对材料，不保存、不发HTTP；crypto/btoa能力缺失或摘要失败仍会抛错/拒绝，必须由flow保留配对关系。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	// 创建32字节容器，初始为零，下一行用随机数据填充。
	const verifierBytes = new Uint8Array(32);
	// 加密随机数就地填进容器，不是Math.random，也不在此保证授权服务器接受这次请求。
	crypto.getRandomValues(verifierBytes);
	// 随机字节编码为verifier；这是以后兑换需要保留的原秘密材料。
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	// TextEncoder把verifier字符串按UTF-8转成摘要输入。
	const encoder = new TextEncoder();
	// 这里摘要的是编码后的verifier文字，不是最初32随机字节本身。
	const data = encoder.encode(verifier);
	// await Web Crypto SHA-256，得到ArrayBuffer摘要。
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	// 视图包装摘要字节再base64url编码，得到URL发送的challenge。
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	// 属性简写返回同次配对，不把verifier写环境变量或磁盘。
	return { verifier, challenge };
}
