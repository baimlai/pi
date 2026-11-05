// 给 OpenAI/Mistral 等适配中的长标识生成短字符串；是快速确定性散列，不是密码学安全摘要。
/** Fast deterministic hash to shorten long strings */
// 用途：将字符串稳定映射成短散列。输入相同总得到相同结果，但可能碰撞；例对很长的工具 id 求短表示，不适合存密码或证明文件未被篡改。
export function shortHash(str: string): string {
	// 第一个 32 位混合状态，0x 前缀表示十六进制数。
	let h1 = 0xdeadbeef;
	// 第二个混合状态，采用不同初值减少结果之间的简单关系。
	let h2 = 0x41c6ce57;
	// 逐个 UTF-16 码元处理字符串；i 是从 0 开始的数组式位置。
	for (let i = 0; i < str.length; i++) {
		// 读取该位置的数值码元；这并非按完整 Unicode 码点遍历。
		const ch = str.charCodeAt(i);
		// ^ 是按位异或，Math.imul 做低 32 位整数乘法，把当前字符混进第一个状态。
		h1 = Math.imul(h1 ^ ch, 2654435761);
		// 使用另一乘数混进第二状态，避免仅复制第一个状态的变化。
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	// 再混合状态高低位；>>> 是无符号右移，这一步也交叉使用另一状态。
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	// 第二状态继续混合，这里用到的是上一行更新后的 h1。
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	// >>>0 转成无符号 32 位数，toString(36) 用数字与字母编码，再拼成最终短字符串。
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
