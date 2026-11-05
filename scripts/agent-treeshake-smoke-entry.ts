// 文件导读
// 所属：仓库根 scripts/ 下的浏览器冒烟入口，由 scripts/check-browser-smoke.mjs 作为 esbuild 输入打包。
// 职责：只导入 Agent 核心与 Anthropic 一家供应商，验证按需导入不会把兼容层、全量模型目录和其他供应商 SDK 带进浏览器包。
// 边界：这里不是可运行的演示程序。check-browser-smoke.mjs 只打包并检查 esbuild 的 metafile，不执行生成的 JS，
//   因此模块级代码不会发出模型请求，也不会真的启动 Agent。
// 上游入口：根 package.json 的 npm run check:browser-smoke（也被 npm run check 串联）→ scripts/check-browser-smoke.mjs。
// 下游依赖：@earendil-works/pi-agent-core、@earendil-works/pi-ai 以及 pi-ai 的 anthropic 供应商子路径。
// 能力清单：唯一的导出 agent 是一个 Agent 实例；模块加载时会创建内存模型集合、注册 Anthropic 供应商并解析一次模型。
// 副作用与失败：若供应商目录里没有 claude-sonnet-4-5，加载本模块就抛错；打包阶段会报错，而不是运行时失败。
// 典型调用：不直接 node 运行；运行 npm run check:browser-smoke，脚本随后断言产物只含 anthropic.json 和 @anthropic-ai/sdk。
// 示例（与真实签名一致）：
//   const models = createModels();
//   models.setProvider(anthropicProvider());
//   const model = models.getModel("anthropic", "claude-sonnet-4-5");
//   export const agent = new Agent({ initialState: { model }, streamFn: models.streamSimple.bind(models) });
// 真实运行时行为：上面只构造对象；只有调用 agent.prompt 等入口时才走 streamSimple。
// 建议阅读顺序：先看 createModels/setProvider/getModel 三步，再看 Agent 构造，最后对照 check-browser-smoke.mjs 的断言。
// 这是选择性导入的浏览器打包入口：保留 Agent 和一家供应商，检查无关 SDK/全量目录是否被带入。
import { Agent } from "@earendil-works/pi-agent-core";
// createModels 来自 pi-ai 根入口，负责创建模型集合；此处只取集合工厂，不取具体供应商实现。
import { createModels } from "@earendil-works/pi-ai";
// 供应商子路径是独立模块：打包器只能沿这条 import 拉入 Anthropic 相关代码。
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

// 创建空的模型集合，默认用内存存储；此时没有供应商，也未解析认证。
const models = createModels();
// 只注册 Anthropic 的目录、认证策略与延迟流工厂，使其他供应商有机会被打包器剔除。
models.setProvider(anthropicProvider());
// 同步按供应商和 id 找聊天模型，结果类型含 undefined；这里不向服务器查模型。
const model = models.getModel("anthropic", "claude-sonnet-4-5");
// 运行时缺目录项便抛错；通过分支后，TypeScript 将 model 收窄为已找到的模型。
if (!model) throw new Error("Anthropic smoke-test model not found");

// 导出实例让入口保持可达；例如浏览器打包时检查它是否只带上 Anthropic SDK/目录。构造不发聊天请求。
export const agent = new Agent({
	// 属性简写将上述模型放入初始状态，值等同 model: model。
	initialState: { model },
	// bind 固定方法中的 this 为 models；以后 Agent 请求时才调用它，本入口未调用 prompt。
	streamFn: models.streamSimple.bind(models),
});
// 文件到这里结束：没有顶层调用，所以即使被 Node 执行也只会构造这些对象，不会发起网络请求。
