/**
 * Tools Configuration
 *
 * Use tool names to choose which built-in tools are enabled.
 *
 * Tool names are matched against all available tools. If you use a custom `cwd`,
 * createAgentSession() applies that cwd when it builds the actual built-in tools.
 *
 * For custom tools, see 06-extensions.ts - custom tools are registered via the
 * extensions system using pi.registerTool().
 *
 * 文件导读
 *
 * 所属：packages/coding-agent/examples/sdk，SDK 示例系列第 05 个。上游由
 * `node examples/sdk/05-tools.ts` 直接运行（需先构建工作区）；下游通过 createAgentSession 的
 * tools 选项选择启用的工具，工具本身由 coding-agent 内置工厂按 cwd 构造。
 *
 * 演示什么：tools 数组是工具选择规则。只含普通名字时是允许名单，只启用列出的内置/扩展/自定义
 * 工具；名字可含 * 通配符。若整个数组只含 +name/-name，它表示在默认工具上增删而不是允许名单，
 * 且不能与普通名字混用。该选项也影响 MCP 工具是否保留（见 14-codemode-mcp.ts）。自定义工具
 * 应通过扩展注册，参见 06-extensions.ts。本示例只创建会话再释放，不运行模型、不执行工具。
 *
 * 能力清单（按演示场景）：
 * - 只读会话：tools 仅包含 read/grep/find/ls，不含 edit/write/bash。
 * - 自定义集合：tools 选择 read/bash/grep，演示任意允许名单。
 * - 自定义 cwd：会话、内存历史与内置工具都绑定到同一目录。
 * - 自定义 cwd + 精确工具：组合前两类行为。
 *
 * 典型运行顺序与预期输出：
 *   1. 运行脚本；依次打印四行 “... session created”。
 *   2. 每次创建后立即 dispose，没有模型调用，也不会写会话文件。
 *   3. `/path/to/project` 是占位路径；若不替换，创建会话可能仍成功，但后续工具在该目录工作，
 *      实际使用时需要换成真实存在的路径。
 *
 * 示例（真实签名）：
 *   const { session } = await createAgentSession({
 *     tools: ["read", "grep"],
 *     sessionManager: SessionManager.inMemory(),
 *   });
 *   只启用 read 和 grep；未列出的内置工具不会出现在模型工具表中。
 *
 * 建议阅读顺序：先看第一个只读允许名单，再对比第二组的任意子集，最后看 cwd 如何同时传给
 * createAgentSession 与 SessionManager.inMemory。
 */

// 只需要装配函数和历史管理器；工具名是字符串，不需要导入工具类型。
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Read-only mode (no edit/write)
// 允许名单模式：四个只读工具；没有 bash/edit/write，模型只能观察而不能改文件或执行命令。
const { session: readOnlySession } = await createAgentSession({
	tools: ["read", "grep", "find", "ls"],
	// 内存历史不落盘，适合演示/测试。
	sessionManager: SessionManager.inMemory(),
});
console.log("Read-only session created");
// 释放会话；工具定义本身不持有需要额外关闭的进程。
readOnlySession.dispose();

// Custom tool selection
// 另一组允许名单：bash 会启动子进程，read/grep 读取文件；未列出的 edit/write 被禁用。
const { session: customToolsSession } = await createAgentSession({
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(),
});
console.log("Custom tools session created");
customToolsSession.dispose();

// With custom cwd
// 占位目录：换成真实项目路径后，read 等相对路径和默认资源发现都以它为基准。
const customCwd = "/path/to/project";
const { session: customCwdSession } = await createAgentSession({
	// 显式 cwd 优先于进程 cwd；内置工具工厂按这个目录构造。
	cwd: customCwd,
	// 显式列出四个默认编码工具（这也是未设置 defaultTools 时的默认集合）。
	tools: ["read", "bash", "edit", "write"],
	// 历史管理器也使用同一 cwd，避免会话元数据与工具目录不一致。
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Custom cwd session created");
customCwdSession.dispose();

// Or pick specific tools for custom cwd
// 同样的 cwd 配不同允许名单，说明工具选择和目录绑定相互独立。
const { session: specificToolsSession } = await createAgentSession({
	cwd: customCwd,
	tools: ["read", "bash", "grep"],
	sessionManager: SessionManager.inMemory(customCwd),
});
console.log("Specific tools with custom cwd session created");
specificToolsSession.dispose();
