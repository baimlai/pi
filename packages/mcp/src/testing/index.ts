// MCP的/testing子入口，只重导出内存传输类和成对创建函数供离线客户端/适配器测试使用。例：createInMemoryTransportPair()得到尚未启动的{client,server}，随后各自start并订事件；这里不是启动服务器/开端口。
// export...from复用原模块的值，没有再包装逻辑。内存send会structuredClone后排微任务，语义与真实JSON/stdio/HTTP不完全相同；没有自动模拟认证、字节上限或SendOptions.signal处理。
export { createInMemoryTransportPair, InMemoryTransport } from "../transports/in-memory.ts";
