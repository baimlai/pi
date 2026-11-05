#!/usr/bin/env node
// 专用RPC可执行入口：配置进程标记与HTTP调度，再把--mode rpc前置到CLI参数；导入本文件就会运行启动逻辑。
// 从包配置取应用名，避免另写一份固定进程标题。
import { APP_NAME } from "./config.ts";
// 配置进程内HTTP代理/连接调度；不是启动RPC监听端口，RPC协议走stdin/stdout。
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
// 导入实际CLI总入口函数，这里随后会显式调用它。
import { main } from "./main.ts";

// 赋值改变当前进程显示标题；模板字符串插入应用名并加-rpc后缀。
process.title = `${APP_NAME}-rpc`;
// 环境变量只存字符串，供本进程及之后继承环境的子进程识别宿主。
process.env.PI_CODING_AGENT = "true";
// AI_AGENT标记此宿主为pi，不表示已请求模型。
process.env.AI_AGENT = "pi";
// 用空函数替换进程告警发送器；as typeof只让TS接受同一函数签名，不改变空函数实际行为，也没有保存/恢复旧函数。
process.emitWarning = (() => {}) as typeof process.emitWarning;

// 执行一次同步调度配置；若抛错，下面main尚未调用。
configureHttpDispatcher();

// slice(2)去掉Node及脚本路径，...把剩余argv逐项展开；例如无额外参数得到['--mode','rpc']。
// main为async，这里不await也未附catch；实际参数冲突/运行与退出规则仍在main中，不由“前置rpc”一行保证所有后续参数都不能覆盖。
main(["--mode", "rpc", ...process.argv.slice(2)]);
