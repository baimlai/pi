// 文件导读
// 所属：packages/chord/test/examples/56-web，Chord 示例 56；本文件是 board 应用 API v1 的终端子路径
// `@board/app/v1/tui`。
// 作用：声明终端界面使用的 `Lines` 注册表。每个插件向注册表贡献若干行文本，终端把所有贡献
// 按插件名顺序合并成一个只读字符串数组后绘制。
// 上游：plugins/notes/tui.ts 等终端 facet 通过 `Lines` 贡献内容；tui/main.ts 使用
// `scope.registry(Lines)` 读取合并结果。
// 下游：只依赖 packages/chord/src/index.ts 的 `defineRegistry`，不产生 I/O。
// 能力清单：
// - `Lines`：注册表 token，贡献类型是 `string`（一行），合并值是 `readonly string[]`。
// 典型用法（示例）：
//   self.contribute(Lines, { value: ["notes: 2 items"], version: 1 });
// 阅读顺序：先看泛型参数含义，再看 registry 在 tui/main.ts 中的消费方式。
// 运行方式：随示例 56 的 TUI 进程一起加载。
// 说明：`defineRegistry` 在声明时做运行时校验（名称符合小写规则、version 为正整数），
// 但贡献值和合并值的内容不在这里校验；它们由使用方的类型约束。

// The board app's API v1 for terminal facets (`@board/app/v1/tui`): the `Lines` registry the terminal draws.

// 路径从 app/v1/ 上溯五层到 packages/chord/；`import` 引入的是真实的运行时函数。
import { defineRegistry } from "../../../../../src/index.ts";

// 泛型参数顺序是 <贡献类型 C, 合并类型 V>：
// - 第一个 `string` 表示每个插件贡献一行文本；
// - 第二个 `readonly string[]` 表示注册表对外暴露的合并值。
// defineRegistry 返回一个声明 token（只含 name/version），不是数据本身；数据在宿主组合时产生。
/** Lines of the terminal board, in plugin-name order. */
export const Lines = defineRegistry<string, readonly string[]>("board.lines", { version: 1 });
