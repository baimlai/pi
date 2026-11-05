// The prices plugin's contract; the summary plugin imports (copies) it. The example moves it to version 2.

import { int, local } from "@earendil-works/chord";

/** A price in cents. */
// 只声明本主机价格契约，金额单位为分；summary 打包此文件副本，版本更改会让旧/新消费者绑定规则不同。
// members 的 int 是 schema 而非初值；状态由 provider 返回，不会逐次在读取时校验。
export const Price = local("example.price", { version: 1, params: {}, members: { cents: int() } });
