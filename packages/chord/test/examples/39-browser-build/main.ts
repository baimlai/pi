// 文件导读
// 所属：packages/chord/test/examples/39-browser-build，Chord v2 插件组第 39 个示例，对应 slice 7c §2（浏览器构建）。
// 演示什么：kinds 中 platform 为 "browser" 的 facet 如何构建成普通数据：一个 JavaScript 脚本、一个合并后的 CSS
// 文件、若干内容哈希资源。`import "./gallery.css"` 被收集进 css 字段；`import logo from "./logo.svg?url"` 得到
// publicPath（这里 "/plugin-assets/"）下的 URL 字符串；Node 内置模块在浏览器构建中被拒绝；构建结果可以
// structuredClone 后送给页面或 worker，再用宿主包求值并加载。
// 上游入口：直接运行本文件；它只读取 plugins/，不复制、不修改任何文件。
// 下游依赖：../../../src/context（BACKGROUND_CONTEXT）、../../../src/contracts（local/str）、../../../src/host
// （createHost）、../../../src/index.ts（Chord 公共 API，作为宿主包）、../../../src/node/plugins
// （createPlugins/evaluateFacet/Built 等类型）。
// 输出与副作用：stdout 打印脚本字节数、digest、CSS 名与首行、资源名与字节数、脚本中的资源 URL、输入文件、
// bad-web 的错误、克隆比较结果，以及页面读到的 logo URL；不监听网络，不访问网络。
// 失败行为：顶层 await 使 I/O 或构建错误直接拒绝；示例内的 throw 是它自己的预期检查，不是 Chord 的运行时校验。
// 能力清单（按步骤）：
// - 第 1 步：createPlugins，配置浏览器 kind web 与 publicPath。
// - 第 2 步：build 全部插件，读取成功构建的 gallery 与失败构建的 bad-web。
// - 第 3 步：structuredClone 证明 Built 是普通数据；克隆与原件 digest 相同。
// - 第 4 步：evaluateFacet 同进程执行脚本，createHost 充当“页面”，load 后 get 到 logo URL。
// 运行（从 packages/chord 目录）：
//   node --conditions=source --experimental-strip-types test/examples/39-browser-build/main.ts
// 示例（真实签名）：
//   const plugins = createPlugins({
//     roots: [root],
//     kinds: { web: { platform: "browser", hostPackages: ["@earendil-works/chord"] } },
//     publicPath: "/plugin-assets/",
//   }, context);
//   const built = await plugins.build([], context);
//   const facet = evaluateFacet(scriptFacet, { hostPackages, plugin: built.plugins["@example/gallery"]! });
// 建议阅读顺序：先读 gallery/web.ts 与 bad-web/web.ts，再看本文件第 1-4 步；构建字段对照
// src/node/plugins/build.ts 的 BuiltFacet，求值行为对照 evaluate.ts 的 evaluateFacet。

// A browser build (slice 7c §2): a facet of a browser kind (`web: { platform: "browser", … }`) is built for the browser. Its
// stylesheets become one CSS file (`css`), an asset imported by URL (`./logo.svg?url`) a content-hashed file whose
// import evaluates to its URL under the app's `publicPath`. The build is plain data: script, stylesheet and assets,
// what the app serves to its pages (slice 11 ships it); a page evaluates the script with its host packages, as Node
// does here. A Node builtin is refused in a browser build. The example only reads `plugins/`: no copy.
// Run from packages/chord:
//   node --conditions=source --experimental-strip-types test/examples/39-browser-build/main.ts
// fileURLToPath 把 import.meta.url 转成本机路径，供 roots 使用。
import { fileURLToPath } from "node:url";
// 永不取消的根上下文；构建、加载和 get 都显式接收 Context。
import { BACKGROUND_CONTEXT } from "../../../src/context/index.ts";
// 应用侧声明与插件相同的 local 契约，用来读取插件服务的对象。
import { local, str } from "../../../src/contracts/index.ts";
// 进程内 host；这里扮演“页面”的角色。
import { createHost } from "../../../src/host/index.ts";
// 整个 Chord 包作为宿主包实例：插件里的 import 会拿到与本进程相同的模块对象。
import * as chord from "../../../src/index.ts";
// createPlugins 创建组件；evaluateFacet 执行浏览器构建产出的脚本文本。
import { createPlugins, evaluateFacet } from "../../../src/node/plugins/index.ts";

const context = BACKGROUND_CONTEXT;
// 插件根是示例自己的 plugins/ 目录；末尾斜杠保证 URL 被当作目录。
const root = fileURLToPath(new URL("./plugins/", import.meta.url));

// 1. The component: `web` is a browser kind; its assets are served under `/plugin-assets/`.
// 宿主包映射：构建时这些说明符保持 external，求值时按说明符提供本进程的模块实例。
const hostPackages = { "@earendil-works/chord": chord };
// web 是 kind 名，也是发现阶段识别的文件名（web.ts）；platform 决定 esbuild 规则与输出形态。
// hostPackages 只列说明符，值是第 4 步求值时传入的实际模块；publicPath 只影响浏览器资源 URL。
const plugins = createPlugins(
	{
		roots: [root],
		kinds: { web: { platform: "browser", hostPackages: Object.keys(hostPackages) } },
		publicPath: "/plugin-assets/",
		// 后台错误出口：这里只打印 kind；构建失败不走这里，而是作为 BuiltFacet 返回。
		onError: (error) => console.log("plugins:", error.kind),
	},
	context,
);

