// 验证交互模式如何汇总扩展包更新日志：首次记版本、升级后展示、恢复会话跳过，以及不合条件的来源跳过。
// 这里只借用 InteractiveMode 原型方法；临时目录放测试包文件，设置后端在内存中，不构造界面或执行扩展。
// 导入同步文件操作：创建目录、创建随机临时目录、清理目录和写文件；实际路径都由本文件的夹具生成。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// tmpdir 返回操作系统临时目录位置，不是用户的扩展安装目录。
import { tmpdir } from "node:os";
// join 按当前平台规则拼路径；它本身不创建目录或读取文件。
import { join } from "node:path";
// Vitest 的钩子为每例准备/清理夹具，describe 组织分组，test 注册用例，expect 执行断言。
import { afterEach, beforeEach, describe, expect, test } from "vitest";
// 使用真实设置管理器，但注入只保存字符串的内存后端；版本 getter 的断言不等于磁盘持久化测试。
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
// getSourcePackageKey 是运行时函数；type SourceInfo 仅约束来源字段，编译后不会留下该类型导入。
import { getSourcePackageKey, type SourceInfo } from "../src/core/source-info.ts";
// 导入类以取得实际原型实现；下面没有 new InteractiveMode，也不通过资源加载器导入扩展文件。
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// 汇总结果的本地结构类型：包名用于标题，version 是当前包版本，markdown 是待显示的更新正文。
// type 只参与 TypeScript 检查；并不会在运行时验证返回对象恰好具有这些字段。
type ExtensionChangelogUpdate = { name: string; version: string; markdown: string };

