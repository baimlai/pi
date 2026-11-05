// 文件导读
// 所属：packages/chord/test/examples/39-browser-build/plugins/gallery，gallery 插件的浏览器 facet（web.ts）。
// 作用：演示浏览器构建的两类非代码输入：副作用导入的 gallery.css 被收集进构建的 css 字段；`./assets/logo.svg?url`
// 被处理成内容哈希资源，导入值是 publicPath（本示例 "/plugin-assets/"）下的 URL 字符串。这个字符串在构建时写进
// 脚本，所以页面拿到的是可服务的地址，而不是文件系统路径。
// 同目录 package.json 提供插件名 @example/gallery；发现阶段读取清单的 name，39/main.ts 用这个名字读取构建元数据。
// 上游：插件组件的 discover/build/evaluate；下游：@earendil-works/chord 的 defineFacet/constant/local/str，
// 以及构建器对 .css 和 ?url 的处理。输出：一个服务 example.gallery 的 facet，成员 logo: str() 是资源 URL。
// 能力清单：
// - Gallery：本插件声明的 local 契约（版本 1、空 params、成员 logo 字符串）。
// - 两个 import：gallery.css（副作用，进入 css 字段）与 logo（?url，进入 assets 并变成 URL）。
// - default export：setup 中 host.serve(Gallery, 工厂)，工厂返回 { logo: constant(logo) }。
// 示例（真实签名）：defineFacet((host) => host.serve(Gallery, () => ({ logo: constant(urlString) })));
// 建议阅读顺序：先看两个 import 的差别，再看 Gallery 声明与 host.serve；然后回到 39/main.ts 第 2、4 步。

// The gallery plugin's web facet, built for a browser: its stylesheet is collected into one CSS file, its logo is an
// asset imported by URL (content-hashed, under the app's `publicPath`).

import { constant, defineFacet, local, str } from "@earendil-works/chord";
// 副作用导入：只为让构建器收集样式，不把 CSS 作为 JavaScript 值；没有默认导出。
import "./gallery.css";
// ?url 只在浏览器构建中有效：构建器把文件作为资源输出，并让这里的默认导入等于它的公开 URL。
import logo from "./assets/logo.svg?url";

// 契约身份由名字和版本决定；39/main.ts 里用同样的 local(...) 声明来读取这个对象，两边形状必须一致。
// str() 是成员 logo 的 schema；它约束类型/加载检查，不会在每次读取 constant 时重新校验。
const Gallery = local("example.gallery", { version: 1, params: {}, members: { logo: str() } });

// setup 只登记工厂；工厂在对象激活时返回成员。constant 表示 logo 永不变化，页面读取 .value 即可，无需订阅。
export default defineFacet((host) => host.serve(Gallery, () => ({ logo: constant(logo) })));
