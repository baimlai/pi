// 集中保存 coding-agent 的思考档位默认值和选择顺序；CLI、会话和界面共同使用，实际支持范围仍由模型能力决定。
// import type 只提供编译期类型，不在运行时创建 ThinkingLevel 对象。
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// 显式标注联合类型，防止把默认值写成不存在的档位；这个 medium 不代表每个模型都支持相同思考方式。
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
// readonly 限制通过此数组类型修改元素/长度，不等同于 Object.freeze；下面的顺序用于候选展示和档位比较。
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	// 不请求额外思考；off 是非空字符串，if(level) 仍会把它视为真值。
	"off",
	// 最低的非关闭档位；具体 token/参数映射交给供应商实现。
	"minimal",
	// 低档位。
	"low",
	// 中档位，也是上面的共享默认值。
	"medium",
	// 高档位。
	"high",
	// 额外高档位；不能因这里列出就假定任意模型可用。
	"xhigh",
	// 最大档位；后续能力钳制可能改为模型支持的较低档位。
	"max",
];