// 描述原型方法在本组路径中需要的最小 this 结构，并非一份完整 InteractiveMode 实例。
type ExtensionChangelogContext = {
	// session 只保留消息状态和扩展来源查询；没有模型请求或扩展执行能力。
	session: {
		// unknown[] 允许放任意消息值，但读取元素内容前通常需要收窄；实际方法在这里仅检查数组长度。
		state: { messages: unknown[] };
		// 方法签名要求返回带 extensions 数组的对象；Array<{ sourceInfo: SourceInfo }> 约束每项的来源信息。
		resourceLoader: { getExtensions(): { extensions: Array<{ sourceInfo: SourceInfo }> } };
	};
	// 使用真实 SettingsManager 的有效设置视图读取/修改已看过的包版本。
	settingsManager: SettingsManager;
	// 方法接收包根目录，返回可选名称/版本或 undefined；? 允许属性缺失，| 表示联合类型。
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

// 经 unknown 中转，把原型断言成这里需要的两个方法接口，便于访问原来的私有实现。
// as 不创建对象、不检查函数是否存在，也不绕过实际函数体的运行逻辑；它仅改变编译器看待该值的方式。
const prototype = InteractiveMode.prototype as unknown as {
	// this: 是 TypeScript 的显式接收者类型，不是运行时首个参数；之后用 call 指定假上下文。
	getExtensionChangelogUpdates(this: ExtensionChangelogContext): ExtensionChangelogUpdate[];
	// 保留真实 JSON 读取方法：同步读取 package.json、去 BOM、解析，并仅提取字符串名称/版本；读取/解析失败可返回 undefined。
	readPackageJson(packageRoot: string): { name?: string; version?: string } | undefined;
};

// 固定更新日志输入：Unreleased 不匹配数字版本，会被解析器跳过；其后依文件顺序放 1.2.0、1.1.0、1.0.0。
// 多行模板中的空行和标题都是测试数据；例如从 1.0.0 升级应得到 B、A 两段，下面不会向模板正文插注释。
const CHANGELOG = `# Changelog

## [Unreleased]

- Not released yet

## [1.2.0]

- Added feature B

## [1.1.0]

- Added feature A

## [1.0.0]

- Initial release
`;

// 注册四个独立用例；回调中的辅助函数共用本组变量，每个用例前都会重新准备一套正常夹具。
describe("InteractiveMode extension changelog", () => {
	// 保存 mkdtempSync 成功返回的根目录；let 允许钩子更新，: string 不会在运行时赋初值。
	let tempDir: string;
	// 包根目录位于该随机临时目录的 pkg 子目录内。
	let packageRoot: string;
	// 保存可被用例替换的来源元数据；同一来源对象会被假资源查询读到。
	let sourceInfo: SourceInfo;
	// 每例各自建立设置管理器，避免上一例的已见版本影响下一例。
	let settingsManager: SettingsManager;
	// 消息数组开始为空；往里面 push 一个值就能触发实际方法的非空会话早退。
	let messages: unknown[];

	// 在当前夹具包根目录写 package.json；输入是版本字符串，返回 void，同步文件错误会直接抛出。
	// 名称固定，version 使用参数；例如 writePackage("1.2.0") 会覆盖上次写入的 1.0.0，但不执行任何安装。
	function writePackage(version: string): void {
		// 属性简写 version 等同 version: version；JSON.stringify 生成文本，再由同步写入覆盖夹具文件。
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-demo-extension", version }));
	}

	// 构造供原型方法使用的上下文，返回本地接口类型；不创建完整会话、界面或真实资源加载器。
	// 消息/设置复用本例对象；例如 messages.push 后再调用 display，方法会看到变长的同一个数组。
	function createContext(): ExtensionChangelogContext {
		// 返回新的顶层上下文对象，内部的引用不因此变成深复制。
		return {
			// 提供实际方法访问的 session 分支。
			session: {
				// 属性简写保留当前 messages 数组引用；不是在此复制或恢复历史会话。
				state: { messages },
				// 只模拟来源查询接口；没有执行真实扩展加载。
				resourceLoader: {
					// 箭头函数隐式返回括号包围的对象；每次调用会按当前 sourceInfo 创建查询结果。
					getExtensions: () => ({
						// Two extensions from the same package must only produce one changelog section.
						// 第二项浅展开同包元数据，仅把单文件路径改为 b.ts；两个键仍由相同 source + scope 组成。
						// 实际方法的每轮 seenKeys 应把这两项归为一个包；a.ts/b.ts 都只是元数据，本测试没有创建或执行它们。
						extensions: [{ sourceInfo }, { sourceInfo: { ...sourceInfo, path: join(packageRoot, "b.ts") } }],
					}),
				},
			},
			// 注入本例的真实设置管理器；已看过版本的更新会立即反映在 getter 的有效内存视图中。
			settingsManager,
			// 把真实包 JSON 读取函数作为上下文的方法；获取函数引用不会立即读取文件，之后在实际方法中调用才读取。
			readPackageJson: prototype.readPackageJson,
		};
	}

	// 触发一次包更新检查，返回待展示的结果数组；名称 display 不表示这里已经渲染了界面。
	// 无显式参数，使用当前夹具；检查会同步读包/日志并可能更新设置、排队写内存后端，例如首次返回 [] 仍记录版本。
	function display(): ExtensionChangelogUpdate[] {
		// call 把 createContext() 的结果作为方法 this；返回数组直接交给测试断言，异常仍向调用者抛出。
		return prototype.getExtensionChangelogUpdates.call(createContext());
	}

	// 每例前准备随机临时包与空会话，回调无参数、同步完成；例如正常完成后 pkg 中已有日志而尚无 package.json。
	// 创建/写入异常会使准备失败；只有 mkdtemp 已成功赋值后，后续清理才能依据本轮 tempDir 找到根目录。
	beforeEach(() => {
		// 在系统临时目录以指定前缀创建独立目录，并把返回路径赋给 tempDir；不是只拼一个尚未存在的名字。
		tempDir = mkdtempSync(join(tmpdir(), "pi-extension-changelog-"));
		// 计算该夹具的包根路径，不扫描实际用户包。
		packageRoot = join(tempDir, "pkg");
		// 创建 pkg 单层目录；父目录已由上一创建步骤提供，失败会同步抛出。
		mkdirSync(packageRoot);
		// 把原样多行日志写入本轮包目录，供真实 parseChangelog 读取。
		writeFileSync(join(packageRoot, "CHANGELOG.md"), CHANGELOG);
		// 构造包内扩展来源；这里的身份/路径元数据不会自动触发加载或安装。
		sourceInfo = {
			// a.ts 是首项扩展的来源路径，实际文件不需要存在，因为这条检查路径不执行扩展。
			path: join(packageRoot, "a.ts"),
			// 包来源字符串用于组成包身份，未向 npm 发起解析或请求。
			source: "npm:pi-demo-extension",
			// user 表示来源范围，并不意味着写入了真实用户设置目录。
			scope: "user",
			// package 满足实际方法检查包内来源的条件；后面的反例会改为 top-level。
			origin: "package",
			// baseDir 指向本轮临时包目录，实际 JSON 读取会以此定位 package.json。
			baseDir: packageRoot,
			// 显式给出日志路径；缺少该字段时实际方法会提前跳过，而不是自行寻找日志。
			changelogPath: join(packageRoot, "CHANGELOG.md"),
		};
		// 从全新的内存后端构造设置管理器；保存版本时先更新有效视图，再把后端写任务排入 Promise 队列。
		// 这些用例没有 await flush：后面的 getter 证明同步可见的版本状态，不证明排队任务已完成，也不涉及磁盘设置文件。
		settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		// 创建全新的空消息数组，实际方法只有在长度为零时才继续查扩展。
		messages = [];
	});

	// 每例后尝试删除夹具根目录，返回 void；例如正常路径会连同 package.json 和 CHANGELOG.md 一并移除。
	// 它不是 try/finally 包裹所有准备操作：若 mkdtemp 在赋值前失败，tempDir 可能未初始化或仍是旧值，不能保证本轮清理成功。
	afterEach(() => {
		// recursive 删除子树，force 忽略路径不存在的情形；它不吞掉所有权限错误或无效参数错误，也不等待设置队列。
		rmSync(tempDir, { recursive: true, force: true });
	});

	// 验证首次遇到一个包版本时只记录版本、不显示历史日志；本例输入 1.0.0，无此前已见版本。
	test("records the version on first launch without showing the changelog", () => {
		// 创建当前版本 1.0.0 的实际 JSON 文件，供原型方法读取。
		writePackage("1.0.0");

		// 结果为空并不表示没有副作用；首次分支会更新已见版本，然后跳过日志展示。
		expect(display()).toEqual([]);
		// 用与生产一致的 source/scope 身份键读取已见版本；toBe 断言精确字符串 1.0.0。
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	// 验证同包由 1.0.0 升至 1.2.0：返回唯一包段，标题带包名，内容包含较新的两条版本，并更新已见版本。
	// 同包 a.ts/b.ts 输入下只返回一次更新；这不单独证明 seenKeys 的去重实现，因为首项更新已见版本也会影响后项。
	test("shows entries newer than the last seen version, headed by package name", () => {
		// 先写旧版本，建立第一次启动的输入。
		writePackage("1.0.0");
		// 首次检查只建立 1.0.0 基线；这里故意不关心返回值，后面的升级断言依赖其设置副作用。
		display();
		// 覆盖包元数据为 1.2.0；日志仍使用准备阶段的同一份内容。
		writePackage("1.2.0");

		// 深比较完整返回数组，检查同包双扩展输入下恰有一项更新及其内容；不是给内部 Set 单独设置调用次数断言。
		expect(display()).toEqual([
			// 该对象是唯一预期更新包，不是每个扩展文件各返回一个对象。
			{
				// name 来自读取到的 package.json 名称，本例不走来源字符串的缺省名称分支。
				name: "pi-demo-extension",
				// version 是包元数据的当前版本；本例日志最高条恰好也是 1.2.0，并未测试二者不一致。
				version: "1.2.0",
				// markdown 必须与下面包含换行的字符串精确一致；原逻辑给每条数字版本标题加包名，保留对应正文。
				// 期望按日志文件顺序先 B 后 A，双换行分隔；排除 Unreleased 与等于基线的 1.0.0，不声称解析器会排序。
				markdown:
					"## pi-demo-extension [1.2.0]\n\n- Added feature B\n\n## pi-demo-extension [1.1.0]\n\n- Added feature A",
			},
		]);
		// 检查有效设置视图已变为 1.2.0；该断言不等待内存后端的异步排队保存完成。
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.2.0");
		// 相同当前版本再次检查应没有更新条目，表明基线更新对下一次调用已经生效。
		expect(display()).toEqual([]);
	});

	// 验证已有消息时跳过包更新；“恢复会话”在此通过非空消息模拟，不调用真正的会话恢复入口。
	test("skips resumed sessions", () => {
		// 先准备旧包版本。
		writePackage("1.0.0");
		// 在空消息条件下记录 1.0.0 基线。
		display();
		// 再把实际包文件升级为 1.2.0，制造原本可显示更新的条件。
		writePackage("1.2.0");
		// 原地追加一条简单消息；unknown[] 可接受此对象，实际早退只看 length，不校验 role/content。
		messages.push({ role: "user", content: "hi" });

		// 非空消息应使方法在查询扩展前直接返回空数组，故不显示此次包升级。
		expect(display()).toEqual([]);
		// 已见版本仍为旧值，说明跳过分支也没有把 1.2.0 标为已看过；不等于测试了完整会话恢复流程。
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBe("1.0.0");
	});

	// 验证两种不合条件的来源都跳过：顶层扩展，以及包来源缺少日志路径；不应建立已见版本。
	// 本例使用同一个管理器连续改元数据，文件读取失败或日志内容错误属于其他边界，本例没有模拟。
	test("ignores non-package extensions and packages without a changelog", () => {
		// 写可用的包元数据，确保跳过原因来自随后改变的来源条件。
		writePackage("1.0.0");
		// 浅展开保留其他字段，只把 origin 改为 top-level；这是替换 sourceInfo 变量，不是修改旧对象。
		sourceInfo = { ...sourceInfo, origin: "top-level" };
		// 非包来源应返回空结果，不把仍存在的 baseDir/日志路径当作足够条件。
		expect(display()).toEqual([]);

		// 恢复 package 身份，但显式把 changelogPath 设为 undefined；该属性仍可存在，实际判断按真值跳过。
		sourceInfo = { ...sourceInfo, origin: "package", changelogPath: undefined };
		// 缺失可用日志路径也返回空结果，未靠读取实际日志内容得出这个结果。
		expect(display()).toEqual([]);
		// source/scope 未变，因此同一个键应仍无已见版本；toBeUndefined 验证两个跳过路径都未建立基线。
		expect(settingsManager.getExtensionChangelogVersion(getSourcePackageKey(sourceInfo))).toBeUndefined();
	});
});
