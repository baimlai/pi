// Names that become SQL names or stored identities in the store (decision "Restricted names"): object types, host
// kinds, tables, state definitions and jobs use npm package-name characters, lowercase, so `<host kind>:<object
// type>:<table>` is injective and readable, and a document's or a job record's name is stored as declared.

// 文件导读
// 所属模块：packages/chord/src/contracts，受限名称策略。
// 解决的问题：对象类型、host 种类、表、状态定义和 job 的名字会拼进 SQL 名或存储身份，必须限制字符集，
//   使 `<host kind>:<object type>:<table>` 这类拼接保持单射、可读且可安全引用。
// 职责边界：只校验，不做规范化、不改写名字；文档名和 job 记录名按声明原样存储，不经过这里。
// 上游：declare.ts 的 remote/local、host-kind.ts 的 hostKind 调用 checkName；下游：存储层拿到已校验的名字。
// 结果无返回值；错误以 Error 抛给声明方。
// 能力清单：
// - NAME：允许字符的正则（小写 npm 包名字符，排除冒号）。
// - checkName()：唯一的公开函数，校验非空字符串并给出带主体名的错误。
// 组合关系：所有声明入口先 checkName，再读取其余字段；存储层假定进来的名字已经满足该策略。
// 示例：
//   checkName("notes", "A contract name"); // 通过
//   checkName("Notes", "A contract name"); // 抛错：含大写字母
// 建议阅读顺序：先看 NAME 的字符集与排除冒号的原因，再看 checkName 的运行时判断。

/** Lowercase npm package-name characters: `:` cannot occur, so names joined with it stay apart. */
// 正则只匹配小写字母、数字和 @ / . _ ~ -；冒号被排除，因此用冒号拼接不同名字不会产生歧义。
const NAME = /^[a-z0-9@/._~-]+$/;

/** Throws unless `name` is a nonempty lowercase name of `[a-z0-9@/._~-]` (`what` names it in the error). */
// 用途：校验名字。输入字符串和用于错误信息的主体名，无返回值。
// 这是声明期的信任边界：TS 的 string 类型无法保证内容，JS 调用方还可能传非字符串。
// 错误路径：非字符串、空串或含非法字符时抛 Error。例子：checkName("notes", "A contract name") 通过。
export function checkName(name: string, what: string): void {
	// Declaration policy: JavaScript callers reach this check.
	if (typeof name !== "string" || !NAME.test(name)) {
		throw new Error(`${what} ${JSON.stringify(name)}: expected lowercase [a-z0-9@/._~-]`);
	}
}
