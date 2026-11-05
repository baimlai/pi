// 将按API分组的目录摊成按模型ID索引的表，并通过TS映射类型保留ID/API/提供商字面量。生成的providers/*.models.ts会调用这些手写函数；本文件不生成/读文件、不访问模型服务。
// 类型按chat:id等键名推断，运行代码却按模型对象的type/id读取；两者一致依赖目录输入约定，不由as自动验证。
// 只导入类型，运行时不加载完整模型实现或注册Provider。
import type {
	// 聊天API名的类型，允许已知和自定义协议字符串。
	Api,
	// 分类API名，与聊天/图片入口概念分开。
	ClassifierApi,
	// 分类模型的完整静态形状，包含type=classifier。
	ClassifierModel,
	// 图片生成API类型，不等于聊天模型支持图片输入。
	ImageApi,
	// 图片模型形状，包含type=image和输出模态。
	ImageModel,
	// 聊天模型泛型类型，具体API会影响部分兼容选项字段。
	Model,
	// chat/image/classifier种类联合，类型本身不是运行时枚举。
	ModelType,
	// 提供商ID可为自定义字符串，并非固定白名单。
	ProviderId,
} from "./types.ts";

// 两层Record：外层API名→内层目录键→object。object只排除TS原始值，不保证对象有id/type/provider，数组/函数也可满足object。
export type ModelGroups = Record<string, Record<string, object>>;

// 提取所有API组中的目录键联合；例分组内chat:m和image:p得到这两个键，不读取每个模型的id字段。
type ModelKey<TGroups extends ModelGroups> = {
	// 映射类型逐外层API键产出该组keyof，即内层键的联合；这是编译期计算，不是for循环。
	[TApi in keyof TGroups]: keyof TGroups[TApi];
	// 再用全部外层键索引这份映射，把每组键合成联合。
}[keyof TGroups] &
	// 与string取交集，剔除纯数字/symbol键类型，供后面模板字面量匹配。
	string;

// 按种类过滤目录键，Extract是TS内置条件类型；例chat:m保留给chat、image:p排除，不是运行时filter。
type KeyForType<TGroups extends ModelGroups, TType extends ModelType> = Extract<
	// 候选集合是前面算出的所有字符串键。
	ModelKey<TGroups>,
	// 模板字面量类型要求以当前种类加冒号开头，后面允许任意字符串，甚至空ID。
	`${TType}:${string}`
>;

// 条件类型从合法种类前缀后的部分infer出模型ID；例chat:a:b得到a:b，非匹配键为never。冒号只用于类型约定，不在运行时解析键。
type ModelId<TKey extends string> = TKey extends `${ModelType}:${infer TModelId}` ? TModelId : never;

// 反向找包含某目录键的API组名联合；同键若存在两个组，结果可能含两个API名，不强制唯一。
type ApiForKey<TGroups extends ModelGroups, TKey extends ModelKey<TGroups>> = {
	// 逐组检查TKey是否属于该组keyof，是则保留TApi，否则用never让该分支从联合中消失。
	[TApi in keyof TGroups]: TKey extends keyof TGroups[TApi] ? TApi : never;
	// 用全部API键索引映射，取得各组检查结果的联合。
}[keyof TGroups];

// 聊天目录类型：只选chat:键，把键重映射为去前缀ID；例如chat:m变结果表的m属性，不是生成运行对象。
export type ChatModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	// 映射中的as是类型键重命名；Model选择该键所在API，& Api协调泛型约束，末尾&再叠加更窄id/provider。
	[TKey in KeyForType<TGroups, "chat"> as ModelId<TKey>]: Model<ApiForKey<TGroups, TKey> & Api> & {
		// 把Model原本string的id进一步约束成从键名提取的字面量。
		id: ModelId<TKey>;
		// 把provider进一步约束成调用者传入的泛型ID；不会运行赋值。
		provider: TProvider;
	};
};

// 图片目录同样按image:键重映射ID，并用图片模型形状，不能仅靠聊天模型input含image混入。
export type ImageModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	// ImageModel接从外层组名推出的API，末尾交叉类型缩窄身份字段；原组内模型其他字段不逐项复制到类型。
	[TKey in KeyForType<TGroups, "image"> as ModelId<TKey>]: ImageModel<ApiForKey<TGroups, TKey> & ImageApi> & {
		// 图片id来自目录键后缀，不由对象id文字直接推断。
		id: ModelId<TKey>;
		// 图片provider沿传入TProvider作为静态视图。
		provider: TProvider;
	};
};

