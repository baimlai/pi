// 验证组合补全提供者如何识别路径边界、调用 fd 查附件，并把候选替换回输入。测试使用真实临时目录，不创建编辑器或实际终端。
// 前四例可能枚举真实根目录并输出结果；fd 分组在 PATH 找不到 fd 时跳过，其余路径分组各自创建并清理临时树。
// 导入 Node 断言对象：ok 检查真值，strictEqual 比较单值，deepStrictEqual 比较数组/对象结构；失败会抛出并让用例失败。
import assert from "node:assert";
// 导入同步子进程 API，仅用于启动 which/where 定位 fd；补全实现自己的 fd 查询则使用异步 spawn。
import { spawnSync } from "node:child_process";
// 导入真实文件系统操作：建立目录/随机临时根、递归删除、建立链接和写入夹具内容；没有把这些操作 mock 掉。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
// tmpdir 返回当前系统临时目录，下面在其下创建本测试独有的随机子目录。
import { tmpdir } from "node:os";
// dirname 提取父目录，join 按本机路径规则拼接；它们只处理字符串，不保证路径存在。
import { dirname, join } from "node:path";
// Node 测试框架注册测试与前后钩子；it/test 在这里都声明用例，async 回调的 Promise 会被等待。
import { afterEach, beforeEach, describe, it, test } from "node:test";
// 直接加载源码中的真实提供者，验证对外 getSuggestions/applyCompletion，而非访问其 private 边界解析方法。
import { CombinedAutocompleteProvider } from "../src/autocomplete.ts";

// 按当前平台查找 fd，返回首条定位结果或 null；同步等待定位程序结束，不下载或安装程序。
// 例：which fd 成功输出一条路径便取它；失败/没有输出视作不可用，成功定位并不保证之后 fd 一定能执行。
const resolveFdPath = (): string | null => {
	// 三元表达式在 Windows 选 where，其余平台选 which；command 是程序名而非一整条 shell 命令。
	const command = process.platform === "win32" ? "where" : "which";
	// 以独立参数 fd 执行定位程序；encoding 让 stdout 按本机 Node 类型成为字符串，默认不经 shell 展开。
	const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
	// 非零退出码、启动失败时的 null 状态，或空输出，都走不可用分支；没有单独向上抛出 result.error。
	if (result.status !== 0 || !result.stdout) {
		// 返回联合类型中的 null，调用者据此跳过 fd 分组。
		return null;
	}

	// 正则按 LF 或 CRLF 拆行，find(Boolean) 取第一条非空字符串；这不是遍历所有候选验证可执行性。
	const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
	// 有首行就去两端空白返回；否则返回 null，三元两支共同满足 string | null。
	return firstLine ? firstLine.trim() : null;
};

// 夹具结构只在编译期限制字段形状，不是磁盘扫描结果或运行时路径校验器。
type FolderStructure = {
	// 可选 dirs 是相对目录名数组；? 表示调用者可不提供，下面会用空数组。
	dirs?: string[];
	// 可选 files 用 Record 把文件路径映射到正文字符串，例如 src/a.ts → export {};。
	files?: Record<string, string>;
};

// 把声明的目录/文件写入 baseDir，返回 void；先建目录，再为每个文件补齐父目录并同步写入，I/O 异常直接抛出。
// 例：files 中的 src/a.ts 会创建 src 后写正文。这里接收可信测试夹具，未阻止 ../ 等路径；不是通用的目录隔离 API。
const setupFolder = (baseDir: string, structure: FolderStructure = {}): void => {
	// ?? 仅在 dirs 是 null/undefined 时回退空数组，不会把正常空数组视作缺失。
	const dirs = structure.dirs ?? [];
	// 未提供 files 就用空对象，后续 Object.entries 因而不产生文件写入。
	const files = structure.files ?? {};

	// forEach 对每个目录名执行同步回调；回调只负责建目录，不生成返回列表。
	dirs.forEach((dir) => {
		// 把目录名拼到基路径并递归建父目录；已存在的目录可复用，权限等错误仍可抛出。
		mkdirSync(join(baseDir, dir), { recursive: true });
	});
	// Object.entries 将映射拆成键值对；参数解构直接得到 filePath 与 contents，回调逐个写文件。
	Object.entries(files).forEach(([filePath, contents]) => {
		// 求当前夹具文件的完整访问路径，尚未打开文件。
		const fullPath = join(baseDir, filePath);
		// 先确保该文件的父目录存在，支持多层相对文件名。
		mkdirSync(dirname(fullPath), { recursive: true });
		// 同步创建/覆盖正文；夹具里的 TypeScript 或 shebang 都是文本，不在这里执行。
		writeFileSync(fullPath, contents);
	});
};

// 模块加载时立即执行一次定位，即使用名字过滤跳过全部 fd 用例，也仍会运行这个 which/where。
const fdPath = resolveFdPath();
// Boolean 把定位结果转成分组 skip 的布尔开关；不是检查 fd 的版本或搜索能力。
const isFdInstalled = Boolean(fdPath);

// 要求已经定位到 fd，成功返回路径、否则抛错；仅由 fd 测试的运行回调使用。
// 例如缺 fd 时分组通常先被 skip；若绕过该条件调用本函数，会得到明确错误，而非安装 fd。
const requireFdPath = (): string => {
	// 对模块保存的路径作真值检查，null 或空串均不可继续。
	if (!fdPath) {
		// 抛出的 Error 让错误调用失败；后续 return 不会执行。
		throw new Error("fd is not available");
	}
	// 在此分支 TypeScript 已收窄为 string，直接返回原路径。
	return fdPath;
};

// 测试查询包装器，输入提供者、整行文本、UTF-16 行内光标和可选 force，直接返回真实查询的 Promise。
// 每次创建新且未触发取消的 signal；例：force=true 模拟请求强制文件补全，但没有模拟 Tab 按键或编辑器界面。
const getSuggestions = (
	// 参数必须是组合提供者实例，本包装器不构造它。
	provider: CombinedAutocompleteProvider,
	// lines 是编辑文本的行数组，多数用例只传一行。
	lines: string[],
	// cursorLine 是零起始行号，这些用例都在第 0 行。
	cursorLine: number,
	// cursorCol 按 JavaScript 字符串 UTF-16 下标计算，不是终端显示列或 Unicode 字符数。
	cursorCol: number,
	// 可选调用位置参数默认 false；非 @ 场景下，true 会让实现绕过斜杠命令分支并强制取普通路径前缀，@ 查询仍优先。
	force: boolean = false,
	// 表达式箭头直接返回 getSuggestions 的 Promise；对象简写 force 传布尔值，新 AbortController 的 signal 从未被本测试 abort。
) => provider.getSuggestions(lines, cursorLine, cursorCol, { signal: new AbortController().signal, force });

