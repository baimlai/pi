// 文件导读
// 所属包与目录：packages/chord/test/examples/36-plugin-failures/plugins/boot，示例插件 @example/boot 的 server facet。
// 演示什么：服务无身份参数、随宿主存活的 Boot 对象（成员 mode 是字符串状态）。main.ts 只在临时副本里向本文件
// 插入一个顶层 throw，用来演示“模块求值阶段抛错”；重载时这类插件保留旧代码并列入报告。
// 上游入口：main.ts 的 createPlugins 从临时根发现本目录，buildFacet 把本文件打成脚本，evaluateFacet 在宿主进程求值，
// 导出的 default facet 随后由 host.load/host.reload 的 setup 阶段同步执行。
// 下游依赖：@earendil-works/chord 的 constant/defineFacet/local/str。构建时该包保持 external，求值时由 main.ts 的
// modules 映射指向本进程的 Chord 实例。同目录 package.json 的 name 是插件身份，由 discoverPlugins 读取。
// 能力清单：Boot 契约（local、空 params、成员 mode: str）；default facet（登记一个返回固定标签的工厂）。
// 示例（真实签名）：const facet = defineFacet((host) => host.serve(Boot, () => ({ mode: constant(label) })));
// 单独不能运行；从 packages/chord 运行 main.ts。启动后 running 中的容器值是第一代标签；第 2 幕该插件的求值失败在
// 报告里显示为 "boot: config missing at boot/server.ts:21:7"（副本把 throw 插在本文件当前第 21 行；上方注释行数变化会
// 移动这个数字），修复并重载后变为下一代标签。
// 建议阅读顺序：导入 -> Boot 契约 -> default setup -> 工厂返回值。
// The boot plugin's server facet: serves `Boot`. The example makes this module throw while it is evaluated.

// constant 把固定 JSON 值包装成可观察常量；defineFacet 声明 facet；local/str 定义本地契约与字符串成员 schema。
import { constant, defineFacet, local, str } from "@earendil-works/chord";

// 本地、无身份参数的主机生命周期对象，mode 是字符串状态；应用声明的同名契约必须版本/指纹一致。
const Boot = local("example.boot", { version: 1, params: {}, members: { mode: str() } });

// setup 只登记工厂，工厂无输入业务数据，返回固定版本标签；无 I/O，也不捕获声明错误。
// 例如首次 mode.value 为第一代标签；main 在副本插入顶层 throw，模拟脚本求值失败而非工厂失败。
// defineFacet 只包装 setup，不执行它；host.serve 在 setup 期间登记提供者，工厂在对象激活时才运行。
// default 导出是构建后 evaluateFacet 检查的 facet 入口；factory 的 self 参数在这里不需要，所以省略。
export default defineFacet((host) => host.serve(Boot, () => ({ mode: constant("v1") })));
