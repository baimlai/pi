// Google Vertex的手写延迟入口，供provider工厂引用；把重SDK依赖推迟到流方法调用，不是catalog生成产物。
// ProviderStreams只作编译期能力契约：stream/streamSimple同步返回事件流，不因此加载SDK。
import type { ProviderStreams } from "../types.ts";
// lazyApi是运行值，负责调用时加载实现并把异步加载失败转换为流中的error消息。
import { lazyApi } from "./lazy.ts";

/**
 * 创建Google Vertex的延迟聊天适配对象，输入无参数，返回ProviderStreams；构造本身不发请求或导入该协议实现。
 * 例：const api=googleVertexApi()先取得能力，api.stream(model,ctx,opts)才立即启动实现加载，再转交原参数；不等for await才开始。
 * 返回对象默认仅暴露stream/streamSimple，未显式启用deferred能力；加载/转发失败走外层流error结果，不能把result()完成当作业务成功。
 */
// 箭头函数调用lazyApi时仅登记加载闭包；内部import()等到某个流方法调用才执行，返回模块Promise，宿主模块缓存负责复用。
export const googleVertexApi = (): ProviderStreams => lazyApi(() => import("./google-vertex.ts"));
