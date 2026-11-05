//! File operations with Node's semantics where the Rust standard library differs (docs/semantics.md).
// 这里实际操作 daemon 所在机器的文件；路径解析由 TypeScript 客户端负责。
//
// 文件导读（packages/env/daemon/src/fs.rs）
// 所属包/模块：packages/env 的 Rust daemon（二进制 pi-env）中的文件系统操作模块，对应协议里的 lstat、
// realpath、write、truncate、fsync、rename、mkdir、rm、mkdtemp、open、pread、fstat、scanLines 等操作的本机实现。
// 解决的问题与职责边界：在 Rust 标准库行为与 Node（libuv）不一致的地方补齐语义：递归 mkdir 的 EEXIST/ENOTDIR、
// rm 的 ERR_FS_EISDIR、mkdtemp 的模板、普通文件打开约束、目录项名字的非 UTF-8 处理等。它不解析客户端路径
// （~、相对路径、file:// 已在客户端展开），不把错误码映射成 Durable FileError，也不负责分页/分块策略。
// 上游入口：main.rs 的 Server::dispatch 逐个 op 调用本模块；open 返回的 File 被包装成连接内句柄。
// 下游依赖：sys（平台打开/重命名/删除/目录/定位读/身份与时间）、errors::Failure（协议错误）。
// 能力清单（按导出项）：
//   - Outcome<T>：Result<T, Failure> 的别名，统一成功值与协议错误。
//   - info：把已经取得的 Metadata 转成 {name,kind,size,mtimeSec,mtimeNsec,dev,ino}。
//   - lstat/realpath：读取链接本身元数据 / 解析真实路径。
//   - mkdir_recursive/mkdir：递归或单层建目录，遵循 Node 的已存在目录规则。
//   - write：按 writeFile/appendFile 语义打开并写入首块，可返回仍打开的 File 供 writeChunk。
//   - truncate/fsync/rename/rm/mkdtemp：其余文件操作。
//   - open_reader/pread/read：打开普通文件并按绝对偏移或当前位置读取。
//   - dir_entry：把一个目录项转成 {name,info} 或 {name,error}，必要时附原始字节 raw。
//   - open_existing_for_write（私有）：truncate/fsync 共用的打开逻辑。
// 组合关系/典型调用顺序：dispatch -> lstat/open/write/... -> sys 系统调用 -> Outcome -> respond 的 RESULT/ERROR。
// 示例（真实签名，来自 main.rs 的 dispatch）：fs::write(path, append, parents, &payload)? 返回打开的文件；
// 不 keep 时立即 drop 关闭，keep 时再 fs::pread(&file, path, offset, length) 读取。
// 建议阅读顺序：先看 info/Outcome 了解返回形状，再看 mkdir 与 write 的 Node 语义，然后 truncate/fsync/rename/rm，
// 最后看 open_reader/pread/read/dir_entry 的读取与目录项细节。

use crate::errors::Failure;
use crate::sys;
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::Path;

// 泛型别名：成功值随 T 改变，失败统一是可发回客户端的 Failure；它不是运行时校验器。
pub type Outcome<T> = Result<T, Failure>;

/// `{ name, kind, size, mtimeSec, mtimeNsec, dev, ino }` of lstat or fstat metadata.
// 把调用者已经取得的元数据整理成 JSON，不再访问磁盘；path 只提供名字。
// 例如 /a/b.txt 的 name 是 b.txt；文件种类、时间和身份取自 metadata，而非扩展名。
pub fn info(path: &str, metadata: &Metadata) -> Value {
    // 借用 Metadata 查询种类，顺序区分普通文件、目录、符号链接和其他节点。
    let file_type = metadata.file_type();
    let kind = if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    };
    // file_name 可能没有结果（如根目录）；非法编码以替换字符显示，最终拥有一个 String。
    let name = Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    // 元组解构分别接收秒/纳秒；平台模块处理 Unix 与 Windows 的表示差异。
    let (mtime_sec, mtime_nsec) = sys::mtime(metadata);
    let (dev, ino) = sys::identity(metadata);
    // json! 是构造 serde_json::Value 的宏；末尾没有分号，整个表达式就是返回值。
    json!({
        "name": name,
        "kind": kind,
        "size": metadata.len(),
        "mtimeSec": mtime_sec,
        "mtimeNsec": mtime_nsec,
        "dev": dev,
        "ino": ino,
    })
}

