// propagation.test.ts启动的本地子进程入口：argv[2]接收JSON carrier→提取父→记录一个remote→stdout输出快照；不经网络共享父进程内存。
// 内存adapter提供传播与记录，type TelemetryCarrier只约定字符串字典，不替JSON.parse作运行校验。
import { InMemoryTelemetryContext, type TelemetryCarrier } from "../src/index.ts";

// 子进程有全新实例和scope，父进程本地数字id不会成为这个实例的内部父id。
const telemetry = new InMemoryTelemetryContext();
// argv前两项是Node程序/脚本路径，第三项才是测试传的carrier；??只在缺省时用{}，坏JSON仍可抛异常；as不校验结构。
const carrier = JSON.parse(process.argv[2] ?? "{}") as TelemetryCarrier;
// extract读取认可的carrier字段，startSpan沿外部trace身份建孩子；顶层await在ESM中可直接等待，无需再包main函数。
await telemetry.extract(carrier).startSpan({ name: "remote" }, () => {});
// 仅输出JSON不给stdout混入日志；父测试JSON.parse整个输出。若启动/解析/记录失败，这里没有catch替换为成功快照。
process.stdout.write(JSON.stringify(telemetry.getSpans()));
