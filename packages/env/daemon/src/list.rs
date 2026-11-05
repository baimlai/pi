//! `listFiles`: the files and directories below a directory, as `fd --hidden --exclude .git` lists them (without
//! following symbolic links), skipping what git ignores. Uses the `ignore` crate, which fd and ripgrep use.
//
// 文件导读（packages/env/daemon/src/list.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的 listFiles 模块，对应协议的可选操作 listFiles
// （hello.features 中声明）；Durable 的 RemoteExecutionEnv 与 LocalExecutionEnv 都用它列目录树。
// 解决的问题与职责边界：从 root 开始深度优先遍历，返回“类型字节 + 相对路径 + NUL”的记录流，支持隐藏文件、
// gitignore、额外排除名、条目数/字节数/超时上界，以及取消检查。它不跟随符号链接，不读取文件内容，不排序除
// 兄弟节点按文件名字节序之外的任何内容；路径显示由客户端负责。
// 上游入口：main.rs 的 Server::dispatch 在 op == "listFiles" 时调用 run，并把 control.aborted 作为取消函数。
// 下游依赖：ignore::WalkBuilder（fd/ripgrep 使用的遍历库）、errors::Failure（协议错误）、frame::MAX_PAYLOAD
// （payload 不能超过帧上限减去头部余量）。
// 能力清单（按导出项）：
//   - DEFAULT_MAX_ENTRIES / DEFAULT_MAX_BYTES / DEFAULT_TIMEOUT_MS：协议未给字段时的默认上界。
//   - Options 与 from_json：把 hidden/gitignore/exclude/maxEntries/maxBytes/timeoutMs 解析成有类型的配置。
//   - Listing：结果（payload 字节、条目数、是否 truncated）。
//   - relative（私有）：把绝对路径转成相对 root 的 / 分隔文本，非正常组件返回 None。
//   - list：执行遍历并返回 Listing；root 缺失为 ENOENT，非目录为 ENOTDIR，取消为 aborted。
//   - run：协议包装，返回 (JSON {count, truncated}, payload)。
//   - tests：用临时目录验证顺序、ignore 规则、符号链接、上界与错误。
// 组合关系/典型调用顺序：
//   Server::dispatch -> list::run -> Options::from_json -> list -> WalkBuilder 迭代 -> Listing
//   -> (json!({count, truncated}), payload) 作为 RESULT 帧的 JSON 与二进制 payload。
// 示例（真实签名，来自 run 内部；不是可独立运行的代码块）：
//   let listing = list("/project", &Options::from_json(json)?, &|| false)?;
//   // listing.payload 形如 b"fsrc/main.rs\0dsrc\0"，listing.count 为记录数。
// 建议阅读顺序：先看 Options/Listing 了解线上字段与输出格式，再看 list 的上界与过滤，最后看 run 与测试。

use crate::errors::Failure;
use crate::frame::MAX_PAYLOAD;
use ignore::WalkBuilder;
use serde_json::{Value, json};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path};
use std::time::{Duration, Instant};

// 默认最多 5 万条记录；防止一次列目录占用过多内存/带宽。
const DEFAULT_MAX_ENTRIES: u64 = 50_000;
// 默认 payload 最多 4 MiB；run 返回的二进制帧还要留出 JSON 与帧头空间。
const DEFAULT_MAX_BYTES: u64 = 4 * 1024 * 1024;
// 默认遍历时间预算 10 秒；超过后以 truncated 标记提前结束。
const DEFAULT_TIMEOUT_MS: u64 = 10_000;

// 已校验的 listFiles 选项；字段都是拥有型数据，不借用请求 JSON。
pub struct Options {
    /// Include names starting with `.` (and, on Windows, hidden files).
    // true（默认）包含点文件；false 跳过隐藏项。
    pub hidden: bool,
    /// Skip what git ignores inside git work trees: `.gitignore` files, `.git/info/exclude`, the global excludes file.
    pub gitignore: bool,
    /// Names skipped with everything below them, in addition to `.git`.
    // OsString 可保存非 UTF-8 文件名；.git 固定排除，不在此列表里。
    pub exclude: Vec<OsString>,
    pub max_entries: u64,
    /// Bytes of the listing payload: per entry one kind byte, the path, and a NUL.
    // 这里的字节数是记录编码后的总长，不是文件内容大小。
    pub max_bytes: u64,
    pub timeout: Duration,
}