// 读取路径本身（最终链接不跟随）的元数据并返回 info JSON；例如链接得到 kind=symlink。
// 成功映射到 info，系统失败则带 lstat 和路径转成 Failure；不修改文件。
pub fn lstat(path: &str) -> Outcome<Value> {
    // map 只处理 Ok，map_err 只处理 Err；两条分支不会同时运行。
    fs::symlink_metadata(path)
        .map(|metadata| info(path, &metadata))
        .map_err(|error| Failure::io(&error, "lstat", path))
}

// 解析实际路径并包装成 {path}；会访问文件系统，缺失等错误以 realpath Failure 返回。
// 例如指向 /data/a 的链接成功时返回目标路径；Windows 前缀处理由 sys 实现。
pub fn realpath(path: &str) -> Outcome<Value> {
    sys::realpath(path)
        .map(|resolved| json!({ "path": resolved }))
        .map_err(|error| Failure::io(&error, "realpath", path))
}

/// Node's recursive `mkdir`: an existing directory is fine, an existing file is `EEXIST`, a file in the way of a
/// parent is `ENOTDIR`.
// 创建目录及缺失父目录，返回空成功值 ()；已有目录也算成功，已有文件不能被覆盖。
// 例如 a 尚不存在时创建 a/b；若 a 是文件，则父路径阻塞被转为 ENOTDIR。递归/创建失败向上传播。
pub fn mkdir_recursive(path: &Path) -> io::Result<()> {
    // 闭包通过 stat 跟随链接，查询失败按“不是目录”处理，不吞掉外层 create_dir 的错误。
    let is_dir = |path: &Path| {
        fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false)
    };
    // 先直接创建，避免每一层无条件 stat；match 按结果及附加条件（if guard）选分支。
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            // EEXIST 只有在路径实际是目录时允许；已有普通文件仍保留原错误。
            if is_dir(path) {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // let-else：没有非空父目录就返回原错误；否则 parent 在后续语句可用。
            let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            else {
                return Err(error);
            };
            // 先递归补父目录；父目录位置有文件时，Node 对子目录操作报告 ENOTDIR。
            match mkdir_recursive(parent) {
                Err(parent_error) if parent_error.kind() == io::ErrorKind::AlreadyExists => {
                    return Err(sys::synthetic("ENOTDIR"));
                }
                // ? 取出 Ok(())，或直接将其他父目录失败返回给调用者。
                other => other?,
            }
            // 父目录齐全后再创建目标；并发创建者已建好目录也允许成功。
            match fs::create_dir(path) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists && is_dir(path) => {
                    Ok(())
                }
                other => other,
            }
        }
        Err(error) => Err(error),
    }
}

// 根据 recursive 选择单层/递归创建，成功返回空 JSON；例如 recursive=false 不补 a/b 的 a。
// 这是有磁盘副作用的协议包装层，统一把 io 错误标成 mkdir Failure。
pub fn mkdir(path: &str, recursive: bool) -> Outcome<Value> {
    let result = if recursive {
        mkdir_recursive(Path::new(path))
    } else {
        fs::create_dir(path)
    };
    // () 只是没有返回数据，不是 JSON null；客户端收到的是 {}。
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "mkdir", path))
}

/// `writeFile`/`appendFile`: create missing parents like Node's recursive `mkdir`, then write. Returns the open file
/// for further chunks.
// 写入首块 content 并返回仍打开的 File，供后续协议块继续写；append 追加，否则截断旧内容。
// parents=true 时补父目录；例如写 a/b 会先建 a。任何创建/打开/完整写入失败立即返回 Failure。
pub fn write(path: &str, append: bool, parents: bool, content: &[u8]) -> Outcome<File> {
    // 连续 filter 表示同时要求开启补父目录、存在父目录且父目录名字非空。
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|_| parents)
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        // ? 防止父目录失败后继续打开；报错 syscall 指向 mkdir，并记录父目录路径。
        mkdir_recursive(parent)
            .map_err(|error| Failure::io(&error, "mkdir", &parent.to_string_lossy()))?;
    }
    // 选择枚举值，而不是在这里自己拼平台打开标志。
    let mode = if append {
        sys::OpenMode::Append
    } else {
        sys::OpenMode::Write
    };
    // File 需要可变绑定以调用 Write；成功打开可能已经创建或截断文件。
    let mut file = sys::open(path, mode).map_err(|error| Failure::io(&error, "open", path))?;
    // write_all 会处理短写，直至全部字节写完或失败；失败不意味着前面没写入任何字节。
    file.write_all(content)
        .map_err(|error| Failure::io(&error, "write", path))?;
    // 把句柄所有权交给调用方，不在此关闭。
    Ok(file)
}

