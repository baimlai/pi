// 将pi-env连接异常/daemon错误映成Durable文件Result与FileError，并提供操作检查点的abort结果；只解释/包装失败，不执行文件IO或自动重试。
// err把失败包成{ok:false,error}，FileError是Durable的文件错误类；type Result给成功/失败标签联合，不存在运行时自动转换。
import { err, FileError, type Result } from "@earendil-works/pi-durable/env";
// RemoteError是连接层包装的daemon错误；仅它的code按下表映射，普通Node Error即使带类似code字段也不在此自动映射。
import { RemoteError } from "./connection.ts";

// 在调用检查点读取signal，已中止才返回失败Result，否则undefined表示继续操作。例abortResult<string>(signal,"/x")；泛型T匹配调用者期望成功值，不取消远端请求/发帧，无IO。
export function abortResult<T>(signal: AbortSignal | undefined, path?: string): Result<T, FileError> | undefined {
	// ?.让无signal得到undefined，真值分支创建aborted文件错误并保路径；只观察此刻状态，返回后仍可能被取消。
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/** `NodeExecutionEnv`'s mapping of Node error codes to `FileError` codes. */
// 把任意抛出值映为FileError：已有FileError原样返回，非RemoteError包unknown，否则按code分支保留cause。例ENOENT变not_found；不验证文件真实存在、不修路径、不重新发请求。
export function toFileError(error: unknown, fallbackPath?: string): FileError {
	// 已是本realm FileError就保留同一对象及原code/path，不用fallbackPath覆盖已有错误。
	if (error instanceof FileError) return error;
	// 只有RemoteError走daemon码表；这是unknown异常边界分类，不是对静态确定参数重复校验。
	if (!(error instanceof RemoteError)) {
		// 普通Error保作cause，其他抛值String化再建Error；自定义String转换仍可能抛，此函数没有额外catch吞掉它。
		const cause = error instanceof Error ? error : new Error(String(error));
		// unknown FileError用cause.message和备用路径，并把cause保在Error.cause；不把所有普通异常当远端ENOENT。
		return new FileError("unknown", cause.message, fallbackPath, cause);
	}
	// RemoteError有path则优先，??保留空字符串，仅null/undefined回备用路径；不做绝对路径解析。
	const path = error.path ?? fallbackPath;
	// switch按已摘取的字符串code精确选择，未知码最后统一unknown，非按message文字猜错误类别。
	switch (error.code) {
		// 远端aborted本身就是已知取消码，不靠本机signal是否此刻aborted猜测。
		case "aborted":
			// 转为文件aborted并保原RemoteError作cause。
			return new FileError("aborted", error.message, path, error);
		// Node ENOENT代表未找到路径/部分组件。
		case "ENOENT":
			// 输出Durable not_found，message不改写/脱敏，path用上面选定值。
			return new FileError("not_found", error.message, path, error);
		// EACCES常用于访问权限拒绝。
		case "EACCES":
		// EPERM也归相同permission_denied结果，而不是另加一种业务错误码。
		case "EPERM":
			// 两标签共用一个return，保留原远端cause便于诊断具体系统码。
			return new FileError("permission_denied", error.message, path, error);
		// ENOTDIR指需要目录的位置不是目录。
		case "ENOTDIR":
			// 映为not_directory，不把它泛化成not_found。
			return new FileError("not_directory", error.message, path, error);
		// EISDIR指对目录使用不支持的文件操作。
		case "EISDIR":
			// 映为is_directory；注意其他例如ERR_FS_EISDIR未在此case中，仍可能落unknown。
			return new FileError("is_directory", error.message, path, error);
		// EINVAL表示不合法参数/操作，和下面两个daemon检查码一起归invalid。
		case "EINVAL":
		// SYMLINK是daemon拒绝最终符号链接等场景的约定码，不在这里真的读取链接目标。
		case "SYMLINK":
		// NOT_REGULAR表示目标不是允许的普通文件类别。
		case "NOT_REGULAR":
			// 上述三种都映为invalid，保留具体原code在cause中；不删除原fields额外信息。
			return new FileError("invalid", error.message, path, error);
	}
	// 所有未列RemoteError码兜底unknown，包括仅协议/系统其他扩展码；不冒称本表穷尽Node或Rust错误。
	return new FileError("unknown", error.message, path, error);
}
