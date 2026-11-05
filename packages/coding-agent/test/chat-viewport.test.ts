// 只构造聊天组件树，核对滚动条选项；不启动真实 TUI、不渲染屏幕。
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

// 注册聊天布局测试；回调没有输入和返回结果，实际失败由断言报告。
describe("chat viewport", () => {
	// 比较缺省配置和显式 hidden；例：不传 scrollbar 时应得到 auto。
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		// 五个空 Container 满足布局的必填区域，构造过程只保存内存中的组件引用。
		const automatic = createChatViewport({
			// document 是可滚动记录内容。
			document: new Container(),
			// 以下四个区域组成固定输入 dock，而不是 transcript 的滚动内容。
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		// 新建另一套独立容器，只额外指定滚动条隐藏策略。
		const hidden = createChatViewport({
			// 每次 new 都创建新实例，两个视口并不共享空区域对象。
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			// 字符串字面量属于 ScrollViewScrollbar 联合类型，TS 会拒绝拼错的其他值。
			scrollbar: "hidden",
		});

		// 只检查暴露句柄的策略字段，没有证明交互后滚动条何时显示。
		expect(automatic.transcript.scrollbar).toBe("auto");
		// 显式值应覆盖 createChatViewport 的 auto 缺省。
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});
});
