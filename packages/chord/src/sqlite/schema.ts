// 检查会被直接拼进 SQL 标识符的名字，避免把任意 SQL 当成表名前缀。
// 文件导读
// 所属包与模块：packages/chord/src/sqlite 的标识符策略模块，服务迁移表名等被拼接的 SQL 名称。
// 职责边界：只做字符串规则检查，不访问数据库、不转义/引用标识符；调用方必须先检查再拼接。
// 上游：applySqliteMigrations 与 store 层在建表/查询前调用；下游：合法名称被直接插入模板字符串。
// 结果与错误流向：合法返回 void；非法抛普通 Error（含实际输入），由调用方中止建库流程。
// 能力清单：
// - validateSqliteSchemaPrefix（函数）：校验首字符为字母/下划线、后续为字母数字下划线，且不以 sqlite_ 开头。
// 组合关系与典型调用顺序：读取配置里的表名 -> validateSqliteSchemaPrefix -> 拼进 SQL -> 执行。
// 示例（真实签名）：validateSqliteSchemaPrefix("trace_data"); // 通过
// validateSqliteSchemaPrefix("a-b"); // 抛 Error，不会执行任何 SQL
// 建议阅读顺序：先看函数体的两个正则/前缀规则，再回到迁移器看调用位置。

/** Validate a prefix before using it as part of a SQLite identifier. */
// 输入前缀，合法时返回 void，不访问数据库；非法时抛错。例如 "trace_data" 可用，"a-b" 不可用。
// 这是标识符命名策略的运行时检查；TypeScript 的 string 无法表达这个字符限制。
export function validateSqliteSchemaPrefix(prefix: string): void {
	// 首字符只允许英文字母或下划线，其后允许数字；^ 和 $ 要求整个字符串都符合。
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
		// JSON.stringify 把换行等字符转义进报错，便于看清实际输入。
		throw new Error(`Invalid SQLite schema prefix ${JSON.stringify(prefix)}`);
	}
	// SQLite 保留 sqlite_ 开头的标识符；大小写变体也拒绝。
	if (prefix.toLowerCase().startsWith("sqlite_")) {
		throw new Error(`SQLite schema prefix ${JSON.stringify(prefix)} is reserved`);
	}
}