impl Options {
    // 从 JSON 解析选项；只做类型/范围检查，不访问磁盘。错误统一 EINVAL。
    // 例：{} 得到 hidden=true、gitignore=true、默认上界；{"maxBytes":1} 允许但几乎立刻 truncated。
    pub fn from_json(json: &Value) -> Result<Options, Failure> {
        // 闭包读取可选数量字段：Null/缺失用 default，存在但不是 u64 则 EINVAL。
        let count = |key: &str, default: u64| -> Result<u64, Failure> {
            match &json[key] {
                Value::Null => Ok(default),
                value => value
                    .as_u64()
                    .ok_or_else(|| Failure::new("EINVAL", format!("invalid field {key}"))),
            }
        };
        // exclude 必须是字符串数组；Null/缺失表示没有额外排除项。
        let exclude = match &json["exclude"] {
            Value::Null => Vec::new(),
            Value::Array(names) => names
                .iter()
                .map(|name| name.as_str().map(OsString::from))
                // collect 到 Option<Vec<_>>：任一项不是字符串则整体 None，再统一报错。
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| Failure::new("EINVAL", "invalid field exclude"))?,
            // 其他 JSON 类型（数字、对象等）都不合法。
            _ => return Err(Failure::new("EINVAL", "invalid field exclude")),
        };
        Ok(Options {
            // as_bool 对缺失/非布尔返回 None，这里用默认 true。
            hidden: json["hidden"].as_bool().unwrap_or(true),
            gitignore: json["gitignore"].as_bool().unwrap_or(true),
            exclude,
            max_entries: count("maxEntries", DEFAULT_MAX_ENTRIES)?,
            // 即使客户端给得更大，也不能超过单帧 payload 上限；min 选较小值。
            max_bytes: count("maxBytes", DEFAULT_MAX_BYTES)?.min(MAX_PAYLOAD as u64),
            timeout: Duration::from_millis(count("timeoutMs", DEFAULT_TIMEOUT_MS)?),
        })
    }
}

// 遍历结果：payload 是二进制记录流，count 用于向客户端报告数量，truncated 表示因上界提前停止。
pub struct Listing {
    /// Records of a kind byte (`f`, `d`, `l`), the path relative to the root with `/` separators, and a NUL.
    pub payload: Vec<u8>,
    pub count: u64,
    pub truncated: bool,
}

/// The path of `path` below `root`, its components joined with `/`; names that are not UTF-8 get replacement
/// characters, as `readdir` reports them.
// 只接受普通路径组件（Normal）；遇到 RootDir/ParentDir/CurDir 等返回 None，避免生成越界或含 . 的相对路径。
// 例：relative(Path::new("/a"), Path::new("/a/b/c")) 得到 Some("b/c")；路径等于 root 时得到 None。
fn relative(root: &Path, path: &Path) -> Option<String> {
    // strip_prefix 失败（path 不在 root 下）时 ? 直接返回 None。
    let rest = path.strip_prefix(root).ok()?;
    let mut text = String::new();
    for component in rest.components() {
        // let-else：不是 Normal 组件就放弃该条目；模式匹配同时绑定 name。
        let Component::Normal(name) = component else {
            return None;
        };
        // 用 / 连接组件（Windows 也统一成 /），而不是平台分隔符。
        if !text.is_empty() {
            text.push('/');
        }
        // to_string_lossy 把非 UTF-8 字节替换为 U+FFFD，与 Node readdir 显示一致。
        text.push_str(&name.to_string_lossy());
    }
    // root 自身（rest 为空）不产生记录：then_some 只在条件为 true 时返回 Some(text)。
    (!text.is_empty()).then_some(text)
}