// 2. The first build: every discovered plugin.
// 传入空的名字列表：build 会先发现，再构建“上次构建之后新发现”的插件，所以首次调用构建全部插件。
// 返回 Built（facets/plugins/removed），此时还没有加载或发布任何东西。
const built = await plugins.build([], context);
// find 返回 BuiltFacet | undefined；! 是非空断言，随后显式检查 kind，等于在示例内验证预期的构建形状。
const gallery = built.facets.find(({ plugin }) => plugin === "@example/gallery")!;
const bad = built.facets.find(({ plugin }) => plugin === "@example/bad-web")!;
// 这个 throw 是示例的运行时检查：TypeScript 的 kind 收窄不能证明画廊一定构建成功，失败时直接报错。
if (gallery.kind !== "script" || bad.kind !== "failed") throw new Error("unexpected build results");
// source 是压缩后的 CommonJS 包装函数文本；digest 只对 source 做 sha256，用于判断构建是否变化。
console.log("1. @example/gallery/web: script of", gallery.source.length, "bytes, digest", gallery.digest.slice(0, 12));
// css 只在浏览器构建导入样式时存在；name 是内容哈希文件名，text 是收集后的完整样式表。
console.log("   stylesheet:", gallery.css?.name, JSON.stringify(gallery.css?.text.split("\n")[0]));
// assets 是脚本之外的其他构建输出（这里是 logo），name 是内容哈希文件名，bytes 是内存中的内容。
for (const asset of gallery.assets) console.log("   asset:", asset.name, `(${asset.bytes.length} bytes)`);
// 从生成的脚本文本里找 publicPath 下的 URL，验证 ?url 导入已被替换成字符串；exec 可能为 undefined，用 ?. 读取。
console.log("   the asset's URL in the script:", /\/plugin-assets\/[^"]+/.exec(gallery.source)?.[0]);
// inputs 是构建实际读到的插件文件（绝对路径），slice 去掉根前缀只显示相对部分。
console.log("   read:", gallery.inputs.map(({ file }) => file.slice(root.length)).join(", "));
// failed 分支没有 source/digest，只有格式化的错误文本；多条错误用分号分隔。
console.log("2. @example/bad-web/web:", bad.errors.join("; "));

// 3. Plain data: a structured clone (what a message to a page or a worker carries) is the same build.
// structuredClone 复制普通对象与 Uint8Array；克隆出的 Built 与原件内容相同，digest 也相同。
// 注意：组件内部用 WeakMap 把原 Built 对象关联到 watcher 快照；克隆查不到快照，因此克隆不能用于 rollout 清标记。
const shipped = structuredClone(built);
const copy = shipped.facets.find(({ plugin }) => plugin === "@example/gallery")!;
console.log(
	"3. cloned:",
	// kind 收窄后 digest 才可读；两个 digest 相等说明克隆保留了同一份脚本文本。
	copy.kind === "script" && copy.digest === gallery.digest,
	"| its plugins:",
	// plugins 记录也随构建结果一起克隆；这里是本次构建参与（或保留）的插件名。
	Object.keys(shipped.plugins).join(", "),
);

// 4. Where it runs (a page; Node stands in here), the script is evaluated with the host packages and loaded.
// 应用侧再声明一次同名同版本的契约；兼容按名字、版本和成员形状判断，不要求与插件里是同一个对象引用。
const Gallery = local("example.gallery", { version: 1, params: {}, members: { logo: str() } });
// 克隆的分支已被第 2 步的检查与这里的 kind 判断收窄为 script，可以交给 evaluateFacet。
if (copy.kind === "script") {
	// evaluateFacet 用 runInThisContext 执行脚本文本，并以宿主包回答 require；它与宿主同进程，不是安全沙箱。
	// plugin 记录提供 facet 文件名、插件目录和构建时的导入规则；这里取的是克隆里的插件记录。
	const facet = evaluateFacet(copy, { hostPackages, plugin: shipped.plugins["@example/gallery"]! });
	// createHost 的参数是宿主设置；onError 传空函数，示例不观察宿主层错误。
	const page = createHost({ onError: () => {} });
	// load 接收 Facet（不是构建结果）：name 是插件名，facet 是刚才求值出的 Facet 对象，其 setup 由 host.load 执行。
	await page.load([{ name: "@example/gallery", facet }], context);
	// get 返回引用（Reference）；logo 是 constant，读取 .value 得到当前 URL，无需订阅。
	console.log("4. the gallery's logo on the page:", (await page.get(Gallery, {}, context)).logo.value);
	// 关闭页面宿主：结束它加载的对象；之后才关闭组件。
	await page.close(context);
}

// close 停止 watcher；它不会卸载已加载的页面（页面已在上面关闭）。同步调用，无需 await。
plugins.close();
