// 测试适配层把 ModelRuntime 包装成旧 ModelRegistry 接口，并记录两者关系；创建时禁止联网刷新目录。
import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

// WeakMap 以 registry 对象为弱键关联 runtime，不使已无引用的 registry 仅因映射而常驻。
const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

// 接收已有运行时，构造注册表并记录关联后返回；例如 wrap(runtime) 可随后用 getModelRuntime 取回。
// 本函数不创建目录或联网；构造器/内存分配异常原样传播。
function wrap(runtime: ModelRuntime): ModelRegistry {
	// new ModelRegistry 只包装同一个 runtime，不复制其中模型数据。
	const registry = new ModelRegistry(runtime);
	// set 把这次创建的 registry 作为键，runtime 作为值。
	runtimes.set(registry, runtime);
	// 返回包装对象，调用者继续使用注册表 API。
	return registry;
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
// 接收凭证存储和可选 models.json 路径，异步返回注册表；先创建运行时再包装。
// 例：传自建临时 models.json 会读取该配置，但目录缓存使用内存后端；未传路径仍可能读默认配置。
// allowModelNetwork:false 约束本次创建的目录刷新，不代表今后显式调用所有方法都无法联网；读取/创建异常传播。
export async function createModelRegistry(credentials: CredentialStore, modelsPath?: string): Promise<ModelRegistry> {
	// return wrap 的实参先 await，因此创建完成后才建立 WeakMap 关系。
	return wrap(
		// ModelRuntime.create 返回 Promise；这里传入各项测试依赖。
		await ModelRuntime.create({
			// 属性简写 credentials 等于 credentials: credentials，保留同一个凭证存储实例。
			credentials,
			// modelsPath 为 undefined 使用运行时默认配置路径，字符串则使用指定文件。
			modelsPath,
			// 显式注入纯内存目录缓存，避免文件缓存锁；并不屏蔽 models.json 读取。
			modelsStore: new InMemoryCodingAgentModelsStore(),
			// 创建阶段不主动从网络更新模型目录。
			allowModelNetwork: false,
		}),
	);
}

// 接收凭证存储，返回不读 models.json 的注册表；例：测试仅用内置目录，无模型配置文件 I/O。
// modelsPath:null 还使默认目录存储走内存；凭证本身是否持久化由调用者提供的实现决定，异常仍传播。
export async function createInMemoryModelRegistry(credentials: CredentialStore): Promise<ModelRegistry> {
	// await 先完成运行时初始化；null 是主动禁用配置文件，区别于不传路径。
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false }));
}

// 按辅助函数创建的注册表取回同一运行时，无 I/O；外部自行构造的表会抛错。
// 例：getModelRuntime(await createInMemoryModelRegistry(store)) 可取得用于测试的 runtime。
export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	// WeakMap.get 可能得到 undefined，因此静态类型是 ModelRuntime | undefined。
	const runtime = runtimes.get(modelRegistry);
	// 这里检查的是辅助层登记关系，不验证 ModelRegistry 对象结构；未登记立即给出明确错误。
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	// 经过上面的真值分支后 TS 已收窄为 ModelRuntime，原引用直接返回。
	return runtime;
}