/// List `root` depth first, siblings in byte order of their names. Stops with `truncated` at the first entry beyond
/// a bound; fails with `aborted` once `aborted()` is true. Entries that cannot be read are skipped.
// root 缺失/不可 stat 返回 ENOENT 风格 Failure；不是目录返回 ENOTDIR；遍历中取消返回 aborted。
// 其他读取错误（例如某个子目录权限不足）由 ignore crate 报告，这里选择跳过该条目而不是整页失败。
// 例：list("/project", &Options::from_json(&json!({}))?, &|| false) 得到按名字排序的 Listing。
pub fn list(root: &str, options: &Options, aborted: &dyn Fn() -> bool) -> Result<Listing, Failure> {
    // 先确认 root 元数据；错误作为 scandir 系统调用报告，路径是 root。
    let metadata = fs::metadata(root).map_err(|error| Failure::io(&error, "scandir", root))?;
    if !metadata.is_dir() {
        // 明确构造 ENOTDIR，而不是让后续遍历产生含糊错误。
        return Err(Failure::new(
            "ENOTDIR",
            format!("ENOTDIR: not a directory, scandir '{root}'"),
        )
        .path(root));
    }
    let root_path = Path::new(root);
    // 克隆排除列表，因为 filter_entry 闭包需要 move 进入 WalkBuilder（'static 生命周期）。
    let exclude = options.exclude.clone();
    // WalkBuilder 的各个开关对应协议选项；构建后迭代得到深度优先、兄弟按名排序的条目。
    let walk = WalkBuilder::new(root_path)
        // hidden(true) 表示跳过隐藏项，因此传 !options.hidden。
        .hidden(!options.hidden)
        // ignore(false) 关闭 ignore crate 自己的 .ignore 规则；本操作只按 gitignore 选项处理。
        .ignore(false)
        // 四个 git_* 开关共同决定 .gitignore、.git/info/exclude、全局 excludes 与父目录规则。
        .parents(options.gitignore)
        .git_ignore(options.gitignore)
        .git_exclude(options.gitignore)
        .git_global(options.gitignore)
        // require_git(true) 表示只有位于 git 工作树内才应用 ignore 规则（与客户端描述一致）。
        .require_git(true)
        // 不跟随符号链接：链接本身作为 l 记录，不递归其目标。
        .follow_links(false)
        // The global excludes file is found relative to the listed directory, not the daemon's.
        .current_dir(root_path)
        // 兄弟节点按文件名字节序排序，结果稳定；闭包参数是 &OsStr。
        .sort_by_file_name(|a, b| a.cmp(b))
        // filter_entry 在进入目录前调用：排除 .git 与配置的名字，且整棵子树都不会被遍历。
        .filter_entry(move |entry| {
            let name = entry.file_name();
            name != ".git" && !exclude.iter().any(|excluded| excluded == name)
        })
        .build();
    // 计时从构建遍历器开始，包含后续全部条目处理。
    let started = Instant::now();
    let mut listing = Listing {
        payload: Vec::new(),
        count: 0,
        truncated: false,
    };
    // walk 是迭代器，每个 entry 是 Result<DirEntry, ignore::Error>。
    for entry in walk {
        // 每个条目检查一次取消：客户端 abort 后尽快停止，而不是等整棵树遍历完。
        if aborted() {
            return Err(Failure::new("aborted", "aborted"));
        }
        // 读不了的条目（权限等）直接跳过；let-else 丢弃 Err。
        let Ok(entry) = entry else { continue };
        // 深度 0 是 root 自身，不产生记录。
        if entry.depth() == 0 {
            continue;
        }
        // 某些条目无法取得文件类型；跳过。
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        // 只输出普通文件、目录、符号链接；FIFO/设备/套接字等被忽略（与协议一致）。
        let kind = if file_type.is_symlink() {
            b'l'
        } else if file_type.is_dir() {
            b'd'
        } else if file_type.is_file() {
            b'f'
        } else {
            continue;
        };
        // 相对路径找不到合法组件时跳过（正常遍历下很少发生）。
        let Some(path) = relative(root_path, entry.path()) else {
            continue;
        };
        // 每条记录大小 = 1 个类型字节 + 路径字节 + 1 个 NUL。
        let size = path.len() as u64 + 2;
        // 任一上界到达就停止，并标记 truncated；注意记录本身不会被部分写入。
        if listing.count >= options.max_entries
            || listing.payload.len() as u64 + size > options.max_bytes
            || started.elapsed() > options.timeout
        {
            listing.truncated = true;
            break;
        }
        // 依次追加类型、路径 UTF-8 与 NUL；客户端按 NUL 切分记录。
        listing.payload.push(kind);
        listing.payload.extend_from_slice(path.as_bytes());
        listing.payload.push(0);
        listing.count += 1;
    }
    Ok(listing)
}

