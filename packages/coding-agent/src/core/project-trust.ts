// 把项目资源是否可信的多个来源汇成一个布尔决定；main/资源加载器据此决定是否加载项目设置和资源。
// 这里会询问扩展或 UI，并可保存决定；信任开关不是对扩展或包安装的执行沙箱。
// 导入运行时应用名和项目配置目录名，用于提示文字，不在这里硬编码安装位置。
import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
// 这是实际会执行的事件分发函数；扩展可通过 project_trust 返回信任决定。
import { emitProjectTrustEvent } from "./extensions/runner.ts";
// import type 只提供编译期契约，运行 JavaScript 时不会因这行加载这些类型。
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
// 共享默认配置；?? 会在调用方没有明确设置时读取其中的 ask。
import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
// 该类型约束 ask/always/never 三种策略，本身不读取设置文件。
import type { DefaultProjectTrust } from "./settings-manager.ts";
// 同一导入中既有运行时辅助函数，也有 type 标记的纯类型。
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

// 字符串字面量联合限制应用模式；export type 只导出类型，不生成模式枚举对象。
export type AppMode = "interactive" | "print" | "json" | "rpc";

// 一次信任判定的输入：路径、存储、可选覆盖策略，以及宿主提供的扩展/UI上下文。
export interface ResolveProjectTrustedOptions {
	// 需要判定的工作目录；实际归一化和父目录继承由 trustStore 负责。
	cwd: string;
	// 保存和查询 trust.json 的实例，不是把决定直接存在本 options 对象里。
	trustStore: ProjectTrustStore;
	// ? 允许省略；显式 false 是有效的最高优先级覆盖，不能用真值判断把它丢掉。
	trustOverride?: boolean;
	// 调用方传来的全局默认策略；省略时使用共享默认值。
	defaultProjectTrust?: DefaultProjectTrust;
	// 此前已加载的扩展及加载结果；没有该项就不发扩展信任事件。
	extensionsResult?: LoadExtensionsResult;
	// 包含 hasUI、ui 和运行环境的上下文；本函数不自行创建终端界面。
	projectTrustContext: ProjectTrustContext;
	// 可选回调类型；接收扩展错误文字，返回 void，调用它不代表错误被永久保存。
	onExtensionError?: (message: string) => void;
}

/**
 * 组装带目录和权限说明的询问文字，返回字符串，不执行授权。
 * 例：cwd=/repo 时，提示包含 /repo 及加载设置、安装缺包、运行扩展的说明。这里只插入已有字符串，不读取路径或文件。
 */
function formatProjectTrustPrompt(cwd: string): string {
	// 模板字面量把变量放进提示文本；\n 是实际换行，文字仍保留原英语。
	return `Trust project folder?\n${cwd}\n\nThis allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`;
}

/**
 * 显示目录信任选项，返回被选中的完整选项；取消或无法匹配文字时返回 undefined。
 * 先构造含本次会话选项的列表，再 await 宿主选择框，再按标签查回对象。例：选 Trust (this session only)，updates 为空，不写磁盘。
 */
async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	// 第二参数是对象字面量；includeSessionOnly:true 额外给出不持久化的两个选项。
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	// await 等选择框完成；UI Promise 的异常没有在此吞掉，会向调用者传播。
	const selected = await ctx.ui.select(
		// 第一个参数为问题文字，按当前 cwd 构造。
		formatProjectTrustPrompt(cwd),
		// map 把选项对象数组映射成标签数组；箭头函数从每个 option 中取 label。
		options.map((option) => option.label),
	);
	// find 取第一个标签完全相等的项；取消返回值通常匹配不到，于是结果 undefined。
	return options.find((option) => option.label === selected);
}

/**
 * 仅在选项含持久化更新时写信任库；函数无返回值，文件/锁错误直接传出。
 * 例：Trust parent folder 同时保存父目录 true 并清除当前目录独立决定；会话选项 updates=[] 则什么也不写。
 */
function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	// 数组 length 大于 0 才需要加锁读改写；空列表对应本次会话决定。
	if (result.updates.length > 0) {
		// 把整批更新交给同一锁内的 setMany，避免把一个选项拆成多个独立读改写。
		trustStore.setMany(result.updates);
	}
}

