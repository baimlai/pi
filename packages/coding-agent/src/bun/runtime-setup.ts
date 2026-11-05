// Bun构建入口的模块级适配：静态带上Node/AWS实现、OAuth工厂与WASM文件路径，使编译器能打进二进制。
// 这里不是普通按需导出的工具库，import就会执行底部设置；不要为了看函数返回而直接在Node加载本文件。
// bedrockProviderModule保存stream函数引用，静态导入可能加载SDK依赖图，但这行不调用模型。
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
// 静态OAuth实现注册入口：稍后登记工厂表，不自动login/refresh或打开浏览器。
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
// 从兼容出口取Bedrock覆盖setter；compat的模块图本身会注册默认API等，不能当只导入一个纯类型。
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
// Bun默认.wasm加载器返回可读路径字符串，编译时文件嵌入产物；不是此处已实例化的WebAssembly模块。
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
// APP_NAME来自统一配置；setter只缓存嵌入WASM路径，后续codemode按需读/编译。
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

// 模块求值时改进程title，供进程列表识别，不修改APP_NAME常量。
process.title = APP_NAME;
// 把emitWarning整体替成空箭头；as保留原函数类型视图，但运行时会抑制此进程所有经该入口发的warning，未保存旧函数。
process.emitWarning = (() => {}) as typeof process.emitWarning;
// 登记静态OAuth工厂表，覆盖此前整表；不在这里执行各工厂或验证凭据。
registerBunOAuthFlows();
// 保存静态Bedrock流实现作共享覆盖，避免Bun打包器追不到变量动态import；不终止已有流。
setBedrockProviderModule(bedrockProviderModule);
// 缓存WASM路径供config.getQuickJSWasmPath复用，不在这里读文件/编译VM/执行脚本。
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