// 协议包装：读取必填 path，解析选项，执行 list，返回 JSON 元数据与二进制 payload。
// 例：run(&json!({"path":"/tmp/d"}), &|| false) -> ({"count":2,"truncated":false}, b"fa\0db\0")。
pub fn run(json: &Value, aborted: &dyn Fn() -> bool) -> Result<(Value, Vec<u8>), Failure> {
    // path 缺失或不是字符串返回 EINVAL；这里取得的 &str 借用请求 JSON。
    let root = json["path"]
        .as_str()
        .ok_or_else(|| Failure::new("EINVAL", "missing field path"))?;
    // 选项解析也可能返回 EINVAL。
    let listing = list(root, &Options::from_json(json)?, aborted)?;
    // 元数据放 JSON，记录流放 payload；两者分别进入 RESULT 帧。
    Ok((
        json!({ "count": listing.count, "truncated": listing.truncated }),
        listing.payload,
    ))
}

// 测试模块只在 cargo test 构建中编译；测试用真实临时目录（不是 mock 内存文件系统）。
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // 测试夹具：一个唯一命名的临时目录，Drop 时递归删除；避免测试间互相干扰。
    struct Tree(std::path::PathBuf);

    impl Tree {
        // 使用进程 id + 全局原子计数生成唯一路径，并写入初始文件列表。
        fn new(files: &[&str]) -> Tree {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "pi-env-list-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let tree = Tree(root);
            for file in files {
                // write 会按需创建父目录；以 / 结尾的名字表示空目录。
                tree.write(file, "");
            }
            tree
        }

        // 写入文件或创建目录；路径以 / 结尾时只建目录。
        fn write(&self, path: &str, content: &str) {
            let path = self.0.join(path);
            if path.to_string_lossy().ends_with('/') {
                // create_dir_all 会补齐中间目录。
                fs::create_dir_all(&path).unwrap();
                return;
            }
            // 先建父目录，再写内容；unwrap 表示测试夹具失败应直接 panic。
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }

        // 调用被测 list，把 NUL 分隔的 payload 解码成 "类型 路径" 字符串便于断言；
        // 同时检查 count 与实际记录数一致。aborted 固定为 false。
        fn list(&self, options: Options) -> (Vec<String>, bool) {
            let listing = list(&self.0.to_string_lossy(), &options, &|| false).unwrap();
            let entries: Vec<String> = listing
                .payload
                .split(|byte| *byte == 0)
                .filter(|record| !record.is_empty())
                .map(|record| {
                    // record[0] 是类型字节；record[1..] 是路径。
                    format!(
                        "{} {}",
                        record[0] as char,
                        String::from_utf8_lossy(&record[1..])
                    )
                })
                .collect();
            assert_eq!(entries.len() as u64, listing.count);
            (entries, listing.truncated)
        }
    }

    // Drop 清理临时目录；失败（例如已删除）被忽略。
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    // 默认选项（hidden/gitignore 均为 true）的便捷构造。
    fn options() -> Options {
        Options::from_json(&json!({})).unwrap()
    }

    // 验证深度优先、兄弟按名字排序、隐藏文件默认包含、空目录也列出。
    #[test]
    fn lists_files_and_directories_depth_first_in_name_order() {
        let tree = Tree::new(&[
            "b.txt",
            "a/z.txt",
            "a/b/c.txt",
            "empty/",
            ".hidden/x",
            "A.txt",
        ]);
        let (entries, truncated) = tree.list(options());
        // 字节序下 '.' < 'A' < 'a' < 'b'；目录先于其内容被记录。
        assert_eq!(
            entries,
            [
                "d .hidden",
                "f .hidden/x",
                "f A.txt",
                "d a",
                "d a/b",
                "f a/b/c.txt",
                "f a/z.txt",
                "f b.txt",
                "d empty"
            ]
        );
        assert!(!truncated);
        // hidden=false 时跳过 .hidden 及其内容；..options() 是结构体更新语法，保留其余字段。
        let (entries, _) = tree.list(Options {
            hidden: false,
            ..options()
        });
        assert!(!entries.iter().any(|entry| entry.contains(".hidden")));
    }

    // 验证 gitignore 只在 git 工作树内生效，并能被 gitignore=false 关闭；exclude 名称整棵跳过。
    #[test]
    fn skips_what_git_ignores_only_in_work_trees() {
        let tree = Tree::new(&[
            "keep.txt",
            "out/x.js",
            "sub/keep.txt",
            "sub/drop.log",
            "node_modules/m/i.js",
        ]);
        tree.write(".gitignore", "out/\n*.log\n");
        tree.write("sub/.gitignore", "!keep.txt\n");
        // Not a work tree yet: everything is listed.
        // 还没有 .git，require_git(true) 使 ignore 规则不生效。
        let (entries, _) = tree.list(options());
        assert!(entries.contains(&"f out/x.js".to_string()));
        // 创建 .git/HEAD 使其成为工作树，并写 info/exclude。
        tree.write(".git/HEAD", "ref: refs/heads/main\n");
        tree.write(".git/info/exclude", "keep.txt\n");
        let (entries, _) = tree.list(Options {
            exclude: vec!["node_modules".into()],
            ..options()
        });
        // out/ 与 *.log 被忽略；keep.txt 被 info/exclude 排除；node_modules 由 exclude 跳过；.git 自身不列出。
        assert_eq!(
            entries,
            [
                "f .gitignore",
                "d sub",
                "f sub/.gitignore",
                "f sub/keep.txt"
            ]
        );
        // gitignore=false 时重新列出被忽略的 out/x.js，但 .git 目录始终被过滤。
        let (entries, _) = tree.list(Options {
            gitignore: false,
            ..options()
        });
        assert!(entries.contains(&"f out/x.js".to_string()));
        assert!(!entries.iter().any(|entry| entry.contains(".git/")));
        // A subdirectory of a work tree applies the rules of its parents.
        // 从 sub 作为 root 时，父目录的规则仍生效（parents(true)）；记录路径相对于 sub。
        let sub = list(&tree.0.join("sub").to_string_lossy(), &options(), &|| false).unwrap();
        assert_eq!(sub.payload, b"f.gitignore\0fkeep.txt\0");
    }

    // 仅 Unix：符号链接作为 l 列出且不跟随，包括悬空链接和指回祖先的循环。
    #[cfg(unix)]
    #[test]
    fn lists_symbolic_links_without_following_them() {
        let tree = Tree::new(&["dir/inner.txt"]);
        std::os::unix::fs::symlink(tree.0.join("dir"), tree.0.join("link")).unwrap();
        std::os::unix::fs::symlink("missing", tree.0.join("dangling")).unwrap();
        std::os::unix::fs::symlink(&tree.0, tree.0.join("dir/loop")).unwrap();
        let (entries, _) = tree.list(options());
        assert_eq!(
            entries,
            [
                "l dangling",
                "d dir",
                "f dir/inner.txt",
                "l dir/loop",
                "l link"
            ]
        );
    }

    // 验证三个上界：条目数、payload 字节数、时间；超界返回 truncated 且不包含越界条目。
    #[test]
    fn stops_at_bounds_with_truncated() {
        let tree = Tree::new(&["a", "b", "c"]);
        // 只允许 2 条：得到 a、b，并标记 truncated。
        let (entries, truncated) = tree.list(Options {
            max_entries: 2,
            ..options()
        });
        assert_eq!((entries.len(), truncated), (2, true));
        // 恰好 3 条：完整列出且不截断。
        let (entries, truncated) = tree.list(Options {
            max_entries: 3,
            ..options()
        });
        assert_eq!((entries.len(), truncated), (3, false));
        // 每条 "f a" 记录是 1+1+1=3 字节，6 字节只能放 2 条。
        let (entries, truncated) = tree.list(Options {
            max_bytes: 6,
            ..options()
        });
        assert_eq!(
            (entries, truncated),
            (vec!["f a".to_string(), "f b".to_string()], true)
        );
        // 超时为 0：第一次检查即截断，因此没有任何条目。
        let (entries, truncated) = tree.list(Options {
            timeout: Duration::ZERO,
            ..options()
        });
        assert!(truncated && entries.is_empty());
    }

    // 验证 root 缺失 -> ENOENT、root 是文件 -> ENOTDIR、取消回调为 true -> aborted。
    #[test]
    fn fails_on_missing_roots_files_and_aborts() {
        let tree = Tree::new(&["file"]);
        let missing = list(
            &tree.0.join("missing").to_string_lossy(),
            &options(),
            &|| false,
        );
        assert_eq!(missing.err().unwrap().code, "ENOENT");
        let file = list(&tree.0.join("file").to_string_lossy(), &options(), &|| {
            false
        });
        assert_eq!(file.err().unwrap().code, "ENOTDIR");
        let aborted = list(&tree.0.to_string_lossy(), &options(), &|| true);
        assert_eq!(aborted.err().unwrap().code, "aborted");
    }
}
