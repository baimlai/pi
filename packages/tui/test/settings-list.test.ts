// 测设置列表的空格/搜索分流与翻页，只在内存更新项，不改用户配置文件或真实 TUI 模式；各 it 无参数、正常返回 void，断言失败抛错。
// deepStrictEqual 核对变化通知顺序/字段，match 检渲染文本，不把界面文本断言等同实际终端操作。
import assert from "node:assert";
// 注册场景回调。
import { describe, it } from "node:test";
// SettingsList 为运行时类，type SettingsListTheme 只检查主题回调形状，编译后擦除。
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";

// 无色主题满足接口；这些函数原样返回字符串、不做 IO/副作用，也不在保存对象时立即执行。
const testTheme: SettingsListTheme = {
	// 标签回调仅使用第一个 text 参数，允许少声明未用的 isSelected 参数。
	label: (text) => text,
	// 设置值样式恒等，例 fullscreen 仍是普通文字。
	value: (text) => text,
	// 描述样式不添控制码。
	description: (text) => text,
	// 用 > 加空格作当前行标记，后面正则据它定位选中项。
	cursor: "> ",
	// 提示样式原样返回。
	hint: (text) => text,
};

// 顶层样本数组供多个用例复用，构造列表前会浅复制每个条目以隔离 currentValue 变更。
const items = [
	// 单项对象的字段用于显示/循环值，不实际切换程序全屏。
	{
		// id 为通知中的稳定设置标识。
		id: "tui-mode",
		// label 同时是模糊搜索用文字。
		label: "TUI mode",
		// 初值 regular。
		currentValue: "regular",
		// 值列表给循环顺序：确认后 regular→fullscreen，再确认可回 regular。
		values: ["regular", "fullscreen"],
	},
];

// 分组包含有搜索词/空搜索两类空格行为及翻页回归。
describe("SettingsList", () => {
	// 搜索串非空例：逐字输入含空格的标签，不应误改设置，随后 Enter 才循环值。
	it("includes spaces in an active search instead of changing the selected setting", () => {
		// 显式 Array<{id:string;value:string}> 记录通知，类型仅开发期约束，不建立运行时校验器。
		const changes: Array<{ id: string; value: string }> = [];
		// 多行实参构造真实列表，保存回调，尚未通知。
		const list = new SettingsList(
			// map 用对象展开浅复制条目：currentValue 原始字符串值可独立改，values 数组仍共享但本例不改它。
			items.map((item) => ({ ...item })),
			// 可见项上限 10，不含搜索行/提示。
			10,
			// 使用恒等主题。
			testTheme,
			// onChange 回调接收 id/value、push 一条记录；push 的返回长度由 void 签名调用方忽略，不回传给列表做索引。
			(id, value) => changes.push({ id, value }),
			// 无参取消回调空实现，返回 undefined/无副作用；本用例不测关闭界面。
			() => {},
			// 显式启用搜索，构造会创建内部 Input，不注册真实键盘监听。
			{ enableSearch: true },
		);

		// for...of 逐码点喂 TUI mode，空格到达时已有 TUI 搜索词，所以应插入搜索而非激活值。
		for (const character of "TUI mode") list.handleInput(character);

		// 逐字输入完成后变化记录必须仍空。
		assert.deepStrictEqual(changes, []);
		// 首渲染行是搜索 Input，?? 空串保护缺项；匹配 TUI mode 证明查询保留了中间空格，不是单看列表标签。
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		// CR 是默认 Enter 提交/确认编码，在有搜索词时仍可激活当前项。
		list.handleInput("\r");
		// 一次循环到 fullscreen，通知对象 id/value 和条数都应精确一致。
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	// 空搜索例：还没输入文字就按 Space，保留修改快捷键语义，不往搜索框插一个空格。
	it("keeps Space as a change shortcut before a search query is entered", () => {
		// 本用例独立的通知数组。
		const changes: Array<{ id: string; value: string }> = [];
		// 构造新的可搜索列表，与前一用例状态分离。
		const list = new SettingsList(
			// 再逐项浅复制，避免上一回 currentValue 影响默认初值。
			items.map((item) => ({ ...item })),
			// 可见项上限 10。
			10,
			// 使用同一只读用法的恒等主题对象。
			testTheme,
			// 变化回调同步追加当前项 id 与新值，回调返回值未被列表使用。
			(id, value) => changes.push({ id, value }),
			// 取消无操作，不关闭任何真实组件。
			() => {},
			// 启用搜索但初始查询仍空。
			{ enableSearch: true },
		);

		// 一次发送空格字符，走“查询为空则激活”分支。
		list.handleInput(" ");

		// 期望只收到 regular→fullscreen 的一次修改通知。
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	// #7629 翻页例：页长 5，末页夹到 11，再上页到 6；这些条目没有 values/submenu，所以只测选中位置不改设置。
	it("moves by one visible page with selection page keys (#7629)", () => {
		// 构造局部无搜索列表，省略 options 沿用默认关闭搜索。
		const list = new SettingsList(
			// Array.from 生成 12 项，回调忽略占位参数 _，以 0 基 index 为各项身份。
			Array.from({ length: 12 }, (_, index) => ({
				// 模板生成唯一 id，不访问配置存储。
				id: `setting-${index}`,
				// 展示 label 供后面的 > Setting N 正则定位。
				label: `Setting ${index}`,
				// currentValue 为 index 的字符串形式，String 与类型断言不同，会实际转换数值。
				currentValue: String(index),
			})),
			// maxVisible=5 作为翻页步长，不是界面总行数。
			5,
			// 主题用固定 > 前缀。
			testTheme,
			// 修改回调空实现，本用例不期待改值。
			() => {},
			// 取消回调也无操作。
			() => {},
		);

		// ESC[6~ 为 PageDown 样本，由共享可配置键位解析，不是真往 stdin 发送。
		list.handleInput("\x1b[6~");
		// render 后用 LF 连接测试行，查选中标记位于 Setting 5。
		assert.match(list.render(80).join("\n"), /> Setting 5/);
		// 再 PageDown，从 5 到 10。
		list.handleInput("\x1b[6~");
		// 再 PageDown，夹到末下标 11，不循环回 0。
		list.handleInput("\x1b[6~");
		// 渲染当前标记应在 Setting 11。
		assert.match(list.render(80).join("\n"), /> Setting 11/);
		// ESC[5~ 为 PageUp，向前减 5。
		list.handleInput("\x1b[5~");
		// 预期选中 Setting 6，非简单跳首项。
		assert.match(list.render(80).join("\n"), /> Setting 6/);
	});
});
