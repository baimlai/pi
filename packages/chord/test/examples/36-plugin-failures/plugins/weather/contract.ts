// The weather plugin's contract; the forecast plugin imports (copies) it.

import { int, local } from "@earendil-works/chord";

/** Today's temperature. */
// 独立的契约文件没有工厂/请求；forecast 把它复制进自己的脚本，以名称、版本、形状向 provider 绑定。
// 空 params 的 local 对象具有主机生命周期；celsius 整数状态不是在此计算的温度。
export const Weather = local("example.weather", { version: 1, params: {}, members: { celsius: int() } });
