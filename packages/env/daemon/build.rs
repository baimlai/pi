//! Exposes the npm package version as `PI_ENV_VERSION`, so `hello` reports the release the daemon shipped with.

// Cargo 构建 daemon 时运行的入口，无参数、返回 ()；读取包清单并向构建器输出两条指令，不连接客户端。
// 先声明重建输入，再提取版本并传给 rustc；读文件失败或没有预期字段会由 expect 触发 panic，使构建失败。
// 例：清单版本为 "1.5.0" 时，main.rs 的 env!("PI_ENV_VERSION") 编译为该字符串；不是 Cargo.toml 的 0.1.0。
fn main() {
    // println! 是格式化输出宏；cargo: 前缀由 Cargo 识别，清单变化后需要重新运行这个构建脚本。
    println!("cargo:rerun-if-changed=../package.json");
    // std::fs::read_to_string 返回 Result<String, io::Error>；expect 成功取 String，失败打印上下文并 panic。
    let package = std::fs::read_to_string("../package.json").expect("read ../package.json");
    // 这里是对可信仓库文件做字符串切分，不是完整 JSON 解析；version 是借用 package 内容的 &str。
    let version = package
        // 分割出首次 "version" 字段文字之后的一段，双引号前的反斜杠属于 Rust 字符串转义。
        .split("\"version\"")
        // nth(1) 消耗迭代器并取第二段；不存在时得到 Option::None。
        .nth(1)
        // and_then 只在 Some 时调用闭包，取随后第一对双引号里的值；|rest| 是闭包参数。
        .and_then(|rest| rest.split('"').nth(1))
        // Option::expect 在 None 时 panic；它不验证版本是否符合语义版本格式。
        .expect("version in ../package.json");
    // {version} 把借用的版本插入指令；rustc-env 为编译期 env! 提供值，不会修改父进程环境。
    println!("cargo:rustc-env=PI_ENV_VERSION={version}");
}