// 以读写方式打开现有路径，供 truncate/fsync 共用；不会主动创建或截断。
// 例如不存在的 x 返回 open/ENOENT，现有 x 返回拥有句柄的 File。
fn open_existing_for_write(path: &str) -> Outcome<File> {
    sys::open(path, sys::OpenMode::ReadWrite).map_err(|error| Failure::io(&error, "open", path))
}

// 将现有文件长度改成 size 字节，成功 {}；例如 size=0 清空，增大可能由系统补零。
// 打开与 set_len 分别报告 open/ftruncate 错误，局部 File 离开作用域时关闭。
pub fn truncate(path: &str, size: u64) -> Outcome<Value> {
    let file = open_existing_for_write(path)?;
    // 这里修改真实文件长度；? 把转换后的 Failure 提前返回。
    file.set_len(size)
        .map_err(|error| Failure::io(&error, "ftruncate", path))?;
    Ok(json!({}))
}

// 打开现有文件并请求把内容及元数据同步到存储，成功 {}；不写入新内容。
// 例如对目录先返回 EISDIR，以统一 Windows/Unix；其他 stat 失败不在预检阶段返回，由 open 诊断。
pub fn fsync(path: &str) -> Outcome<Value> {
    // POSIX refuses to open a directory for writing; check first so Windows reports the same.
    // is_ok_and 只在成功取得元数据后执行目录判断；这是磁盘状态检查，不是类型检查。
    if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(Failure::new(
            "EISDIR",
            format!("EISDIR: illegal operation on a directory, open '{path}'"),
        )
        .path(path));
    }
    let file = open_existing_for_write(path)?;
    // sync_all 是实际持久化请求，失败保留 fsync 操作名。
    file.sync_all()
        .map_err(|error| Failure::io(&error, "fsync", path))?;
    Ok(json!({}))
}

// 将 from 重命名到 to，成功 {}；例如 a->b 的替换规则交给平台 sys::rename。
// 真实移动失败时错误消息包含两个路径；没有复制文件或跨设备回退。
pub fn rename(from: &str, to: &str) -> Outcome<Value> {
    sys::rename(from, to)
        .map(|()| json!({}))
        .map_err(|error| Failure::io_between(&error, "rename", from, Some(to)))
}

/// Node's `fs.rm`: missing paths fail unless `force`; a directory without `recursive` fails with `ERR_FS_EISDIR`.
// 删除路径，返回 {}；recursive 控制目录递归，force 只容忍首次 lstat 的路径不存在。
// 例如目录 d 在 recursive=false 时返回 ERR_FS_EISDIR；链接按链接本身删除，不递归其目标。
pub fn rm(path: &str, recursive: bool, force: bool) -> Outcome<Value> {
    // lstat 而非 stat 决定删除类别，避免把指向目录的链接误当真实目录。
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if force && error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(Failure::io(&error, "lstat", path)),
    };
    // 目录与其他节点使用不同删除入口；在检查后发生的竞态仍可能返回 rm 错误。
    let result = if metadata.is_dir() {
        if !recursive {
            return Err(Failure::new(
                "ERR_FS_EISDIR",
                format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
            )
            .path(path));
        }
        // 只有显式 recursive 才执行整棵目录树删除。
        fs::remove_dir_all(path)
    } else {
        // Windows 的只读重试和目录链接删除也在 sys 中适配。
        sys::remove_file(path)
    };
    result
        .map(|()| json!({}))
        .map_err(|error| Failure::io(&error, "rm", path))
}

/// A new directory named `prefix` plus six random characters, as libuv's `mkdtemp` creates it.
// 创建 prefix 后带六个随机字符的新目录，返回 {path}；例如 /tmp/x- 变成 /tmp/x-aB3dE9。
// 示例名字不固定；失败消息中的 XXXXXX 是模板，而非已创建的路径。
pub fn mkdtemp(prefix: &str) -> Outcome<Value> {
    sys::mkdtemp(prefix)
        .map(|path| json!({ "path": path }))
        .map_err(|error| Failure::io(&error, "mkdtemp", &format!("{prefix}XXXXXX")))
}

