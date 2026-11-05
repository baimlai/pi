// 这是选择性导入的浏览器打包入口：保留 Agent 和一家供应商，检查无关 SDK/全量目录是否被带入。
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
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