/**
 * 按覆盖值→无受控资源时的已存决定/默认信任→扩展→已存决定→默认策略→UI 的顺序判定。
 * 输入 options，返回 Promise<boolean>；true 只表示宿主可按此决定加载资源，不验证资源内容安全。
 * 例：目录仅有 AGENTS.md，没有受控资源且无已存拒绝时直接 true；有 .pi/settings.json 且无 UI、无其他决定时 ask 会返回 false。
 * 扩展结果可选择 remember 写文件；存储、UI、错误回调自身抛出的异常会传出。
 */
export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	// 只与 undefined 比较，因此 trustOverride:false 也能进入此分支。
	if (options.trustOverride !== undefined) {
		// 调用方的明确覆盖直接决定本次结果，不查文件、不问扩展、不保存。
		return options.trustOverride;
	}
	// 只检测受信任开关控制的项目资源；AGENTS.md 单独存在不在这个检测列表里。
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		// 没有受控资源仍尊重已保存的 false；?? 仅在 null/undefined 时选 true。
		return options.trustStore.get(options.cwd) ?? true;
	}

	// 提供了扩展加载结果才尝试事件；本分支在读取已保存决定之前执行。
	if (options.extensionsResult) {
		// 对象解构一次拿到扩展决定和收集的错误；await 等事件处理完成。
		const { result, errors } = await emitProjectTrustEvent(
			// 传入本次可用于事件处理的扩展集合。
			options.extensionsResult,
			// 事件用 type 标签标明 project_trust，并携带原工作目录。
			{ type: "project_trust", cwd: options.cwd },
			// 宿主上下文使处理器能够访问受限于该接口的 UI/运行信息。
			options.projectTrustContext,
		);
		// 逐条报告扩展处理错误；错误不必然意味着所有扩展都没有决定。
		for (const error of errors) {
			// ?.() 只在回调存在时调用；回调自身异常不在这里捕获。
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		// 有明确扩展结果就采用；没有结果才继续后面的存储和默认策略。
		if (result) {
			// 把 yes/no 协议值转换为布尔；此处不是对任意外部 JSON 的完整校验。
			const trusted = result.trusted === "yes";
			// 只有显式 remember:true 才持久化，省略不等于 true。
			if (result.remember === true) {
				// 保存当前目录决定，后续查询其子目录时可继承。
				options.trustStore.set(options.cwd, trusted);
			}
			// 无论是否记住，本次都返回扩展给出的决定。
			return trusted;
		}
	}

	// 没有扩展决定时，加锁查询当前目录或最近祖先的已存决定。
	const decision = options.trustStore.get(options.cwd);
	// null 表示没有决定；false 仍是决定，必须返回而不能继续询问。
	if (decision !== null) {
		// 直接采用持久化的同意或拒绝。
		return decision;
	}

	// ?? 只对空缺默认策略回退；switch 根据字符串字面量选择路径。
	switch (options.defaultProjectTrust ?? SETTINGS_DEFAULTS.defaultProjectTrust) {
		// always 表示本次自动同意，并不在此写入 trust.json。
		case "always":
			// 自动信任的返回结果。
			return true;
		// never 表示本次自动拒绝，也不改已有信任文件。
		case "never":
			// 自动拒绝的返回结果。
			return false;
		// ask 把执行权交给后面的界面逻辑。
		case "ask":
			// break 退出 switch，不是退出函数；后面仍检查 UI。
			break;
	}

	// 需要询问但没有交互 UI 时，不尝试等待无法展示的选择框。
	if (!options.projectTrustContext.hasUI) {
		// 没有其他授权来源且不能询问，按拒绝处理。
		return false;
	}

	// 等待用户选择；此前扩展和存储均没有提供决定才到这里。
	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	// 非 undefined 说明找到了选项，不能仅根据 trusted 真值判定是否有选择。
	if (selected !== undefined) {
		// 持久化型选项先写库；本次会话型选项不写。若写库失败，不会假装已成功返回。
		saveProjectTrustPromptResult(options.trustStore, selected);
		// 选 Do not trust 也会正常返回其 false。
		return selected.trusted;
	}
	// 取消选择、返回未知标签都按本次拒绝处理，不新存决定。
	return false;
}