/// Open a regular file for positional reads; directories fail with `EISDIR`, other non-regular files with
/// `NOT_REGULAR`, and with `no_follow` a final symbolic link with `SYMLINK`.
// 打开可定位读取的普通文件，返回句柄和元数据 JSON；no_follow 拒绝最终链接。
// 例如 FIFO 不符合普通文件要求而报 NOT_REGULAR；平台打开、fstat 和类别检查可分别失败。
pub fn open_reader(path: &str, no_follow: bool) -> Outcome<(File, Value)> {
    // 平台层负责非阻塞打开/拒绝链接；? 不把失败句柄传给下一步。
    let file = sys::open_reader(path, no_follow)?;
    // 查询已打开句柄而非再次按路径 stat，元数据对应实际打开的对象。
    let metadata = file
        .metadata()
        .map_err(|error| Failure::io(&error, "fstat", path))?;
    // 目录使用 EISDIR，其他非普通对象使用 NOT_REGULAR，供客户端映射不同错误。
    if metadata.is_dir() {
        return Err(
            Failure::new("EISDIR", "EISDIR: illegal operation on a directory, read").path(path),
        );
    }
    if !metadata.is_file() {
        return Err(Failure::new("NOT_REGULAR", "Not a regular file").path(path));
    }
    // 同名局部变量只保存 JSON；右侧 info 仍指上方函数。
    let info = info(path, &metadata);
    Ok((file, info))
}

/// Up to `length` bytes at `offset`; fewer only at the end of the file.
// 从绝对字节偏移 offset 尽量读 length 字节，返回实际字节；不改变句柄当前位置。
// 例如尾部只余 2 字节时读 10 得到长度 2；中断重试，其他系统错误返回 read Failure。
pub fn pread(file: &File, path: &str, offset: u64, length: usize) -> Outcome<Vec<u8>> {
    // Vec 初始化出可写长度；filled 跟踪实际写入的前缀，而不是缓冲容量。
    let mut buffer = vec![0u8; length];
    let mut filled = 0;
    // 短读可继续；后续切片只暴露未填部分，偏移同步向前移动。
    while filled < length {
        match sys::read_at(file, &mut buffer[filled..], offset + filled as u64) {
            // 0 是 EOF；Interrupted 是临时信号中断，空分支后下一轮重新读。
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
    // 去掉未填的零字节，结果不会误报请求长度。
    buffer.truncate(filled);
    Ok(buffer)
}

/// Up to `length` bytes from the current position: one `read` call, as Node's `readFile` makes for files of unknown
/// size (FIFOs, devices).
// 从当前位置执行一次成功的顺序读取，返回至多 length 字节；适用于 FIFO/设备等未知大小输入。
// 例如第一次成功短读 3 字节就返回 3，不像 pread 继续填满；Interrupted 才重试，可能阻塞。
pub fn read(mut file: &File, path: &str, length: usize) -> Outcome<Vec<u8>> {
    // mut 修饰借用绑定；Read 在 &File 上实现，底层共享句柄的位置仍会改变。
    let mut buffer = vec![0u8; length];
    loop {
        // 任何成功读取（包括 EOF 的 0）都截短缓冲并立即返回。
        match file.read(&mut buffer) {
            Ok(read) => {
                buffer.truncate(read);
                return Ok(buffer);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(Failure::io(&error, "read", path)),
        }
    }
}

/// One directory entry as Node lists it: the name decoded as UTF-8 (invalid bytes replaced), and lstat of the
/// directory joined with that decoded name, so a name that is not valid UTF-8 reports `ENOENT` as in Node. `raw`
/// carries the original bytes of such a name, which libuv sorts by.
// 把一次目录项转换为 {name,info} 或 {name,error}，必要时附原始字节 raw；不抛整页错误。
// 例如 Unix 非 UTF-8 名字先以替换字符拼路径，再 lstat，可能得到 ENOENT；raw 保留排序依据。
pub fn dir_entry(dir: &str, file_name: &OsStr) -> Value {
    // to_string_lossy 将无效编码替换；into_owned 让返回 JSON 不再借用原 OsStr。
    let name = file_name.to_string_lossy().into_owned();
    // 特意使用已解码 name，而不是原始 file_name，以匹配 Node 的查找语义。
    let entry_path = Path::new(dir).join(&name).to_string_lossy().into_owned();
    let mut entry = match fs::symlink_metadata(&entry_path) {
        Ok(metadata) => json!({ "name": name, "info": info(&entry_path, &metadata) }),
        Err(error) => {
            json!({ "name": name, "error": Failure::io(&error, "lstat", &entry_path).to_json() })
        }
    };
    // 仅原字节与 UTF-8 显示字节不同才附加 raw；Windows raw_name 返回 None。
    if let Some(raw) = sys::raw_name(file_name).filter(|raw| *raw != name.as_bytes()) {
        entry["raw"] = json!(raw);
    }
    entry
}