// 组织真实组合提供者的几组回归；describe 回调注册子测试，本身不执行用户命令或渲染菜单。
describe("CombinedAutocompleteProvider", () => {
	// 这四例通过公开查询间接观察前缀，硬编码 /tmp 并可能枚举真实根目录；其中日志和环境依赖应与临时树用例分开理解。
	describe("extractPathPrefix", () => {
		// 输入 hey / 且强制补全，要求有候选并且替换前缀为 /；候选来自真实根目录，空目录/访问失败会影响结果。
		it("extracts / from 'hey /' when forced", async () => {
			// 用 /tmp 作基目录但不传 fd；绝对 / 查询会绕过该基路径。
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			// 一行中前面是正文，末尾 / 才是路径查询。
			const lines = ["hey /"];
			// 选择第一行。
			const cursorLine = 0;
			// 5 是末尾 / 后的 UTF-16 插入点，保留原英文定位说明。
			const cursorCol = 5; // After the "/"

			// 等待真实目录扫描，true 请求强制路径补全，不是单独测试一个纯解析函数。
			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			// notEqual 先要求结果不是 null；若真实根没有候选，此断言会失败。
			assert.notEqual(result, null, "Should return suggestions for root directory");
			// 有结果时才读取字段，if 同时让 TS 收窄可空类型。
			if (result) {
				// 严格比较替换区间只含 /，未把前文 hey 和空格吞进去。
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});

		// 输入 /A 并强制补全，若真实根有 A 开头候选就检查前缀；允许 null，因此不保证此例一定验证到 prefix。
		it("extracts /A from '/A' when forced", async () => {
			// 同样不传 fd，走普通目录读取。
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			// 查询根目录中名字以 A 开头的条目，前缀为 /A。
			const lines = ["/A"];
			// 使用第 0 行。
			const cursorLine = 0;
			// 光标放在 A 后，长度 2。
			const cursorCol = 2; // After the "A"

			// 强制查询会读取根目录并按 A 开头过滤名字。
			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			// 把真实查询结果写到测试标准输出，可能包含本机目录名称。
			console.log("Result:", result);
			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			// 只有拿到建议才继续断言；null 情况下这一分支没有断言。
			if (result) {
				// 仅证明有结果时保留 /A 原前缀，不要求具体候选名称。
				assert.strictEqual(result.prefix, "/A", "Prefix should be '/A'");
			}
		});

		// 此例虽按命令命名，实际传 force=true：实现会把 /model 当绝对路径名字过滤；预期 null 依赖根下没有匹配项，并非验证自然命令分支。
		it("does not trigger for slash commands", async () => {
			// 空命令列表和 /tmp 基目录不阻止 force 访问绝对根路径。
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			// 待补文字为 /model。
			const lines = ["/model"];
			// 仍使用单行输入。
			const cursorLine = 0;
			// 6 将光标置于 model 后。
			const cursorCol = 6; // After "model"

			// 强制请求绕过正常斜杠命令识别，因此测试名称不能替代实际调用语义。
			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			// 记录结果到标准输出。
			console.log("Result:", result);
			// 精确要求 null；没有断言命令列表、命令执行或解析分支被调用。
			assert.strictEqual(result, null, "Should not trigger for slash commands");
		});

		// 在 /command 后正文位置输入绝对 /，要求得到根目录候选且前缀只包含末尾 /；不执行 /command。
		it("triggers for absolute paths after slash command argument", async () => {
			// 创建无命令回调、无 fd 的提供者。
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			// 行首命令样式文字后留一空格，再输入根斜杠。
			const lines = ["/command /"];
			// 查询第 0 行。
			const cursorLine = 0;
			// 10 位于第二个 / 后，不会把整行都当成替换前缀。
			const cursorCol = 10; // After the second "/"

			// force=true 要求普通路径补全，可能读取真实根目录。
			const result = await getSuggestions(provider, lines, cursorLine, cursorCol, true);

			// 输出目录查询结果，不是用户命令执行结果。
			console.log("Result:", result);
			// 先要求实际存在非空候选结果。
			assert.notEqual(result, null, "Should trigger for absolute paths in command arguments");
			// 有结果后进入可读取 prefix 的分支。
			if (result) {
				// 只检查 prefix 为 /，没有在本例应用替换。
				assert.strictEqual(result.prefix, "/", "Prefix should be '/'");
			}
		});
	});

	// fd 附件补全组：未定位到 fd 时整组既有 skip；可执行时每例在随机根的 cwd/outside 自建树中跑真实本地 fd，不验证网络或模型。
	describe("fd @ file suggestions", { skip: !isFdInstalled }, () => {
		// 保存每例独有的共同临时根，以便统一清理 cwd 和 outside。
		let rootDir = "";
		// 提供者使用的基目录，注意不是 process.chdir 修改进程工作目录。
		let baseDir = "";
		// 基目录旁的测试目录，供 ../ 与软链接检查；它也仍属于同一自建临时根。
		let outsideDir = "";

		// 每个 fd 叶用例运行前建立隔离夹具位置；回调同步建树，失败会由测试框架报告。
		beforeEach(() => {
			// mkdtempSync 在系统临时目录下创建带随机后缀的根，返回实际路径。
			rootDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-root-"));
			// 计算模拟项目目录的路径，不修改全局 cwd。
			baseDir = join(rootDir, "cwd");
			// 计算兄弟目录，后面的 ../outside 指向这里。
			outsideDir = join(rootDir, "outside");
			// 创建模拟基目录。
			mkdirSync(baseDir, { recursive: true });
			// 创建兄弟目录，允许后面的范围查找与链接指向它。
			mkdirSync(outsideDir, { recursive: true });
		});

		// 每例后同步清理共同根，覆盖两个目录与链接本身；清理错误可使测试失败，force 只忽略不存在等既定情形。
		afterEach(() => {
			// 递归移除自建根；force=true 不表示吞掉全部权限/I/O 异常，也不是每条操作都包独立 finally。
			rmSync(rootDir, { recursive: true, force: true });
		});

		// 空 @ 查询应该列出 src/ 与 README.md 两项；创建真实临时文件、等待 fd，并忽略两项之间的排序差异后比较集合内容。
		test("returns all files and folders for empty @ query", async () => {
			// 把本例的两项文件树交给同步夹具构造器。
			setupFolder(baseDir, {
				// 目录项 src 用来验证目录候选带末尾 /。
				dirs: ["src"],
				// files 中键是相对文件名，值为无执行用途的正文。
				files: {
					// 建立一个 README.md，补全仅依赖名称而非 readme 内容。
					"README.md": "readme",
				},
			});

			// 把已经定位的 fd 传给真实提供者；构造只保存配置，此刻还未启动搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 只有 @ 也表示有效的空附件查询。
			const line = "@";
			// 光标在行末，await 等待 fd 子进程和候选整理完成。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 可选链允许 null 结果变 undefined；map 只提写回值，再原地排序这个新数组以排除返回顺序影响。
			const values = result?.items.map((item) => item.value).sort();
			// 深严格比较恰好两项，缺项/多项/无结果都会失败。
			assert.deepStrictEqual(values, ["@README.md", "@src/"].sort());
		});

		// 逐个检查 CJK 标点/全角空格后的 @REA，在普通和强制请求下都只替换附件前缀；应用后保留前文并为附件文件加空格。
		test("recognizes @ after CJK punctuation without consuming the preceding text", async () => {
			// 唯一 README 夹具保证准确知道本例候选内容。
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			// 提供者读取本例临时基目录，复用于下面所有边界组合。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 数组同时包含整段正文、全角空格和展开后的逐个标点；字符串 ... 按 Unicode 码点迭代，不按 UTF-16 半个代理项拆分。
			for (const before of ["查看，", "\u3000", ..."，．：；！？（）［］｛｝“”‘’…—。、「」『』《》【】"]) {
				// 内层循环覆盖自然请求与强制请求，两者的 @ 分支都优先于普通路径。
				for (const force of [false, true]) {
					// 模板组合正文与 @REA，正文不属于应替换的 prefix。
					const line = `${before}@REA`;
					// 用完整 UTF-16 行长定位末尾，把当前 force 值传入真实查询。
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					// 要求建议存在，并把当前输入附在断言错误中便于定位组合。
					assert.ok(result, line);
					// 要求前缀恰好 @REA，不包含前面的标点/正文。
					assert.strictEqual(result.prefix, "@REA");
					// 严格比较返回值列表，不仅检查包含某一项。
					assert.deepStrictEqual(
						// map 回调只读取每个候选用于写回的 value。
						result.items.map((item) => item.value),
						// 预期只有 README.md 这一个附件值。
						["@README.md"],
					);
					// 选中首项应用替换；! 是 TypeScript 非空断言，不增加运行时检查，前面的断言给出了测试前提。
					const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
					// 文件附件后增加一个空格，前面的 before 原样保留。
					assert.strictEqual(applied.lines[0], `${before}@README.md `);
					// 新光标位于新行末尾，!.length 仍按 UTF-16 计，不是终端格数。
					assert.strictEqual(applied.cursorCol, applied.lines[0]!.length);
				}
			}
		});

		// 检查未闭开括号/反引号后的 @ 可作为新 token；再用 foo(@REA 反例验证不能随意剥掉嵌在词内部的括号。
		test("recognizes @ after opening wrappers like ( and backticks", async () => {
			// 建立唯一匹配文件。
			setupFolder(baseDir, { files: { "README.md": "readme" } });
			// 保存同一个临时目录提供者供多种开包装符查询。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 遍历开包装符，以及带前文空格的 see ( 组合。
			for (const before of ["(", "see (", "[", "`", "<", "{"]) {
				// 把 @REA 接到当前包装前缀后。
				const line = `${before}@REA`;
				// 使用默认 force=false，证明这些边界在自然附件查询中也被识别。
				const result = await getSuggestions(provider, [line], 0, line.length);
				// 要求每种边界都给出建议。
				assert.ok(result, line);
				// 包装符应留在正文中，不成为附件替换前缀。
				assert.strictEqual(result.prefix, "@REA");
				// 应用首项到原文；此处不启动 Editor 或模拟按键。
				const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
				// 期望保留 before 并插入文件附件及尾空格。
				assert.strictEqual(applied.lines[0], `${before}@README.md `);
			}
			// 构造括号嵌在 ASCII 词内部的反例。
			const embedded = "foo(@REA";
			// 这类输入应无自然补全；该反例限制“剥包装符”的适用边界。
			assert.strictEqual(await getSuggestions(provider, [embedded], 0, embedded.length), null);
		});

		// 中文目录名及目录内部的 @ 都应保留，分别检查无正文与中文标点前文，不把内部 @ 当新的附件起点。
		test("preserves CJK characters and embedded @ in attachment paths", async () => {
			// 建立两个相似中文目录，防止结果串错目录。
			setupFolder(baseDir, {
				// 第二个路径名称自带 @；正文 backup/text 不参与匹配。
				files: { "文档/说明.md": "text", "文档@备份/说明.md": "backup" },
			});
			// 提供者对两个目录都可见，结果应由当前路径前缀限定。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 同时检查行首附件与正文标点后的附件。
			for (const before of ["", "查看，"]) {
				// 遍历正常中文目录和带嵌入 @ 的目录。
				for (const directory of ["文档", "文档@备份"]) {
					// 附件前缀以 @ 开始，但保留其后目录名的全部字符。
					const prefix = `@${directory}/说`;
					// 在原前缀前接可选正文。
					const line = before + prefix;
					// 真实查询可把已存在的目录部分用作 fd 范围。
					const result = await getSuggestions(provider, [line], 0, line.length);
					// 当前组合必须得到候选。
					assert.ok(result, line);
					// 返回 prefix 要与整个附件查询一致。
					assert.strictEqual(result.prefix, prefix);
					// 严格比较当前目录内唯一匹配文件。
					assert.deepStrictEqual(
						// 提取候选写回值。
						result.items.map((item) => item.value),
						// 期望目录中的中文和 @ 全保留，没有变成绝对临时路径。
						[`@${directory}/说明.md`],
					);
				}
			}
		});

		// 已用引号包住的中文附件目录可含空白/标点；在闭引号前补完，应保留唯一闭引号和后文，并在附件文件后插入空格。
		test("completes quoted CJK attachments after prose without losing path segments or quotes", async () => {
			// 同一个提供者复用本例根，循环中逐渐加入不同名称的夹具。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 四个分隔符在引号内部应作为文件名正文，而非 token 边界。
			for (const separator of [" ", "\u3000", "，", "。"]) {
				// 把本轮分隔符嵌进目录名。
				const directory = `我的${separator}文档`;
				// 创建当前引用目录及一个容易误选的普通文档目录。
				setupFolder(baseDir, {
					// 计算属性名用模板构造路径键；第二个文件用于发现前半目录被错误丢弃的情况。
					files: { [`${directory}/说明.md`]: "text", "文档/说明.md": "not the quoted path" },
				});
				// 整行既有开闭双引号，也有查询后的后文，不是在行末补全。
				const line = `查看：@"${directory}/说"后文`;
				// indexOf 找现有闭引号的 UTF-16 下标，光标停在它前面。
				const cursorCol = line.indexOf('"后文');
				// 仅光标前缀参与查询，后文和现有闭引号需由应用阶段保留/合并。
				const result = await getSuggestions(provider, [line], 0, cursorCol);
				// 要求查询存在。
				assert.ok(result);
				// prefix 包含 @ 与开引号，不包含光标后的闭引号。
				assert.strictEqual(result.prefix, `@"${directory}/说`);
				// 期望完整写回值，不允许漏掉前半路径或多出其他目录文件。
				assert.deepStrictEqual(
					// 逐项取用于替换的字符串。
					result.items.map((item) => item.value),
					// 预期候选本身含一对引号，闭引号去重发生在 applyCompletion。
					[`@"${directory}/说明.md"`],
				);
				// 把候选应用到带后文的原行，测试真实替换逻辑。
				const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
				// 新正文只保留一个闭引号，并在附件与后文之间添加一个空格。
				assert.strictEqual(applied.lines[0], `查看：@"${directory}/说明.md" 后文`);
				// 新光标位于新附件后的空格之后，仍在原来的后文之前。
				assert.strictEqual(applied.cursorCol, `查看：@"${directory}/说明.md" `.length);
			}
		});

		// 把邮箱/各种文字中的 @ 当普通文本；覆盖列出的 ASCII、CJK、补充平面和组合字符样本，并不宣称穷尽全部 Unicode。
		test("does not interpret email addresses or @ after ASCII or CJK letters as attachment prefixes", async () => {
			// 即使磁盘里有匹配的 README 或 example.com，也不能把词内部 @ 误识别为附件边界。
			setupFolder(baseDir, { files: { "README.md": "readme", "example.com": "text" } });
			// 复用真实 fd 提供者；若前缀被正确拒绝，不应进入附件搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 包括代理对字符、组合浊点和变体选择符；转义仍是测试输入字符串，不按显示列求光标。
			for (const before of ["user", "查看", "あ", "カ", "한", "ㄅ", "𠮷", "か\u3099", "禰\u{e0100}", "々", "Ａ"]) {
				// 分别使用普通文件前缀和邮箱样式名称。
				for (const name of ["REA", "example.com"]) {
					// 在没有合法分隔符的 before 后直接接 @。
					const line = `${before}@${name}`;
					// 要求整组组合都返回 null，line 作为错误诊断消息；无 force 参数，检查自然触发语义。
					assert.strictEqual(await getSuggestions(provider, [line], 0, line.length), null, line);
				}
			}
		});

		// 完整扩展名中的点应按文件名匹配，结果至少包含 @file.txt；本例不要求列表只有这一项。
		test("matches file with extension in query", async () => {
			// 创建扩展名搜索夹具。
			setupFolder(baseDir, {
				// 声明文件映射。
				files: {
					// 普通正文无需执行，关键是名称包含 .txt。
					"file.txt": "content",
				},
			});

			// 传 fd 开启 @ 查询。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 查询含点号，不能无意把点当任意字符正则。
			const line = "@file.txt";
			// 等待 fd 和最终候选评分。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// null 结果经可选链成为 undefined，不会因读取 items 先抛 TypeError。
			const values = result?.items.map((item) => item.value);
			// includes 只验证目标存在；结果缺失也会让 assert.ok 失败。
			assert.ok(values?.includes("@file.txt"));
		});

		// #10972
		// 原 #10972 回归：方括号和括号应按字面路径搜索，不直接当 fd 正则语法；三种查询各自严格要求唯一预期值。
		test("matches regex metacharacters in queries literally", async () => {
			// 建立特殊名称及普通 index 对照文件。
			setupFolder(baseDir, {
				// 本对象的字符串键是磁盘相对路径，不是 TS 属性访问表达式。
				files: {
					// 路由样式目录下的 [id].tsx，方括号属于真实文件名。
					"pages/[id].tsx": "x",
					// 无方括号的同目录文件，可发现过宽匹配。
					"pages/index.tsx": "x",
					// 文件名带成对括号，配合 @pages/( 输入验证字面量处理。
					"pages/(group).ts": "x",
				},
			});

			// 同一提供者查询全部样例。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// for...of 每轮解构查询和预期结果，回调每次 await 一个搜索。
			for (const [line, expected] of [
				// 目录范围后以 [ 开头匹配 [id].tsx。
				["@pages/[", "@pages/[id].tsx"],
				// 目录范围后以 ( 开头匹配 (group).ts。
				["@pages/(", "@pages/(group).ts"],
				// 不带父目录的 [id 查询仍应找到嵌套文件。
				["@[id", "@pages/[id].tsx"],
				// as const 让此字面量数组在编译期成为只读、保留具体字符串类型的元组集合；不会冻结运行时对象。
			] as const) {
				// 把当前查询整串放在第 0 行末尾。
				const result = await getSuggestions(provider, [line], 0, line.length);
				// 逐例深比较全部候选值，检查没有多匹配普通 index。
				assert.deepStrictEqual(
					// 可选链保留查询失败为 undefined，由后续断言报告差异。
					result?.items.map((item) => item.value),
					// 每轮预期恰好一个值。
					[expected],
					// 把失败的查询字符串作为断言消息，方便看出是哪种元字符。
					line,
				);
			}
		});

		// 用小写 @re 找到大写 README.md，并且排除不匹配的 src 目录；证明这一固定样本的大小写处理。
		test("filters are case insensitive", async () => {
			// 创建有匹配文件及无关目录的树。
			setupFolder(baseDir, {
				// src 用作无关目录对照。
				dirs: ["src"],
				// 夹具的文件名称保留大写。
				files: {
					// 搜索和写回都应保留 README 原名称大小写。
					"README.md": "readme",
				},
			});

			// 启用真实 fd 搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 小写查询不与磁盘名称逐字大小写相同。
			const line = "@re";
			// 等待候选生成。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 提取 value 后排序；此处唯一结果时排序并不改变断言意义。
			const values = result?.items.map((item) => item.value).sort();
			// 要求恰好 @README.md 一项。
			assert.deepStrictEqual(values, ["@README.md"]);
		});

		// src 目录与 src.txt 文件都匹配 @src，要求目录第一且文件仍存在；不是说任何低分目录都压过所有文件。
		test("ranks directories before files", async () => {
			// 建立两个共享 src 前缀的候选。
			setupFolder(baseDir, {
				// 精确目录名 src 在当前评分中比前缀匹配文件更靠前。
				dirs: ["src"],
				// 另建以 src 开头的普通文件。
				files: {
					// src.txt 必须保留，不能为目录优先而被丢掉。
					"src.txt": "text",
				},
			});

			// 提供者在这一临时树中做附件搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 查询共同前缀 @src。
			const line = "@src";
			// 等待真实候选列表。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 两层可选链读取首项 value；无结果或空列表都得到 undefined。
			const firstValue = result?.items[0]?.value;
			// some 回调检查任一项是否为文件候选，不要求它一定排第二。
			const hasSrcFile = result?.items?.some((item) => item.value === "@src.txt");
			// 首项严格要求目录值及末尾 /。
			assert.strictEqual(firstValue, "@src/");
			// 同时要求 src.txt 文件没有被目录候选挤掉。
			assert.ok(hasSrcFile);
		});

		// 只用文件名 @index 查到嵌套 src/index.ts，证明 fd 递归结果的写回值保留父目录；不执行夹具源码。
		test("returns nested file paths", async () => {
			// 建立仅有嵌套文件的树，setupFolder 自动补建 src。
			setupFolder(baseDir, {
				// files 描述需要写入的相对路径。
				files: {
					// 正文是 TypeScript 风格的空导出与换行，只作普通文件内容。
					"src/index.ts": "export {};\n",
				},
			});

			// 从当前基目录启动 fd 查询。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 查询不含 src/，实现仍会在递归结果中寻找 index。
			const line = "@index";
			// 光标放行末，默认自然附件触发。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 只提取候选 value，不比较菜单 label/description。
			const values = result?.items.map((item) => item.value);
			// 要求包含完整相对路径，未限定其他候选或精确顺序。
			assert.ok(values?.includes("@src/index.ts"));
		});

		// 跨多级目录匹配 tui/src/auto，并排除 ai 同名文件；当这个目录前缀在根下不存在时实现退回 fd 的全路径匹配。
		test("matches deeply nested paths", async () => {
			// 同时建立两个末尾文件名相同的包路径。
			setupFolder(baseDir, {
				// 两项都只是夹具文件，不是读取本仓库源码。
				files: {
					// 应被 tui 路径片段匹配的文件。
					"packages/tui/src/autocomplete.ts": "export {};",
					// 只有 ai 路径片段不同，用作不能误中的对照。
					"packages/ai/src/autocomplete.ts": "export {};",
				},
			});

			// 基目录是临时 cwd，不是这个仓库的实际 packages 目录。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 省略 packages 前缀，让查询在完整相对路径中间匹配。
			const line = "@tui/src/auto";
			// 等待真实 fd 完成，返回的 value 应仍是从临时基目录起的路径。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 把结果转成写回字符串列表。
			const values = result?.items.map((item) => item.value);
			// 必须有 tui 对应的完整文件路径。
			assert.ok(values?.includes("@packages/tui/src/autocomplete.ts"));
			// 否定断言排除同名 ai 文件；和前一肯定断言一起避免空结果也通过。
			assert.ok(!values?.includes("@packages/ai/src/autocomplete.ts"));
		});

		// 查询路径中间的 components/ 应找到它下面的 Button，不能把 utils 文件也算进来；用于验证 fd --full-path 的实际结果。
		test("matches directory in middle of path with --full-path", async () => {
			// 建立两个 src 子树作正反例。
			setupFolder(baseDir, {
				// 文件正文不参与路径查询。
				files: {
					// 位于 components 下的应命中目标。
					"src/components/Button.tsx": "export {};",
					// 不含 components 片段的负例。
					"src/utils/helpers.ts": "export {};",
				},
			});

			// 基目录内没有直接的 components，因此会走全路径匹配而不是可用目录范围。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 带末斜杠的查询只写中间目录名称。
			const line = "@components/";
			// 等待 fd 搜索返回。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 取得公开 value 列表，未检查 fd 参数数组本身。
			const values = result?.items.map((item) => item.value);
			// 正例要求完整 src/components 路径。
			assert.ok(values?.includes("@src/components/Button.tsx"));
			// 负例要求无关 src/utils 路径不出现。
			assert.ok(!values?.includes("@src/utils/helpers.ts"));
		});

		// 从 cwd 用 ../outside/a 缩小到兄弟目录后递归匹配 a，保留原相对展示形式；../ 可离开 baseDir，不是权限隔离。
		test("scopes fuzzy search to relative directories and searches recursively", async () => {
			// 在共同临时根的 outside 中建树，仍由同一个 afterEach 清理。
			setupFolder(outsideDir, {
				// 声明不同深度的正例与不含 a 的负例。
				files: {
					// 较浅 alpha 正例。
					"nested/alpha.ts": "export {};",
					// 更深 also-alpha 正例，要求范围查找仍递归。
					"nested/deeper/also-alpha.ts": "export {};",
					// 同目录的 zzz 负例，不应被只按目录扫描的宽松结果带入。
					"nested/deeper/zzz.ts": "export {};",
				},
			});

			// 提供者基路径仍是 cwd，兄弟目录由查询本身选择。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 查询保留 ../outside/ 的显示前缀，并把最后的 a 用作匹配词。
			const line = "@../outside/a";
			// 实现同步检查目录范围后启动 fd；这里 await 它的最终 Promise。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 读取写回值用于断言。
			const values = result?.items.map((item) => item.value);
			// 较浅文件必须保留 ../outside/，不能改成绝对临时路径。
			assert.ok(values?.includes("@../outside/nested/alpha.ts"));
			// 更深文件也应递归进入建议。
			assert.ok(values?.includes("@../outside/nested/deeper/also-alpha.ts"));
			// 无 a 匹配的文件必须排除。
			assert.ok(!values?.includes("@../outside/nested/deeper/zzz.ts"));
		});

		// projects 与深处 profile 都按 pro 开头命中且同属目录，基础分相同；要求浅路径先排，同时保留深路径候选。
		test("ranks shallower same-score @ matches before deeper matches", async () => {
			// 本例只需目录，不创建文件正文。
			setupFolder(baseDir, {
				// 一个很深的 profile 与一个直接子目录 projects 构成相同匹配分下的深度对照。
				dirs: ["scope/aaa/venv/lib/python3.12/site-packages/pkg/core/profile", "scope/projects"],
			});

			// 真实附件提供者可用范围 scope 扫描。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 最后的 pro 同时匹配 projects 和 profile。
			const line = "@scope/pro";
			// 等待两轮 fd 查询及评分排序。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 可选结果缺失时用 []，使下面首项/包含断言报告失败，而非抛空引用错误。
			const values = result?.items.map((item) => item.value) ?? [];
			// 直接子目录必须在首位，检查深度排序的关键行为。
			assert.strictEqual(values[0], "@scope/projects/");
			// 深目录仍应出现在最终候选中，不能靠只查一层实现“浅层优先”。
			assert.ok(values.includes("@scope/aaa/venv/lib/python3.12/site-packages/pkg/core/profile/"));
		});

		// 制造 250 个深处 profile 匹配，要求直接子目录 projects 仍优先且至少保留一个深匹配；不要求全部 250 项返回。
		test("includes scoped direct children when recursive @ matches are flooded", async () => {
			// Array.from 按 length 构造压力夹具目录数组，不读取实际 Python 环境。
			const floodedDirs = Array.from(
				// 声明需要 250 个数组元素。
				{ length: 250 },
				// 映射回调忽略原元素 _，使用从 0 开始的 index 生成唯一目录名。
				(_, index) =>
					// index+1 转字符串并补成三位；每项都在自建 scope 下，末端 profile 提供相同匹配词。
					`scope/a${String(index + 1).padStart(3, "0")}/venv/lib/python3.12/site-packages/pkg/core/profile`,
			);
			// 把一个直接匹配和 250 个深匹配一起真正建到临时磁盘。
			setupFolder(baseDir, {
				// 数组展开把 floodedDirs 元素依次放入目录清单，不生成嵌套数组。
				dirs: ["scope/projects", ...floodedDirs],
			});

			// 提供者仍只扫描本例临时目录。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 在 scope 范围内查询 pro，触发直接子项查询加递归查询的合并。
			const line = "@scope/pro";
			// 等待受 fd 每次结果上限及最终前 20 项限制的真实结果。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 提取 value，空结果回退 [] 后由断言失败。
			const values = result?.items.map((item) => item.value) ?? [];
			// projects 要保住第一名，防止递归结果拥挤把直接子项淹没。
			assert.strictEqual(values[0], "@scope/projects/");
			// 另外断言仍保留深层匹配，避免只返回直接目录的实现误过测试。
			assert.ok(
				// some 只要求至少一个带 /profile/ 的结果，不统计全部深目录。
				values.some((value) => value.includes("/profile/")),
				// 此消息解释失败原因，不是额外测试逻辑。
				"Should keep deep fuzzy matches after direct children",
			);
		});

		// 附件目录名称含空白/中文标点时应自动加双引号；应用目录后光标留在闭引号内，下一次自然查询能找到其 test.txt。
		test("quotes paths containing whitespace or CJK punctuation for @ suggestions", async () => {
			// 同一个提供者复用循环逐步建立的四种目录。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 分别覆盖 ASCII 空格、全角空格、中文逗号和句号。
			for (const separator of [" ", "\u3000", "，", "。"]) {
				// 把分隔符当作目录名的一部分。
				const directory = `my${separator}folder`;
				// 在当前目录下建立唯一子文件；计算属性名在运行时展开路径。
				setupFolder(baseDir, { files: { [`${directory}/test.txt`]: "content" } });
				// 首次查询只给 @my，不主动输入引号。
				const line = "@my";
				// 等待 fd 建立可能包含多个已建目录的候选列表。
				const result = await getSuggestions(provider, [line], 0, line.length);
				// 必须有结果，之后才直接访问 items。
				assert.ok(result);
				// find 回调挑当前目录的带引号附件值；不假设它在多候选中的索引。
				const item = result.items.find((entry) => entry.value === `@"${directory}/"`);
				// 要求该目录存在于建议里，目录名作诊断消息。
				assert.ok(item, directory);
				// 应用目录，不添加附件文件才有的尾空格；实现会让光标停在闭引号前。
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				// 用返回的行与光标直接继续自然附件查询，不手动改引用内容。
				const continued = await getSuggestions(provider, applied.lines, 0, applied.cursorCol);
				// 新 prefix 包含开引号与完整目录末斜杠，不包含光标后的闭引号。
				assert.strictEqual(continued?.prefix, `@"${directory}/`);
				// 要求下一轮候选包含当前目录的带引号 test.txt，未精确比较其他候选。
				assert.ok(continued?.items.some((entry) => entry.value === `@"${directory}/test.txt"`));
			}
		});

		// 空 @ 搜索应包含 .pi/.github 隐藏目录而排除 .git；使用自建名称夹具，不覆盖所有真实 Git 仓库忽略规则。
		test("includes hidden paths but excludes .git", async () => {
			// 创建三个点开头目录及其内容。
			setupFolder(baseDir, {
				// 这些只是临时目录名；.git 内容并未组成完整有效仓库。
				dirs: [".pi", ".github", ".git"],
				// 分别放文件确保能测试目录及其子路径。
				files: {
					// JSON 文本只是隐藏目录中的文件。
					".pi/config.json": "{}",
					// YAML 文本不会启动 CI。
					".github/workflows/ci.yml": "name: ci",
					// 简单 config 文本只为建立 .git 子项。
					".git/config": "[core]",
				},
			});

			// 提供者通过 fd --hidden 等参数和额外 .git 路径过滤生成结果。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 空附件查询没有额外匹配词限制。
			const line = "@";
			// 等待候选。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 没有结果时变 []，正例断言仍会失败，不能因负例不存在而误过。
			const values = result?.items.map((item) => item.value) ?? [];
			// 要求包含 .pi 目录值。
			assert.ok(values.includes("@.pi/"));
			// 要求包含 .github 目录值。
			assert.ok(values.includes("@.github/"));
			// some 检查 .git 本身或它的后代，一旦有任一项即令否定断言失败；不会把 .github 误当 .git/。
			assert.ok(!values.some((value) => value === "@.git" || value.startsWith("@.git/")));
		});

		// fd 跟随指向兄弟 outside 的目录链接，应同时找出真实 dir 与链接路径下同名文件；链接目标仍在本例共同临时根内。
		test("follows symlinked directories for fuzzy @ search", async () => {
			// 先建立基目录内的普通路径正例。
			setupFolder(baseDir, {
				// 声明普通文件映射。
				files: {
					// 普通 dir/some_file.txt 与链接目标同名，方便比较两条路径都出现。
					"dir/some_file.txt": "real",
				},
			});
			// 另在兄弟目录建立链接将指向的文件。
			setupFolder(outsideDir, {
				// 此映射的相对根是 outsideDir，不是 baseDir。
				files: {
					// 正文不同只用于说明夹具来源，补全不读取正文。
					"some_file.txt": "symlinked",
				},
			});
			// 同步创建相对链接 ../outside；相对目标以链接所在 baseDir 为起点，不以当前进程 cwd 为起点。
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			// 提供者只配置 cwd 基路径，fd 的 --follow 允许经链接走到它外面。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 按共同文件名前缀搜索。
			const line = "@some";
			// 等待真实 fd 跟随链接并产生路径结果。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 取值或用空数组，让下面两个肯定断言检查实际命中。
			const values = result?.items.map((item) => item.value) ?? [];
			// 原普通路径应在结果中。
			assert.ok(values.includes("@dir/some_file.txt"));
			// 链接路径也应保留其链接名称，不能只展示目标 outside 的物理路径。
			assert.ok(values.includes("@symlinked_dir/some_file.txt"));
		});

		// 按链接目录名查询应返回带 / 的链接目录候选；既验证 --follow 的可见性，也验证目录标签约定。
		test("returns symlinked directories when matching their name", async () => {
			// 先在 outside 中建立目标目录内容。
			setupFolder(outsideDir, {
				// 声明目标的嵌套文件。
				files: {
					// 让链接目标是实际非空目录，文本不会执行。
					"nested/file.txt": "symlinked",
				},
			});
			// 在 baseDir 中建立 symlinked_dir 指向兄弟 outside，未显式指定 Windows 链接类型。
			symlinkSync("../outside", join(baseDir, "symlinked_dir"));

			// 启用真实 fd 在基目录下搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 查询链接的显示名称，而不是其中 file.txt。
			const line = "@symlinked";
			// 等待目录候选生成。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 读取 value 列表，无结果回退为空。
			const values = result?.items.map((item) => item.value) ?? [];
			// 要求链接作为可继续补全的目录值出现，末尾 / 不可丢。
			assert.ok(values.includes("@symlinked_dir/"));
		});

		// 链接指向普通文件时，现有 fd 的 f/d 类型查询也应返回 link.txt；本例没有给 fd 额外添加 type l。
		test("returns symlinked files without requiring type l", async () => {
			// 建立链接将引用的原文件。
			setupFolder(baseDir, {
				// 夹具映射只含目标文件。
				files: {
					// original.txt 是磁盘目标，不是拷贝到链接文件的正文。
					"original.txt": "content",
				},
			});
			// 计算新链接在基目录中的位置。
			const linkPath = join(baseDir, "link.txt");
			// 以相对原文件名创建符号链接，目标与链接在同一目录。
			symlinkSync("original.txt", linkPath);

			// 提供者参数保持通常的 fd 查询配置。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 只查询链接名字，非 original 名字。
			const line = "@link";
			// 等待链接文件可见性查询。
			const result = await getSuggestions(provider, [line], 0, line.length);

			// 结果 value 缺失时用 [] 供断言报告。
			const values = result?.items.map((item) => item.value) ?? [];
			// 要求结果包含不带末斜杠的文件链接附件值，不验证打开链接后的正文。
			assert.ok(values.includes("@link.txt"));
		});

		// 两棵同构临时树只有基路径名称是否含 plan 不同；比较候选 label/description 并要求两个目标确实存在，防止绝对扫描根污染匹配。
		test("returns the same @ suggestions when the cwd path contains the query", async () => {
			// 建立不包含查询词 plan 的基目录路径。
			const normalBaseDir = join(rootDir, "cwd-normal");
			// 另一个基目录本身包含 plan，作为回归触发条件。
			const queryInPathBaseDir = join(rootDir, "cwd-plan-repro");
			// 真正创建第一棵树根。
			mkdirSync(normalBaseDir, { recursive: true });
			// 真正创建第二棵树根，两者仍在公共临时根中。
			mkdirSync(queryInPathBaseDir, { recursive: true });

			// 共享一份夹具声明，setupFolder 不修改它，两个目录获得相同相对结构。
			const structure = {
				// 目录名 plan-mode 提供目录候选。
				dirs: ["packages/coding-agent/examples/extensions/plan-mode"],
				// 文件相对路径的内容两棵树完全一致。
				files: {
					// 目录中的 README 可使递归查询暴露基路径匹配过宽的问题。
					"packages/coding-agent/examples/extensions/plan-mode/README.md": "readme",
					// 另一分支中的 plan.md 是明确的文件名匹配。
					"packages/tui/docs/plan.md": "plan",
				},
			};
			// 先写正常基路径下的夹具。
			setupFolder(normalBaseDir, structure);
			// 再把同一结构写入含查询词的基路径。
			setupFolder(queryInPathBaseDir, structure);

			// 两次查询均为 @plan，只有 provider 的 basePath 不同。
			const query = "@plan";
			// 普通路径的提供者。
			const normalProvider = new CombinedAutocompleteProvider([], normalBaseDir, requireFdPath());
			// 基路径含 plan 的提供者，不使用 process.chdir。
			const queryInPathProvider = new CombinedAutocompleteProvider([], queryInPathBaseDir, requireFdPath());

			// 顺序等待第一棵树的查询结果。
			const normalResult = await getSuggestions(normalProvider, [query], 0, query.length);
			// 再顺序等待第二棵树，不是并发 fd 比较。
			const queryInPathResult = await getSuggestions(queryInPathProvider, [query], 0, query.length);

			// 局部 normalize 把查询结果变成排序文本数组用于比较；Awaited 解开 Promise，ReturnType/typeof 在编译期取得包装器返回类型，不再次调用它。
			const normalize = (result: Awaited<ReturnType<typeof getSuggestions>>) =>
				// null 结果回退 []；每项只拼 label 和可选 description 后排序，因此本断言不比较 value、原候选顺序或光标。
				(result?.items ?? [])
					.map((item) => `${item.label} :: ${item.description ?? ""}`)
					.sort();

			// 要求两个基路径产生相同的规范化候选集合。
			assert.deepStrictEqual(normalize(queryInPathResult), normalize(normalResult));
			// 另要求非空正例，避免两边都 [] 也通过相等断言。
			assert.ok(
				// 目录 label 带末斜杠，description 仍是没有末斜杠的相对路径。
				normalize(normalResult).includes("plan-mode/ :: packages/coding-agent/examples/extensions/plan-mode"),
			);
			// 文件候选也必须存在，明确比较的不只是目录项。
			assert.ok(normalize(normalResult).includes("plan.md :: packages/tui/docs/plan.md"));
		});

		// 在现成闭引号前继续 @ 目录补全，要求两个子文件均出现；本例只查询，不应用选择。
		test("continues autocomplete inside quoted @ paths", async () => {
			// 建立含 ASCII 空格的目录。
			setupFolder(baseDir, {
				// 两个文件用来检查目录展开，而非仅靠单个前缀命中。
				files: {
					// 第一个期待文件。
					"my folder/test.txt": "content",
					// 第二个期待文件。
					"my folder/other.txt": "content",
				},
			});

			// fd 提供者支持附件路径中的引用上下文。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 整行已经有一对引号，@ 在引号外面。
			const line = '@"my folder/"';
			// length-1 把光标放在末尾闭引号之前，查询只看到开引号和目录。
			const result = await getSuggestions(provider, [line], 0, line.length - 1);

			// 要求不是 null，再用可选链检查内容。
			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			// 提取实际替换值，它们应各自带完整双引号。
			const values = result?.items.map((item) => item.value);
			// 至少包含 test.txt 的完整附件值。
			assert.ok(values?.includes('@"my folder/test.txt"'));
			// 至少包含 other.txt 的完整附件值，未断言精确排列顺序。
			assert.ok(values?.includes('@"my folder/other.txt"'));
		});

		// 在 @"my folder/te" 的闭引号前选 test.txt，应消去原来的重复闭引号并追加附件文件空格；不测试目录光标。
		test("applies quoted @ completion without duplicating closing quote", async () => {
			// 建立唯一匹配文件。
			setupFolder(baseDir, {
				// 声明引用路径夹具。
				files: {
					// 空格属于目录名，不能当作查询断点。
					"my folder/test.txt": "content",
				},
			});

			// 创建读取本例目录的 fd 提供者。
			const provider = new CombinedAutocompleteProvider([], baseDir, requireFdPath());
			// 输入既有闭引号，前缀 te 还未完成。
			const line = '@"my folder/te"';
			// 光标停在闭引号前，不把它纳入待替换 prefix。
			const cursorCol = line.length - 1;
			// 先获取真实候选。
			const result = await getSuggestions(provider, [line], 0, cursorCol);

			// 查询必须存在。
			assert.notEqual(result, null, "Should return suggestions for quoted @ path");
			// 按完整带引号的 value 找目标，不依赖候选排序。
			const item = result?.items.find((entry) => entry.value === '@"my folder/test.txt"');
			// 要求找到了该项，避免后续用 undefined 做替换。
			assert.ok(item, "Should find test.txt suggestion");

			// 对 item/result 的 ! 都只是编译期非空断言；实际由前面的 assert 检查提供前提。
			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			// 精确要求一对双引号后恰好一个附件尾空格，没有重复闭引号。
			assert.strictEqual(applied.lines[0], '@"my folder/test.txt" ');
		});
	});

	// 普通路径补全组覆盖 ./、边界、包装符及中文；不传 fd，真实同步 readdir/stat 仅访问此组自建目录及其子路径。
	describe("dot-slash path completion", () => {
		// 保存本例独立的基路径，钩子会在每个叶用例前重新赋值。
		let baseDir = "";

		// 每例前创建随机目录，返回的字符串用于 provider，不修改进程全局 cwd。
		beforeEach(() => {
			// pi-autocomplete- 是临时名称前缀，随机后缀避免不同测试复用同一目录。
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		// 每例后同步清理临时树；框架管理钩子，不把它误称为所有准备操作都已包在函数内 finally。
		afterEach(() => {
			// recursive 删除内容，force 忽略路径不存在；其他删除失败仍可能报告错误。
			rmSync(baseDir, { recursive: true, force: true });
		});

		// 用汉字/补充平面字符正文配多种分隔符，再补短中文路径、./ 路径和非 Windows 绝对路径；验证前文/后文和 UTF-16 光标全部保留。
		test("completes Chinese path prefixes after whitespace or CJK punctuation on Tab", async () => {
			// 两个文件分别提供基目录短名及嵌套目录/文件补全。
			setupFolder(baseDir, { files: { "说明.md": "file", "文档/说明.md": "nested file" } });
			// 不配置 fd，只走普通目录补全。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 声明查询前缀与预期替换值的表，后面按每种分隔符重复验证。
			const completions = [
				// 短文件名前缀说补成说明.md。
				{ prefix: "说", value: "说明.md" },
				// 短目录名前缀文补成带末 / 的文档/。
				{ prefix: "文", value: "文档/" },
				// 包含目录时只替换最后文件名部分。
				{ prefix: "文档/说", value: "文档/说明.md" },
				// 用户显式输入 ./ 时预期写回也保留 ./。
				{ prefix: "./文档/说", value: "./文档/说明.md" },
			];
			// 只在非 Windows 加入以 / 开始的绝对路径样本；没有为 Windows 盘符绝对路径另加一例。
			if (process.platform !== "win32") {
				// 把真实临时基路径放进查询与预期值，访问范围仍是本例自建树。
				completions.push({ prefix: `${baseDir}/文档/说`, value: `${baseDir}/文档/说明.md` });
			}
			// for...of 逐字符遍历空白/CJK 标点；转义包括 tab、全角空格和不换行空格，都被当作补全边界。
			for (const separator of " \t\u3000\u00a0，：；。！？（「《") {
				// 每轮对象解构取得当前查询 prefix 和预期 value，不修改测试表。
				for (const { prefix, value } of completions) {
					// 前文含补充平面汉字𠮷，UTF-16 length 会计两个码元，专门检查不是按可见字符数定位。
					const before = `查看𠮷${separator}`;
					// 查询后保留一段空格加后文，应用替换不应删去它。
					const line = `${before}${prefix} 后文`;
					// 插入点等于前文码元长度加查询码元长度，正好在原后文前。
					const cursorCol = before.length + prefix.length;
					// true 强制普通路径补全，允许说/文这样的非斜杠短词查询。
					const result = await getSuggestions(provider, [line], 0, cursorCol, true);
					// 当前组合必须有建议，失败消息含整行输入。
					assert.ok(result, line);
					// 替换前缀必须完全等于测试表中的 prefix，不应包含中文前文。
					assert.strictEqual(result.prefix, prefix);
					// 深比较候选数组，防止多余条目混进这一唯一预期。
					assert.deepStrictEqual(
						// 只读取候选写回值，不比较目录显示标签。
						result.items.map((item) => item.value),
						// 每个表项在当前夹具下期望恰好一个 value。
						[value],
					);
					// 把第一个候选应用到原行及原光标，! 不会在运行时验证数组有首项。
					const applied = provider.applyCompletion([line], 0, cursorCol, result.items[0]!, result.prefix);
					// 原 before 与原有“ 后文”都要留下，普通文件不会再额外加一个空格。
					assert.strictEqual(applied.lines[0], `${before}${value} 后文`);
					// 光标移到候选末尾、原后文前，长度仍用 UTF-16 码元。
					assert.strictEqual(applied.cursorCol, before.length + value.length);
				}
			}
		});

		// 即使磁盘真有含空白/标点的完整目录，未加引号时仍按分隔边界取末尾归档/说；加引号后才把整个目录名视为一段路径。
		test("treats unquoted separators as boundaries even when a matching literal path exists", async () => {
			// 建立无分隔符的归档/说明.md，作为未引用时应命中的目标。
			setupFolder(baseDir, { files: { "归档/说明.md": "other" } });
			// 创建不使用 fd 的普通路径提供者。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 四种分隔符分别作为目录名称内的字符测试。
			for (const separator of [" ", "\u3000", "，", "。"]) {
				// 当前真实目录名包含分隔符，不能仅因它存在就忽略文本边界规则。
				const directory = `资料${separator}归档`;
				// 建立完整字面目录，使错误的“总取整行路径”实现也有机会返回错误目标。
				setupFolder(baseDir, { files: { [`${directory}/说明.md`]: "archive" } });
				// 同时比较没有 @ 与起始有 @ 的文本；未引用分隔符后的 token 都不再含那个 @。
				for (const marker of ["", "@"]) {
					// 起始标记在分隔符前，真正末 token 是归档/说。
					const line = `${marker}${directory}/说`;
					// 强制请求仍尊重未引用分隔符，而非把整行强行当成一条路径。
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					// 需要有候选。
					assert.ok(result, line);
					// 严格要求 prefix 只为归档/说，前面的 marker/资料/分隔符不在替换区内。
					assert.strictEqual(result.prefix, "归档/说");
					// 比较普通路径的唯一替换值。
					assert.deepStrictEqual(
						// 读出所有候选 value。
						result.items.map((item) => item.value),
						// 此处应命中无分隔符的归档树，而不是资料…归档树。
						["归档/说明.md"],
					);
				}
				// 改成合法正文边界后的引用形式，闭引号后还有需要保留的后文。
				const quoted = `查看，"${directory}/说"后文`;
				// 把光标放到现有闭引号前，保留它供应用阶段处理。
				const cursorCol = quoted.indexOf('"后文');
				// 引用前缀优先于普通分词，因此内部标点/空白现在属于路径。
				const result = await getSuggestions(provider, [quoted], 0, cursorCol, true);
				// 引用查询必须成功。
				assert.ok(result);
				// prefix 含开引号和完整目录名，不含原闭引号。
				assert.strictEqual(result.prefix, `"${directory}/说`);
				// 严格要求引用目录下唯一文件值。
				assert.deepStrictEqual(
					// 取写回值，而不是只显示末尾文件名的 label。
					result.items.map((item) => item.value),
					// 完整引用候选已自带闭引号。
					[`"${directory}/说明.md"`],
				);
				// 应用时消费原后缀开头的重复闭引号，其他后缀保持。
				const applied = provider.applyCompletion([quoted], 0, cursorCol, result.items[0]!, result.prefix);
				// 普通路径补全后没有附件专用尾空格，后文紧跟唯一闭引号。
				assert.strictEqual(applied.lines[0], `查看，"${directory}/说明.md"后文`);
				// 另造不存在目录的未闭引用查询，不创建该目录。
				const missing = `查看，"不存在${separator}归档/说`;
				// 同步读目录失败被实现转换成空候选，上层最终返回 null；不应退回不相关目录。
				assert.strictEqual(await getSuggestions(provider, [missing], 0, missing.length, true), null);
			}
		});

		// 正文后的空白/中文标点允许空前缀列目录，普通和强制请求都一致；完全空输入的自然请求则不触发。
		test("handles an empty prefix after whitespace or CJK punctuation consistently", async () => {
			// 基目录只有说明.md，方便严格比较空前缀的全量结果。
			setupFolder(baseDir, { files: { "说明.md": "text" } });
			// 不配置 fd，空前缀走同步目录列表。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 覆盖 ASCII 空格、tab、全角空格和两个中文标点。
			for (const separator of [" ", "\t", "\u3000", "，", "。"]) {
				// 每种分隔符都分别用默认风格和强制风格查询。
				for (const force of [false, true]) {
					// 中文正文后只有分隔符，当前 token 长度为 0，但整行不是空串。
					const line = `查看${separator}`;
					// 以行末 UTF-16 下标查询，把布尔 force 原样传下。
					const result = await getSuggestions(provider, [line], 0, line.length, force);
					// 正文边界后的空前缀应有建议。
					assert.ok(result, line);
					// 返回的替换前缀必须是空串，不能把正文或分隔符删掉。
					assert.strictEqual(result.prefix, "");
					// 检查目录内候选列表。
					assert.deepStrictEqual(
						// 映射 value，预期文件路径不带 @。
						result.items.map((item) => item.value),
						// 恰好一个说明.md。
						["说明.md"],
					);
				}
			}
			// 与上面的非空正文对照：完全空行且未传 force 时，应直接无建议，不自然列全目录。
			assert.strictEqual(await getSuggestions(provider, [""], 0, 0), null);
		});

		// 检查一层/连续未闭包装符后的普通路径和 ./ 路径，应用后保留包装符；不执行括号、反引号中的任何命令。
		test("completes paths after opening wrappers like ( [ { < and backticks", async () => {
			// 建立 src/main.ts，正文 x 只是占位文本。
			setupFolder(baseDir, { files: { "src/main.ts": "x" } });
			// 只使用普通路径提供者。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 列表包括单个和连续开包装符，未包含其闭合符号。
			for (const wrapper of ["(", "[", "{", "<", "`", "((", "(`"]) {
				// 两种查询分别检查普通相对路径和显式 ./ 展示。
				for (const prefix of ["src/ma", "./src/ma"]) {
					// 正文与开包装符都在应替换前缀之前。
					const before = `see ${wrapper}`;
					// 整行末尾接待补路径，不额外闭合包装。
					const line = `${before}${prefix}`;
					// 强制补全允许提取最后的路径 token。
					const result = await getSuggestions(provider, [line], 0, line.length, true);
					// 每个组合必须得到候选。
					assert.ok(result, line);
					// prefix 不含前面的开包装符。
					assert.strictEqual(result.prefix, prefix);
					// replace 只把测试查询中的 src/ma 换成完整文件名，保留可能存在的 ./。
					const value = prefix.replace("src/ma", "src/main.ts");
					// 检查完整候选数组。
					assert.deepStrictEqual(
						// 只取用于替换的值。
						result.items.map((item) => item.value),
						// 期望一个完整文件值。
						[value],
					);
					// 应用候选到原始行，把剥离包装符的解析结果用于精确替换。
					const applied = provider.applyCompletion([line], 0, line.length, result.items[0]!, result.prefix);
					// 要求正文/包装符仍在，普通路径文件不追加空格。
					assert.strictEqual(applied.lines[0], `${before}${value}`);
				}
			}
		});

		// 未闭括号后紧跟未闭引用路径也可补全，prefix 从双引号开始而不吞掉括号；只检查查询结果。
		test("completes quoted paths after opening wrappers", async () => {
			// 创建名称含空格的目录和文件。
			setupFolder(baseDir, { files: { "my dir/main.ts": "x" } });
			// 提供者配置本例临时基目录。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 输入只有开括号/开双引号，没有闭合它们，不是 JS 源码执行。
			const line = 'see ("my dir/ma';
			// 光标在末尾，用强制普通路径查询。
			const result = await getSuggestions(provider, [line], 0, line.length, true);
			// 必须找到结果。
			assert.ok(result);
			// 前缀保留开双引号，不包含 see 和括号。
			assert.strictEqual(result.prefix, '"my dir/ma');
			// 严格比较带引用的完整文件值。
			assert.deepStrictEqual(
				// 读取所有 value。
				result.items.map((item) => item.value),
				// 候选会补齐一个闭双引号，测试没有要求补上原括号。
				['"my dir/main.ts"'],
			);
		});

		// 路径名内部已配对的 [slug] 或 (group) 不能当作可剥离的正文包装符；表驱动检查这些路由样式目录及 ./ 写法。
		test("keeps wrappers that are closed inside the path", async () => {
			// 真实创建方括号/括号目录名，不依赖 shell 通配符展开。
			setupFolder(baseDir, { files: { "[slug]/page.tsx": "x", "(group)/layout.tsx": "x" } });
			// 普通路径扫描不使用 fd 正则搜索。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 每行二元数组解构为查询和期望值；此处未用 as const，仍可由 TS 推断为字符串数组。
			for (const [prefix, value] of [
				// 已配对方括号属于目录名，完整保留。
				["[slug]/pa", "[slug]/page.tsx"],
				// 已配对圆括号同样属于目录名。
				["(group)/la", "(group)/layout.tsx"],
				// 显式 ./ 也要与方括号一起保留。
				["./[slug]/pa", "./[slug]/page.tsx"],
			]) {
				// 在正文 see 后提供路径，让空间边界和内部成对包装同时出现。
				const line = `see ${prefix}`;
				// 强制查询，光标在末尾。
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				// 每轮必须有建议。
				assert.ok(result, line);
				// prefix 应等于完整路径查询，没有丢掉开括号/方括号。
				assert.strictEqual(result.prefix, prefix);
				// 严格比较完整文件值。
				assert.deepStrictEqual(
					// 逐项提取 value。
					result.items.map((item) => item.value),
					// 期望唯一保留路径包装的完整结果。
					[value],
				);
			}
		});

		// 直接输入无 @、无引号、无 ./ 的中文嵌套路径，也可在强制补全时保留所有中文字符并找到文件。
		test("preserves CJK characters in unprefixed Tab completions", async () => {
			// 建立中文目录和文件。
			setupFolder(baseDir, { files: { "文档/说明.md": "text" } });
			// 使用普通目录扫描。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 查询前缀本身全是中文及目录斜杠。
			const line = "文档/说";
			// 强制请求以整行长度作为光标。
			const result = await getSuggestions(provider, [line], 0, line.length, true);
			// 必须有候选。
			assert.ok(result);
			// 替换前缀应等于原输入，没有把中文当作分隔符截断。
			assert.strictEqual(result.prefix, line);
			// 比较实际写回路径。
			assert.deepStrictEqual(
				// 读取 value 数组。
				result.items.map((item) => item.value),
				// 只应出现当前夹具的完整中文文件路径。
				["文档/说明.md"],
			);
		});

		// 文件补全应保留用户输入的 ./，即使 path.join 会规范掉它；只要求目标存在，不要求列表精确长度。
		test("preserves ./ prefix when completing paths", async () => {
			// 建立两个普通文件作为匹配与非匹配对照。
			setupFolder(baseDir, {
				// 这里是文件映射，不是实际导入或执行这些文件。
				files: {
					// update.sh 的 shebang 只写进夹具正文，不会启动 bash。
					"update.sh": "#!/bin/bash",
					// utils.ts 正文也不执行，名称不匹配 up。
					"utils.ts": "export {};",
				},
			});

			// 使用本例临时基目录。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 用户显式要求 ./ 开头的相对路径形式。
			const line = "./up";
			// 强制查询只列基目录并匹配 up。
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			// 要求存在候选结果。
			assert.notEqual(result, null, "Should return suggestions for ./ path");
			// 提取候选写回路径。
			const values = result?.items.map((item) => item.value);
			// 目标值必须保留 ./；JSON.stringify 只用于断言失败消息，便于查看实际列表。
			assert.ok(values?.includes("./update.sh"), `Expected ./update.sh in ${JSON.stringify(values)}`);
		});

		// 目录补全也应保留 ./ 并带目录末斜杠，不能只在文件候选中恢复该前缀。
		test("preserves ./ prefix for directory completions", async () => {
			// 建立 src 目录和其中一个文件。
			setupFolder(baseDir, {
				// 目录候选由 src 本身提供。
				dirs: ["src"],
				// 子文件只使夹具更接近普通项目，不会因本次 sr 查询而递归展开。
				files: {
					// 源码文本是占位内容。
					"src/index.ts": "export {};",
				},
			});

			// 创建普通目录提供者。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 用 ./sr 作为未完成目录名。
			const line = "./sr";
			// 等待包装成 Promise 的真实同步路径补全结果。
			const result = await getSuggestions(provider, [line], 0, line.length, true);

			// 要求查询成功。
			assert.notEqual(result, null, "Should return suggestions for ./ directory path");
			// 只提取 value。
			const values = result?.items.map((item) => item.value);
			// 同时检查 ./ 和目录尾 /，失败时附实际列表。
			assert.ok(values?.includes("./src/"), `Expected ./src/ in ${JSON.stringify(values)}`);
		});
	});

	// 普通引用路径的专门回归：自动引用、目录优先、已有闭引号内继续查询及闭引号去重；不传 fd、不创建真实终端。
	describe("quoted path completion", () => {
		// 保存这组每例独立的临时基路径。
		let baseDir = "";

		// 每例前同步创建新随机目录，避免夹具在不同叶用例之间累积。
		beforeEach(() => {
			// 返回新目录路径并保存给后面的 setupFolder/provider。
			baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
		});

		// 每例后删除这组临时树，错误可由框架报告。
		afterEach(() => {
			// 递归清理夹具；force 不代表所有删除失败都被忽略。
			rmSync(baseDir, { recursive: true, force: true });
		});

		// 普通目录名称含空白/CJK 标点时应自动双引号引用，应用目录后再补子文件；与 @ 附件分支分开验证。
		test("quotes paths containing whitespace or CJK punctuation for direct completion", async () => {
			// 同一个 provider 在循环中复用，夹具目录逐轮累积。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 遍历四种目录内分隔字符。
			for (const separator of [" ", "\u3000", "，", "。"]) {
				// 当前目录名中的字符应被整体引用，不能靠去掉字符改变文件名。
				const directory = `my${separator}folder`;
				// 动态路径键建立这个目录下的 test.txt。
				setupFolder(baseDir, { files: { [`${directory}/test.txt`]: "content" } });
				// 首次用户查询没有双引号。
				const line = "my";
				// 强制补全普通词 my，允许返回这几个目录候选。
				const result = await getSuggestions(provider, [line], 0, line.length, true);
				// 需要有候选列表。
				assert.ok(result);
				// 找当前目录完整的带引号值，目录末 / 在闭引号之前。
				const item = result.items.find((entry) => entry.value === `"${directory}/"`);
				// 该目录必须存在于候选里，目录名作失败消息。
				assert.ok(item, directory);
				// 应用目录候选；返回光标在闭引号内，不添加文件附件专用空格。
				const applied = provider.applyCompletion([line], 0, line.length, item, result.prefix);
				// 从应用返回的行和光标继续强制查询，不手动去掉闭引号。
				const continued = await getSuggestions(provider, applied.lines, 0, applied.cursorCol, true);
				// 新的替换前缀包含开引号与完整目录，不包含现有闭引号。
				assert.strictEqual(continued?.prefix, `"${directory}/`);
				// 本例严格要求只有当前目录的那个文件。
				assert.deepStrictEqual(
					// 可选链让没有 continued 结果时产生 undefined，由断言报告差异。
					continued?.items.map((entry) => entry.value),
					// 文件值保留包围整条路径的一对引号，没有 @。
					[`"${directory}/test.txt"`],
				);
			}
		});

		// 两个需引用的目录应排在普通文件前；比较标签的目录布尔序列，而不规定两个目录彼此的语言排序。
		test("keeps quoted directories before files", async () => {
			// z 开头目录与 a 文件形成反字母顺序对照，目录优先不能只靠名字偶然成立。
			setupFolder(baseDir, { dirs: ["z folder", "z，folder"], files: { "a.txt": "text" } });
			// 普通目录补全 provider，不使用 fd 的匹配评分。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 空行 force=true 列出整个自建基目录，不触发自然空行的 null 门槛。
			const result = await getSuggestions(provider, [""], 0, 0, true);
			// 要求有结果。
			assert.ok(result);
			// 深比较目录/文件的排列属性，不比较候选 value 的引号字符。
			assert.deepStrictEqual(
				// label 始终用条目名称加可能的末 /；引号在 value 中，不影响这里的目录判断。
				result.items.map((item) => item.label.endsWith("/")),
				// 两个目录先于文件，未规定哪一个目录排第一。
				[true, true, false],
			);
		});

		// 在现成引用目录的闭引号前查询，结果应包含两个子文件；不在本例应用候选。
		test("continues completion inside quoted paths", async () => {
			// 建立同一个带空格目录中的两个文件。
			setupFolder(baseDir, {
				// 文件名映射只用于磁盘夹具。
				files: {
					// 第一项待验证文件。
					"my folder/test.txt": "content",
					// 第二项待验证文件。
					"my folder/other.txt": "content",
				},
			});

			// 不传 fd，走普通路径解析及同步读取。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 整行有一对引号，目录以 / 结束。
			const line = '"my folder/"';
			// length-1 把光标放在闭引号前，强制查询展开该目录。
			const result = await getSuggestions(provider, [line], 0, line.length - 1, true);

			// 要求存在结果。
			assert.notEqual(result, null, "Should return suggestions for quoted folder path");
			// 读取完整带引号的替换值。
			const values = result?.items.map((item) => item.value);
			// 要求包含 test.txt 文件。
			assert.ok(values?.includes('"my folder/test.txt"'));
			// 要求也包含 other.txt 文件；两条 includes 不约束列表精确顺序。
			assert.ok(values?.includes('"my folder/other.txt"'));
		});

		// 普通引用文件替换时只保留一个闭引号；与前面的 @ 版本不同，本例预期末尾没有附加空格。
		test("applies quoted completion without duplicating closing quote", async () => {
			// 建立唯一匹配文件。
			setupFolder(baseDir, {
				// 声明普通引用路径的文件夹具。
				files: {
					// 目录名称里的空格必须保留。
					"my folder/test.txt": "content",
				},
			});

			// 提供者基路径指向本例随机目录。
			const provider = new CombinedAutocompleteProvider([], baseDir);
			// 未完成前缀 te 后已经存在一个闭引号。
			const line = '"my folder/te"';
			// 光标位于这个闭引号前。
			const cursorCol = line.length - 1;
			// 强制查询只看光标前文字，候选本身会自带闭引号。
			const result = await getSuggestions(provider, [line], 0, cursorCol, true);

			// 查询必须有结果。
			assert.notEqual(result, null, "Should return suggestions for quoted path");
			// find 选出完整引用的 test.txt，不假定数组首项。
			const item = result?.items.find((entry) => entry.value === '"my folder/test.txt"');
			// 实际运行断言确保目标存在，! 不是它的替代。
			assert.ok(item, "Should find test.txt suggestion");

			// 用原 prefix 和原光标应用选择；item!/result! 是编译期断言，执行仍使用原值。
			const applied = provider.applyCompletion([line], 0, cursorCol, item!, result!.prefix);
			// 精确要求单对引号和无尾空格的普通文件路径，防止重复引号或混用附件规则。
			assert.strictEqual(applied.lines[0], '"my folder/test.txt"');
		});
	});
});
