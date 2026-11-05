// The greeter plugin's server facet: serves `Greeting` with the text of `label.ts`.

import { constant, defineFacet, local, str } from "@earendil-works/chord";
import { greeting } from "./label.ts";

// local 只供本主机访问，空 params 使对象具有主机生命周期；text 值由工厂提供。
const Greeting = local("example.greeting", { version: 1, params: {}, members: { text: str() } });

// setup 输入 host，只登记工厂；无参数工厂把导入的文本包装成常量状态，返回成员对象，无 I/O。
// 例如第一代引用读到原问候语；label 语法坏掉时构建会失败，setup 根本不会执行，旧代码保留。
export default defineFacet((host) => host.serve(Greeting, () => ({ text: constant(greeting) })));