// 分类目录按classifier:键提取；例classifier:label映为label属性，值为分类模型与精确身份的交叉。
export type ClassifierModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	// 开始映射键与ClassifierModel泛型，后续多行仍是同一个类型表达式。
	[TKey in KeyForType<TGroups, "classifier"> as ModelId<TKey>]: ClassifierModel<
		// 分类API来自该键所在组，与ClassifierApi交集满足泛型要求，不检查远端能力。
		ApiForKey<TGroups, TKey> & ClassifierApi
		// 关闭泛型后与下面身份对象取交集，不是合并运行时对象。
	> & {
		// 分类ID缩窄成模型键后缀字面量。
		id: ModelId<TKey>;
		// 分类provider缩窄为调用者的TProvider。
		provider: TProvider;
	};
};

// 内部摊平器：接分组及种类，返回新ID→原模型引用表；例包含type:chat/id:m的对象可进入chat结果。
// 先取各组值→压平所有模型→严格筛type→按对象id组表，同ID后者覆盖前者；不改输入顶层/模型，也不补写provider/api。
// 缺type的聊天模型虽在通用Model类型中合法，这个入口仍会过滤掉它；字段getter或不合约输入可能抛错，未作完整schema校验。
function flattenModelCatalog(groups: ModelGroups, type: ModelType): Record<string, object> {
	// Object.fromEntries构造普通新对象，键采用下方map结果；重复键由后出现项覆盖，模型对象引用复用。
	return Object.fromEntries(
		// 只取外层可枚举自有字符串键对应的组值，API键名自身不传进后续运行计算。
		Object.values(groups)
			// 每组再取可枚举自有值，flatMap压平一层；不会根据内层chat:id键拆模型ID。
			.flatMap((models) => Object.values(models))
			// as允许读可选未知type，实际===才作种类筛选；不借isModelType把缺type当默认chat。
			.filter((model) => (model as { type?: unknown }).type === type)
			// 每个保留模型组成[id,model]二元组；id仅断言为string，不验证/转换模型字段。对象保持同一引用。
			.map((model) => [(model as { id: string }).id, model]),
	);
}

// 生成聊天目录的公开包装，接provider文字和分组，返回精确映射类型；例flattenChatModelCatalog("p",groups)让结果m.provider静态为p。
// const泛型尽量保留调用处字面量；运行时_provider完全未读取，若对象provider写错不会替你修正，错误/副作用沿内部属性访问规则。
export function flattenChatModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	// 下划线名表明运行代码不使用；参数只让TS推导提供商字面量，不证明输入模型都属于它。
	_provider: TProvider,
	// 原分组对象传给内部摊平，不复制每个模型。
	groups: TGroups,
	// 返回类型由键名/API组/provider泛型计算，不能据此认定数据已验证。
): ChatModelCatalog<TGroups, TProvider> {
	// 真实运行只筛chat，as给结果一个更窄静态视图，不补字段或深复制。
	return flattenModelCatalog(groups, "chat") as ChatModelCatalog<TGroups, TProvider>;
}

// 图片目录公开包装：接提供商与分组，返回精确ImageModelCatalog；例image:p键在类型中变p。
// 仅按对象type=image运行筛选，不因传provider就变更图像模型归属；无文件/网络，属性读取异常直接传播。
export function flattenImageModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	// 提供商参数只参与类型推断，未被实现读写。
	_provider: TProvider,
	// 保留具体TGroups以推导图片键及所在API。
	groups: TGroups,
	// 函数同步返回新图片目录表，返回类型只描述结果形状，没有Promise等待。
): ImageModelCatalog<TGroups, TProvider> {
	// 内部摊平新建表、复用原对象；as不验证输出模态或图片API支持。
	return flattenModelCatalog(groups, "image") as ImageModelCatalog<TGroups, TProvider>;
}

// 分类目录公开包装：接provider/分组，返回ID索引分类表；例classifier:c在类型中变c。
// 运行只筛type=classifier，不执行分类、读取schema或注册API，输入对象属性错误仍可抛。
export function flattenClassifierModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	// 提供商仍只是泛型推导锚点，运行时未覆盖模型provider。
	_provider: TProvider,
	// 原始分组传入内部处理，const泛型不等于运行时Object.freeze。
	groups: TGroups,
	// 返回分类目录静态映射，类型推断和运行对象字段来自不同来源。
): ClassifierModelCatalog<TGroups, TProvider> {
	// 严格种类筛选后断言映射类型；返回表新建，条目共享。
	return flattenModelCatalog(groups, "classifier") as ClassifierModelCatalog<TGroups, TProvider>;
}
