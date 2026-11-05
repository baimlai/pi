// TypeSafe分类供应商装配：组合分类模型目录、API key认证和System One延迟实现，供builtinProviders登记；构造时不发送分类请求。
// 导入分类lazy工厂，返回带classify的对象；调用classify时才导入实现并返回Promise，不是聊天token事件流。
import { typesafeSystemOneApi } from "../api/typesafe-system-one.lazy.ts";
// 通用key认证器只登记来源，实际请求材料由Models认证流程或直接调用方提供。
import { envApiKeyAuth } from "../auth/helpers.ts";
// createProvider是运行时装配函数；type Provider只作TS接口检查，不是要用new实例化的Provider类。
import { createProvider, type Provider } from "../models.ts";
// 只导入生成目录里的分类表，没有把同文件导出的聊天/图片表也装进来；目录更新应走catalog生成器。
import { TYPESAFE_CLASSIFIER_MODELS } from "./typesafe.models.ts";

// 无参数创建TypeSafe Provider，流程身份→key策略→分类目录→协议映射；返回Provider省略泛型会采用默认Api联合类型，不表示运行时真有聊天实现。
// 例p=typesafeProvider()后p.id为typesafe，p.getModels()仅筛聊天所以为空；p.getAllModels?.()才可查看这里装入的分类项。
// 每次新建外层对象/目录数组/延迟能力，模型条目仍共享；构造不读key、不登录或联网，装配错误同步传播，具体分类调用的异步失败由调用链处理。
export function typesafeProvider(): Provider {
	// 统一工厂允许只有classifiers实现而没有api聊天实现，仍会构造Provider；不能据存在stream方法就认定能聊天。
	return createProvider({
		// 供应商归属键为typesafe，和分类协议名、具体分类模型ID分开。
		id: "typesafe",
		// TypeSafe是展示名称，不在这里访问服务或核验返回概率。
		name: "TypeSafe",
		// auth嵌套对象登记认证方式，尚未解析存储凭证或环境来源。
		auth: {
			// 只配置TYPESAFE_API_KEY候选；真正resolve先用非空存储key再问宿主环境，login也不在这次构造中执行。
			apiKey: envApiKeyAuth("TypeSafe API key", ["TYPESAFE_API_KEY"]),
		},
		// 从分类表取值成新数组，保留原模型引用；没有Provider级baseUrl字段，分类模型自身的baseUrl仍随条目提供。
		models: Object.values(TYPESAFE_CLASSIFIER_MODELS),
		// classifiers按分类model.api映射到实现，与聊天api字段分开；统一工厂据非空映射暴露可选classify。
		classifiers: {
			// 字符串键选择typesafe-system-one协议，值是新建的延迟分类对象；这次工厂调用不执行classify、不查询答案。
			"typesafe-system-one": typesafeSystemOneApi(),
		},
	});
}
