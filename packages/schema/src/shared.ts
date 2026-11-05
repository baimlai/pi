/**
 * 同一正则源码在多个编译schema间共享RegExp，避免重复编译；缓存值只保留弱引用。
 * compiled check持有正则时它仍活着；没有使用者后可由宿主GC回收，FinalizationRegistry稍后尽力清除字符串键。
 * 弱引用不保证立即回收/立即清表，也不是按时间过期；本模块不读取文件或访问网络。
 */
// Regular expressions shared across all compiled schemas while one still uses them: tool schemas repeat a few
// patterns many times, and a RegExp is large once it has run. The cache holds its values weakly and drops an entry
// once its RegExp is collected, so it keeps nothing alive.

/**
 * The regular expression of a `pattern` source, shared by source. Patterns are ECMAScript regular expressions with
 * the `u` flag; a source that is invalid with it (some older schemas escape characters `u` rejects) compiles
 * without it.
 */
/** 按完全相同的source字符串复用存活RegExp；例两份pattern="^a"共享同一对象。先尝试u标志，失败再无标志编译；两次都失败会抛SyntaxError，不缓存坏结果。 */
export function sharedRegex(source: string): RegExp {
	// ?.在没有缓存时跳过deref；有弱引用但目标已回收也得到undefined。
	const hit = regexes.get(source)?.deref();
	// 命中直接返回同一个可变RegExp，不克隆、不更新缓存顺序。
	if (hit !== undefined) return hit;
	// 先声明，下面两个编译分支均赋值。
	let re: RegExp;
	// u模式按Unicode正则语义解析，也拒绝部分旧式转义。
	try {
		// 不加g/y，正常test调用不会因全局lastIndex影响后续验证。
		re = new RegExp(source, "u");
	} catch {
		// 为旧schema回退普通正则；此处再次抛错不被同一个catch吞掉。
		re = new RegExp(source);
	}
	// Map键强持有source，值只弱引用re；不让缓存单独延长正则寿命。
	regexes.set(source, new WeakRef(re));
	// heldValue只保存字符串，不保存re本身，避免清理注册反而强留目标。
	regexCleanup.register(re, source);
	// 编译器返回的check闭包会在需要时强持有它，保证正常校验可继续用。
	return re;
}

// 模块级共享表：完全相同源码才算一项，不规范化等价正则。
const regexes = new Map<string, WeakRef<RegExp>>();

// 目标被GC后回调可能晚到；同source期间若重建了新RegExp，不能误删仍活的新项。
const regexCleanup = new FinalizationRegistry<string>((source) => {
	// 再查当前Map条目的弱目标，只在当前目标也不可取时删键；不假定注册时那项仍是当前项。
	if (regexes.get(source)?.deref() === undefined) regexes.delete(source);
});

/** The number of cached regular expressions (for tests). */
/** 返回当前Map条目数，供GC测试观察；不主动触发GC，也不是精确的“还活着正则数”，清理回调可能尚未运行。 */
export function sharedRegexCount(): number {
	// 包含尚未完成清理的死弱引用项，读取不遍历或清理它们。
	return regexes.size;
}
