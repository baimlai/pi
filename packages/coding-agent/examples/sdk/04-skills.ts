/**
 * Skills Configuration
 *
 * Skills provide specialized instructions loaded into the system prompt.
 * Discover, filter, merge, or replace them.
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 04 个。上游由
 * `node examples/sdk/04-skills.ts` 直接运行（需先构建工作区）；下游用
 * DefaultResourceLoader 的 skillsOverride 过滤/追加技能，再交给 createAgentSession。
 *
 * 演示什么：技能是带 name/description 的 Markdown 说明，模型在系统提示词的技能目录中看到
 * 元数据，需要时再读取正文。示例先构造一个虚拟 Skill，再在发现结果上过滤名字含 browser 或
 * search 的技能，并追加自定义技能，最后打印技能名和诊断。它不加载技能正文，也不发送模型
 * 请求；createAgentSession 之后立即 dispose。
 *
 * 能力清单（按调用顺序）：
 * - createSyntheticSourceInfo(path, { source })：为内存中构造的资源生成来源元信息。
 * - new DefaultResourceLoader({ skillsOverride })：在发现结果上改写技能列表。
 * - loader.reload()：执行发现与覆盖回调。
 * - loader.getSkills()：读取当前缓存的技能与诊断。
 * - createAgentSession({ resourceLoader, sessionManager })：用该技能集合装配会话。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；reload 会扫描 cwd/.pi/skills、~/.pi/agent/skills 等位置。
 *   2. stdout 打印 `Discovered skills: [ ... ]`，包含过滤后的技能和 my-skill。
 *   3. 若发现过程有警告，再打印 `Warnings: [ ... ]`。
 *   4. 创建会话后立即释放；没有模型请求，也不会写会话文件。
 *
 * 示例（真实签名）：
 *   const skill: Skill = {
 *     name: "release-notes",
 *     description: "Draft release notes",
 *     filePath: "/repo/.pi/skills/release-notes/SKILL.md",
 *     baseDir: "/repo/.pi/skills/release-notes",
 *     sourceInfo: createSyntheticSourceInfo("/repo/.pi/skills/release-notes/SKILL.md", { source: "custom" }),
 *     disableModelInvocation: false,
 *   };
 *   真实技能应指向存在的文件；本例的 /virtual 路径只用于展示元数据结构。
 *
 * 建议阅读顺序：先看 Skill 的字段和 createSyntheticSourceInfo，再看 skillsOverride 如何过滤/
 * 合并，最后看 getSkills 的返回值与会话装配。
 */

// 下面混用运行值导入与类型导入：type Skill 编译后擦除，其余函数/类在运行时存在。
import {
	createAgentSession,
	createSyntheticSourceInfo,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";

// Or define custom skills inline
// 直接构造 Skill 元数据；: Skill 是编译期形状检查，不会在运行时验证字段值或文件是否存在。
const customSkill: Skill = {
	// 技能标识；同名冲突时先接受的项保留，这里的名字不会与真实技能自动去重。
	name: "my-skill",
	// 供模型判断何时使用该技能的简短描述。
	description: "Custom project instructions",
	// 技能 Markdown 的绝对路径；本例不读取它，只作为元数据展示。
	filePath: "/virtual/SKILL.md",
	// 技能文件所在目录，用于解析技能正文中的相对资源路径。
	baseDir: "/virtual",
	// 生成来源信息：source 是调用方自定义标签，scope 默认 temporary，origin 默认 top-level。
	sourceInfo: createSyntheticSourceInfo("/virtual/SKILL.md", { source: "sdk" }),
	// false 表示允许模型在目录中自动选择该技能；true 则只能由用户显式调用。
	disableModelInvocation: false,
};

// 创建资源加载器；skillsOverride 接收本次发现的完整结果，返回替换后的技能与诊断。
const loader = new DefaultResourceLoader({
	// 项目资源发现位置。
	cwd: process.cwd(),
	// 用户级资源发现位置。
	agentDir: getAgentDir(),
	// current 包含 { skills, diagnostics }；这里按名字过滤，不修改原数组。
	skillsOverride: (current) => {
		// filter 生成新数组，保留名字含 browser 或 search 的技能；includes 区分大小写。
		const filteredSkills = current.skills.filter((s) => s.name.includes("browser") || s.name.includes("search"));
		// 返回新对象：先展开过滤后的技能，再追加自定义技能；diagnostics 原样保留。
		return {
			skills: [...filteredSkills, customSkill],
			diagnostics: current.diagnostics,
		};
	},
});
// 执行资源发现；只有 reload 之后 getSkills 才有覆盖后的结果。
await loader.reload();

// Discover all skills from cwd/.pi/skills, ~/.pi/agent/skills, etc.
// 解构重命名 skills 为 allSkills，避免与 customSkill 混淆；该结果已包含 override 的改动。
const { skills: allSkills, diagnostics } = loader.getSkills();
// map 生成技能名数组，不修改技能对象。
console.log(
	"Discovered skills:",
	allSkills.map((s) => s.name),
);
// 诊断是发现阶段的警告/错误说明；有内容时才打印，不代表技能全部失效。
if (diagnostics.length > 0) {
	console.log("Warnings:", diagnostics);
}

// 用同一个加载器装配会话；inMemory 历史避免落盘。此调用本身不发模型请求。
const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
// 提示会话已按过滤后的技能集合创建。
console.log("Session created with filtered skills");
// 立即释放，避免保留事件订阅；会话没有运行过，因此没有持久内容需要保存。
session.dispose();
