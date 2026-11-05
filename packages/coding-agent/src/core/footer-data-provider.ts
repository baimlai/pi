// 页脚数据来源：发现当前仓库/工作树的HEAD，监听Git变化缓存分支，并保存扩展状态与供应商计数。
// 同步/异步调用本机git查询特殊HEAD表示；不调用git fetch或远端服务器。type标记的异常类型只用于编译。
import { type ExecFileException, execFile, spawnSync } from "child_process";
// 文件读取、fs.watch句柄和watchFile轮询；Stats是文件元数据类型，不是目录内容。
import { existsSync, type FSWatcher, readFileSync, type Stats, statSync, unwatchFile, watchFile } from "fs";
// dirname向父目录走，join拼路径，resolve解析gitdir/commondir里的相对路径。
import { dirname, join, resolve } from "path";
// 复用监听错误处理/关闭辅助；包装的fs.watch同步创建失败或异步error都会进入清理/延后重建路径。
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

// Git元数据的三个不同位置，worktree时尤其不能把它们当作一个目录。
export type GitPaths = {
	// 发现.git的工作树目录，不一定等于调用方最初cwd。
	repoDir: string;
	// 共享Git元数据目录，worktree通常通过commondir指向主仓库.git。
	commonGitDir: string;
	// 本工作树自己的HEAD路径，可能位于共享.git/worktrees/某项内。
	headPath: string;
};

/**
 * Find git metadata paths by walking up from cwd.
 * Handles both regular git repos (.git is a directory) and worktrees (.git is a file).
 */
/**
 * 从cwd逐级向上找.git，支持目录仓库和gitdir指针文件；成功返回路径信息，缺失/读错返回null。
 * 例：/repo/src内启动可找到/repo/.git；worktree的.git文件可指向另一处元数据。同步只读探测，不验证对象库或远端。
 * 已识别的Git元数据位置缺HEAD则null，不继续拿更外层仓库替代；这里只检查HEAD存在，没有验证正文是否合法。
 */
export function findGitPaths(cwd: string): GitPaths | null {
	// 从原cwd开始，未在这里统一realpath/绝对化，调用方通常传已解析目录。
	let dir = cwd;
	// 持续向上扫描，找到可用元数据或到根才return。
	while (true) {
		// 每层候选都是当前目录下.git。
		const gitPath = join(dir, ".git");
		// 候选存在才读取，存在检查与随后读取不是原子操作。
		if (existsSync(gitPath)) {
			// 已发现.git的stat/读取异常统一转null。
			try {
				// 跟随stat语义获取文件类型。
				const stat = statSync(gitPath);
				// worktree/分离git目录常以普通文本文件保存gitdir指针。
				if (stat.isFile()) {
					// 读UTF-8并裁两端空白；不执行文件中的内容。
					const content = readFileSync(gitPath, "utf8").trim();
					// 只接受这一明确前缀，其他文件内容不按gitdir解析。
					if (content.startsWith("gitdir: ")) {
						// 去掉前缀并相对当前工作树解析实际gitDir；绝对路径会按resolve规则覆盖前基准。
						const gitDir = resolve(dir, content.slice(8).trim());
						// HEAD属于本工作树专用gitDir。
						const headPath = join(gitDir, "HEAD");
						// 缺HEAD便返回null，不假装已找到可显示分支的仓库。
						if (!existsSync(headPath)) return null;
						// commondir可指向共享元数据目录，主要用于reftable监听。
						const commonDirPath = join(gitDir, "commondir");
						// 有commondir文件就读它，否则共享目录就是gitDir自身。
						const commonGitDir = existsSync(commonDirPath)
							? // 按gitDir而非原cwd解析commondir相对内容。
								resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: // 无commondir时采用当前gitDir。
								gitDir;
						// 返回工作树目录、共享目录、专用HEAD三者。
						return { repoDir: dir, commonGitDir, headPath };
					}
					// 普通仓库.git是目录，直接从其内部找HEAD。
				} else if (stat.isDirectory()) {
					// 拼普通仓库HEAD。
					const headPath = join(gitPath, "HEAD");
					// 普通仓库也要求HEAD存在。
					if (!existsSync(headPath)) return null;
					// repoDir为当前层，commonGitDir为这个.git目录。
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
				// 权限、读取、stat等故障在此吞掉并用null表示无法定位。
			} catch {
				// 不打印错误，不向用户声称仓库已损坏。
				return null;
			}
		}
		// 当前层没得到结果，尝试父目录。
		const parent = dirname(dir);
		// 根的dirname等于自己，返回null终止循环。
		if (parent === dir) return null;
		// 推进扫描位置，不修改进程cwd。
		dir = parent;
	}
}

/** Ask git for the current branch. Returns null on detached HEAD or if git is unavailable. */
/**
 * 同步询问git当前符号分支名，返回非空短名或null；只在特殊HEAD回退时用。
 * 例：detached HEAD、git不可用或命令非零均null。spawnSync会阻塞线程，禁用git可选锁避免为只读显示做多余锁操作。
 */
function resolveBranchWithGitSync(repoDir: string): string | null {
	// argv分开传，symbolic-ref查询HEAD引用，--quiet不输出普通失败提示，--short去掉refs/heads/。
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		// 在已发现仓库目录运行，而不是依赖当前process.cwd。
		cwd: repoDir,
		// 请求UTF-8文本输出，后续可trim。
		encoding: "utf8",
		// stdin忽略、stdout捕获、stderr忽略；不把错误日志混进页脚分支名。
		stdio: ["ignore", "pipe", "ignore"],
	});
	// 只有status=0才读取stdout；其他状态/启动错误统一空串。
	const branch = result.status === 0 ? result.stdout.trim() : "";
	// ||把空字符串转null，不把空名字当有效分支。
	return branch || null;
}

/** Ask git for the current branch asynchronously. Returns null on detached HEAD or if git is unavailable. */
/**
 * 异步询问相同的git分支，返回Promise<string|null>；回调报告错误时resolve(null)。
 * 例：reftable的HEAD只写.invalid，借git读取真实分支。没有配置超时/取消信号；外层dispose不能强行终止已启动git。
 */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	// Promise构造器用resolvePromise区分路径模块的resolve函数。
	return new Promise((resolvePromise) => {
		// execFile执行程序+参数，不经shell解释命令串。
		execFile(
			// 程序名git由系统PATH解析。
			"git",
			// 与同步版本完全相同的只读查询参数。
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			// 执行选项对象。
			{
				// 固定在目标仓库目录。
				cwd: repoDir,
				// UTF-8使回调stdout为string。
				encoding: "utf8",
			},
			// 回调参数带类型注解；异常是子进程边界结果，不是从输出文字猜测。
			(error: ExecFileException | null, stdout: string) => {
				// 回调报告错误时不把stderr当分支名。
				if (error) {
					// 正常resolve(null)，不是reject这类命令失败。
					resolvePromise(null);
					// 提前return避免继续处理无效stdout。
					return;
				}
				// 成功时裁掉git输出末尾换行。
				const branch = stdout.trim();
				// 空名字也映射null。
				resolvePromise(branch || null);
			},
		);
	});
}

/**
 * 按linux平台和两个WSL环境变量判断是否采用特殊监听策略；不探测/proc，也不保证WSL互操作可用。
 * 例：linux且WSL_INTEROP非空返回true；变量值是字符串"0"也是真值。
 */
function isWslEnvironment(): boolean {
	// &&短路后用!!把环境字符串/undefined转布尔。
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/**
 * 按/mnt/盘符路径形式猜测Windows挂载仓库，返回布尔，不访问文件系统。
 * 例：/mnt/c/repo命中，/mnt/cat不命中；自定义挂载位置不由此规则识别。
 */
function isWindowsMountedRepoPath(repoDir: string): boolean {
	// i使盘符大小写无关，(?:/|$)要求盘符后是斜杠或结尾。
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

/**
 * 只有WSL环境且仓库在标准Windows盘挂载路径时，额外轮询HEAD。
 * 例：WSL中的/home/me/repo仍主要依赖fs.watch，不启用这个补充HEAD轮询。
 */
function shouldPollGitHead(repoDir: string): boolean {
	// 两个必要条件都成立才true。
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/**
 * Provides git branch and extension statuses - data not otherwise accessible to extensions.
 * Context usage on ctx.getContextUsage(), token stats on ctx.sessionManager.getEntries(), model info on ctx.model.
 */
/**
 * 维护页脚分支、扩展状态和可用供应商数；构造会探测仓库并创建监听，销毁需dispose。
 * 分支结果懒缓存、变更去抖后异步刷新；状态文本和计数由外部写入，本类不计算模型用量/上下文。
 */
export class FooterDataProvider {
	// 实例当前工作目录，用于重新建立仓库观察位置。
	private cwd: string;
	// static为类共享常量，readonly/private是TS约束；等待500ms合并频繁文件事件。
	private static readonly WATCH_DEBOUNCE_MS = 500;

	// Map按扩展状态key保存文字，覆盖同key而非累计多份。
	private extensionStatuses = new Map<string, string>();
	// undefined未查询，null无法取得分支，字符串包括正常分支或detached。
	private cachedBranch: string | null | undefined = undefined;
	// 构造/切目录时探测的Git位置；null表示没有，undefined是初始状态。
	private gitPaths: GitPaths | null | undefined = undefined;
	// HEAD所在目录的事件监听器。
	private headWatcher: FSWatcher | null = null;
	// 额外watchFile轮询的HEAD路径；仅某些WSL路径启用。
	private headWatchFilePath: string | null = null;
	// 保留准确轮询回调引用，便于unwatchFile只移除自己的HEAD订阅。
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	// reftable目录的监听器，用来补充HEAD不变的分支切换。
	private reftableWatcher: FSWatcher | null = null;
	// tables.list单文件事件监听器。
	private reftableTablesListWatcher: FSWatcher | null = null;
	// 保存tables.list路径，清理时取消该路径watchFile轮询。
	private reftableTablesListPath: string | null = null;
	// Set去重回调；同函数重复订阅仍只有一个集合项。
	private branchChangeCallbacks = new Set<() => void>();
	// 外部设置的可用供应商数量，初始0，不在本类验证/重新统计。
	private availableProviderCount = 0;
	// 去抖定时器句柄；ReturnType<typeof setTimeout>复用当前平台返回类型。
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	// 监听故障后的重建定时器，与普通刷新定时器分开。
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	// 异步分支查询是否正在进行，避免重叠启动刷新。
	private refreshInFlight = false;
	// 查询期间又有变化就记一位，结束后再安排一次，不逐个事件积压。
	private refreshPending = false;
	// dispose后的刷新/重试保护标志，不是所有公开setter都检查它。
	private disposed = false;

	/**
	 * 记录cwd、同步探测Git位置并启动文件监听；尚不一定读取/缓存分支名。
	 * 例：UI建FooterDataProvider后可getGitBranch，退出时dispose释放监听。建对象有文件系统/监听副作用，不是纯数据构造。
	 */
	constructor(cwd: string) {
		// 保存传入目录，不调用process.chdir。
		this.cwd = cwd;
		// 首次定位HEAD/common目录。
		this.gitPaths = findGitPaths(cwd);
		// 若有Git位置，尝试建立事件/轮询监听。
		this.setupGitWatcher();
	}

	/** Current git branch, null if not in repo, "detached" if detached HEAD */
	/**
	 * 同步读取最近缓存分支；初次调用才读HEAD/必要时执行git，失败为null、分离HEAD为detached。
	 * 例：第一次main被缓存；随后文件变化由异步刷新更新，普通重复读取不每次启动git。
	 */
	getGitBranch(): string | null {
		// 只对undefined做懒初始化，null也会作为已查询结果缓存。
		if (this.cachedBranch === undefined) {
			// 同步取一次当前分支并保存。
			this.cachedBranch = this.resolveGitBranchSync();
		}
		// 返回缓存，不证明磁盘刚刚没有变化。
		return this.cachedBranch;
	}

	/** Extension status texts set via ctx.ui.setStatus() */
	/**
	 * 取得扩展状态Map的只读类型视图，无复制；getExtensionStatuses().get(key)读取外部已设文字。
	 * ReadonlyMap仅是TS调用面，不冻结底层Map，宿主setter的后续修改会被同一引用看到。
	 */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		// 原样返回内部Map引用，未排序或清理。
		return this.extensionStatuses;
	}

	/** Subscribe to git branch changes. Returns unsubscribe function. */
	/**
	 * 订阅分支变化，返回取消函数，不立刻回放当前分支。
	 * 例：const off=p.onBranchChange(redraw); off()移除；Set对同一函数引用去重，回调没有逐个try/catch隔离。
	 */
	onBranchChange(callback: () => void): () => void {
		// 加入回调集合。
		this.branchChangeCallbacks.add(callback);
		// 闭包按相同函数引用删除；delete的布尔结果不属于接口void承诺。
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** Internal: set extension status */
	/**
	 * 按key设置/删除扩展状态文本，返回void；不自动广播分支变化。
	 * 例：text=undefined删除，text=""仍保存空文本，不能把空串当删除。
	 */
	setExtensionStatus(key: string, text: string | undefined): void {
		// 只把undefined解释为删除。
		if (text === undefined) {
			// 删除该key，不影响其他扩展状态。
			this.extensionStatuses.delete(key);
		} else {
			// 同key覆盖文字，新key追加。
			this.extensionStatuses.set(key, text);
		}
	}

	/** Internal: clear extension statuses */
	/**
	 * 清空所有扩展状态，返回void；不关闭Git监听也不触发分支回调。
	 * 例：扩展重载清理旧setStatus显示可调用它。
	 */
	clearExtensionStatuses(): void {
		// Map.clear原地修改集合，已持有只读视图也会看到清空。
		this.extensionStatuses.clear();
	}

	/** Number of unique providers with available models (for footer display) */
	// 返回外部最近设置的供应商计数，无模型目录查询；例：尚未设置时为0。
	getAvailableProviderCount(): number {
		// 直接读字段，不从extensionStatuses条目数推算。
		return this.availableProviderCount;
	}

	/** Internal: update available provider count */
	/**
	 * 保存供应商计数，返回void，不做取整/范围验证或通知。
	 * 例：上层统计唯一可用供应商后setAvailableProviderCount(3)，页脚读取3。
	 */
	setAvailableProviderCount(count: number): void {
		// 按类型契约直接赋值，number不自动意味着非负整数。
		this.availableProviderCount = count;
	}

	/**
	 * 切换观察目录：取消待刷新、关闭旧监听、清缓存、重探测并通知UI。
	 * 例：会话切cwd后页脚可重新懒读该目录分支。字符串完全相同就跳过，不归一化再比较；不取消已经发出的异步git查询，也没有代次隔离其旧结果。
	 */
	setCwd(cwd: string): void {
		// 严格字符串相等才视为无需切换，软链接/大小写等价路径不在此合并。
		if (this.cwd === cwd) {
			// 相同cwd不重建监听或通知。
			return;
		}

		// 先更新当前目录。
		this.cwd = cwd;
		// 有待运行去抖计时器才取消。
		if (this.refreshTimer) {
			// 取消尚未执行的刷新任务，不取消已开始Promise。
			clearTimeout(this.refreshTimer);
			// 清句柄以允许新事件排队。
			this.refreshTimer = null;
		}
		// 关闭旧位置的事件/轮询监听及重试计时器。
		this.clearGitWatchers();
		// 恢复未查询状态，下次getGitBranch会同步读新位置。
		this.cachedBranch = undefined;
		// 按新cwd重找Git元数据。
		this.gitPaths = findGitPaths(cwd);
		// 重建监听；该方法会再做幂等清理。
		this.setupGitWatcher();
		// 即使新旧分支名可能相同，也通知观察位置发生变化；回调抛错可向调用方传出。
		this.notifyBranchChange();
	}

	/** Internal: cleanup */
	/**
	 * 标记已销毁，清待刷新/监听/订阅；返回void，不等已经进行的异步git退出。
	 * 例：UI退出时释放文件句柄。不会清扩展状态/计数，也不把后续setCwd等公开方法变成不可调用。
	 */
	dispose(): void {
		// 阻止后续普通异步刷新和重试生效。
		this.disposed = true;
		// 有去抖任务则取消。
		if (this.refreshTimer) {
			// 清定时器，不执行其回调。
			clearTimeout(this.refreshTimer);
			// 重置句柄。
			this.refreshTimer = null;
		}
		// 统一清事件和轮询资源。
		this.clearGitWatchers();
		// 清全部分支订阅，已进入执行的回调不由此终止。
		this.branchChangeCallbacks.clear();
	}

	/**
	 * 按Set顺序同步通知回调，无参数/返回值；不捕获个别回调异常。
	 * 例：第一个回调抛错会打断本次后续通知，不能称为逐监听器隔离的事件总线。
	 */
	private notifyBranchChange(): void {
		// 逐一调用，不await回调的异步尾部。
		for (const cb of this.branchChangeCallbacks) cb();
	}

	/**
	 * 合并变化请求：已销毁/已有去抖任务则忽略，刷新中只记pending，否则延迟500ms刷新。
	 * 例：500ms内连续十个文件事件可合成一次查询；不是每次事件重置500ms计时器。
	 */
	private scheduleRefresh(): void {
		// 已有timer直接return，因此这里是固定窗口合并，不是每次都延后执行。
		if (this.disposed || this.refreshTimer) return;
		// 查询进行中不并发再开一个。
		if (this.refreshInFlight) {
			// 标记查询完成后还需再刷新，多个事件合为同一位。
			this.refreshPending = true;
			// 不另开定时器。
			return;
		}
		// 创建一次延后刷新任务并保存句柄。
		this.refreshTimer = setTimeout(() => {
			// 回调执行时先清句柄，允许后续变化再次调度。
			this.refreshTimer = null;
			// 启动async查询但不await/加catch；若通知回调使Promise拒绝，void本身不吞异常。
			void this.refreshGitBranchAsync();
			// 共享500ms窗口。
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	/**
	 * 异步刷新缓存；查询期间收到变化则完成后再安排一次，dispose后不发布结果。
	 * 例：main→feature后缓存变化才通知，首次缓存未初始化时仅填值不通知。finally清inFlight，即便回调异常也能释放调度状态。
	 */
	private async refreshGitBranchAsync(): Promise<void> {
		// 销毁后不启动查询。
		if (this.disposed) return;
		// 若被其他路径同时调用且已有查询，只记pending。
		if (this.refreshInFlight) {
			// 保存补刷新需求。
			this.refreshPending = true;
			// 避免并行查询。
			return;
		}

		// 在await前标记进行中。
		this.refreshInFlight = true;
		// try/finally保证调度状态清理，没有catch吞掉所有异常。
		try {
			// 读HEAD通常同步，.invalid回退时异步调用git。
			const nextBranch = await this.resolveGitBranchAsync();
			// 等待期间若dispose，结果不再写回；不是按cwd代次过滤旧结果。
			if (this.disposed) return;
			// 已有缓存且值真的变化才广播，null/字符串之间变化也算。
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				// 通知前先更新缓存，使回调读到新值。
				this.cachedBranch = nextBranch;
				// 同步通知，异常可使此async方法拒绝。
				this.notifyBranchChange();
				// 变化分支处理完，finally仍会执行。
				return;
			}
			// 首次初始化或值不变都保存本次值，不通知。
			this.cachedBranch = nextBranch;
			// 正常返回/异常都会清理刷新状态。
		} finally {
			// 允许下轮刷新开始。
			this.refreshInFlight = false;
			// 存在积压且未销毁时再排一轮；不无限逐个重放事件。
			if (this.refreshPending && !this.disposed) {
				// 先消费pending标志。
				this.refreshPending = false;
				// 用同一500ms去抖调度，而非立即递归发查询。
				this.scheduleRefresh();
			}
		}
	}

	/**
	 * 同步解析已定位HEAD：普通ref直接取分支，.invalid询问git，其他内容视为detached，读取失败null。
	 * 例：ref: refs/heads/feature→feature；SHA文本→detached。仅按前缀解析，不额外校验HEAD内容格式。
	 */
	private resolveGitBranchSync(): string | null {
		// 包住文件读取和同步git回退中的异常。
		try {
			// 没发现仓库就返回null，不扫描第二次。
			if (!this.gitPaths) return null;
			// 同步读HEAD并trim。
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			// 只识别本地分支前缀，其他ref形态也走detached。
			if (content.startsWith("ref: refs/heads/")) {
				// 16是固定前缀长度，剩余部分作分支名。
				const branch = content.slice(16);
				// reftable的.invalid占位借git求真名，git取不到则detached；普通名字原样返回。
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			// 非普通分支ref按detached展示，不返回原SHA。
			return "detached";
			// 读取/程序异常不影响UI主流程，转null。
		} catch {
			// 无法读取分支，不在此打印故障。
			return null;
		}
	}

	/**
	 * 异步版本保持相同HEAD规则，只有.invalid时await git子进程。
	 * 例：普通main仍同步读文件后以Promise返回；catch把I/O/命令调用异常转null，但并不取消外部子进程。
	 */
	private async resolveGitBranchAsync(): Promise<string | null> {
		// 同一错误回退边界。
		try {
			// 无Git位置直接null。
			if (!this.gitPaths) return null;
			// 此async函数里的readFileSync仍会阻塞，不因函数名就变异步文件读取。
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			// 识别普通分支ref。
			if (content.startsWith("ref: refs/heads/")) {
				// 去前缀取分支候选。
				const branch = content.slice(16);
				// 三元表达式只在.invalid分支调用git。
				return branch === ".invalid"
					? // await异步git返回值，null回退detached。
						((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: // 普通分支直接采用文件中的名字。
						branch;
			}
			// 其他内容展示detached。
			return "detached";
			// 捕获读取与异步git调用异常。
		} catch {
			// 统一返回null，不拒绝这些内部I/O错误。
			return null;
		}
	}

	/**
	 * 关闭已保存的Git监听和监听重试计时器，返回void，不清缓存分支。
	 * 例：切cwd或dispose均复用；HEAD轮询按自己的callback移除，tables.list轮询按整个路径移除。
	 */
	private clearGitWatchers(): void {
		// 辅助吞掉关闭异常/允许null，具体边界见fs-watch。
		closeWatcher(this.headWatcher);
		// 置空旧HEAD事件句柄。
		this.headWatcher = null;
		// HEAD轮询路径和回调都存在才有精确取消目标。
		if (this.headWatchFilePath && this.headWatchFileListener) {
			// 仅移除该路径上自己的HEAD轮询回调。
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			// 清轮询路径。
			this.headWatchFilePath = null;
			// 清回调引用。
			this.headWatchFileListener = null;
		}
		// 关闭reftable目录事件监听。
		closeWatcher(this.reftableWatcher);
		// 清目录监听句柄。
		this.reftableWatcher = null;
		// 关闭tables.list文件事件监听。
		closeWatcher(this.reftableTablesListWatcher);
		// 清该事件句柄。
		this.reftableTablesListWatcher = null;
		// 有轮询路径才取消。
		if (this.reftableTablesListPath) {
			// 没有传回调，因此移除该路径的所有watchFile监听，不只某个自有监听。
			unwatchFile(this.reftableTablesListPath);
			// 清记录路径。
			this.reftableTablesListPath = null;
		}
		// 有故障重试任务则清除。
		if (this.gitWatcherRetryTimer) {
			// 避免旧目录的延后重建任务继续运行。
			clearTimeout(this.gitWatcherRetryTimer);
			// 清重试句柄。
			this.gitWatcherRetryTimer = null;
		}
	}

	/**
	 * 包装的fs.watch同步/异步失败后延迟一次重建；已销毁或已有重试任务则不再加任务。
	 * 例：EMFILE后等待共享重试间隔再尝试setup，实际能否恢复仍取决于系统资源。
	 */
	private scheduleGitWatcherRetry(): void {
		// 生命周期/去重保护。
		if (this.disposed || this.gitWatcherRetryTimer) {
			// 不创建额外计时器。
			return;
		}

		// 保存单次重试计时器。
		this.gitWatcherRetryTimer = setTimeout(() => {
			// 回调执行前先清句柄，使后续错误仍可重新安排。
			this.gitWatcherRetryTimer = null;
			// 重新建立当前gitPaths的监听，不重新发现仓库。
			this.setupGitWatcher();
			// 重试间隔来自共享文件监听辅助，不是这里的500ms刷新窗口。
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	/**
	 * 处理包装的fs.watch同步创建失败或异步error：先关整组相关监听，再排一次延后重建；返回void。
	 * 例：任意reftable监听报错会连HEAD监听也清掉，之后整组重建。
	 */
	private handleGitWatcherError(): void {
		// 避免残留部分失效监听句柄。
		this.clearGitWatchers();
		// 统一调度故障重试，而非立即循环建监听。
		this.scheduleGitWatcherRetry();
	}

	/**
	 * 按当前Git元数据建立HEAD目录事件、必要的WSL轮询和reftable双层监听。
	 * 先清旧句柄；无仓库直接返回。包装的fs.watch同步创建失败或异步error均经handleGitWatcherError清整组并安排重试；直接watchFile抛错没有包在这套重试里。
	 * 监听HEAD所在目录是为适应Git临时文件rename替换HEAD；事件只作为重新读取的提示，不把每个事件当成已确认分支变化。
	 */
	private setupGitWatcher(): void {
		// 先做清理，使重复setup不叠加相同监听。
		this.clearGitWatchers();
		// 没有定位到Git目录就不创建资源。
		if (!this.gitPaths) return;

		// 判断是否额外为WSL标准Windows盘路径轮询HEAD。
		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);

		// Watch the directory containing HEAD, not HEAD itself.
		// Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
		// fs.watch on a file stops working after the inode changes.
		// 建立目录fs.watch，辅助可在同步创建失败时返回null。
		this.headWatcher = watchWithErrorHandler(
			// 监控HEAD所在目录而非HEAD文件inode。
			dirname(this.gitPaths.headPath),
			// 事件类型参数以_命名表示本回调不使用，只关注文件名。
			(_eventType, filename) => {
				// 文件名缺失时保守刷新；已知文件名只有HEAD才触发。
				if (!filename || filename === "HEAD") {
					// 排去抖查询，不在fs回调里同步启动git。
					this.scheduleRefresh();
				}
			},
			// 包装器同步创建失败/异步error均调用该清理与重建回调。
			() => this.handleGitWatcherError(),
		);
		// WSL盘路径增加轮询，和目录事件可同时存在。
		if (pollGitHead) {
			// 保存轮询目标路径。
			this.headWatchFilePath = this.gitPaths.headPath;
			// 回调接收当前/上次Stats，闭包使用实例刷新方法。
			this.headWatchFileListener = (current, previous) => {
				// 任一元数据变化才刷新，不逐字比较HEAD内容。
				if (
					// 修改时间变化。
					current.mtimeMs !== previous.mtimeMs ||
					// 元数据变更时间变化。
					current.ctimeMs !== previous.ctimeMs ||
					// 文件大小变化。
					current.size !== previous.size
				) {
					// 将轮询发现变化合并到同一调度器。
					this.scheduleRefresh();
				}
			};
			// 每1000ms轮询HEAD，清理时使用保存的回调引用。
			watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
		}
		// 目录事件监听失败且没有轮询后备时，直接结束setup。
		if (!this.headWatcher && !pollGitHead) {
			// 不继续安装reftable监听；失败回调此前已安排重试，本分支不重复排任务。
			return;
		}

		// In reftable repos, branch switches update files in the reftable directory
		// instead of HEAD. Watch it separately so the footer picks up those changes.
		// reftable在共享git目录，worktree不能用专用HEAD目录代替。
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		// 只有发现reftable目录才加这组监听。
		if (existsSync(reftableDir)) {
			// 监听reftable目录变化。
			this.reftableWatcher = watchWithErrorHandler(
				// 目标目录路径。
				reftableDir,
				// 不区分目录中的具体文件，任何变化都可提示刷新。
				() => {
					// 仍通过同一去抖调度器。
					this.scheduleRefresh();
				},
				// 同步创建失败或异步error都触发整组清理/重建。
				() => this.handleGitWatcherError(),
			);
			// 创建失败的同步回调已清整组监听并安排重试；这里仅提前返回。
			if (!this.reftableWatcher) {
				// 不再继续设置tables.list层。
				return;
			}

			// 拼reftable清单文件位置。
			const tablesListPath = join(reftableDir, "tables.list");
			// 清单文件存在才监听；文件未来才创建时目录监听仍可提示变化，但此处不会自动在每次刷新补建该单文件监听。
			if (existsSync(tablesListPath)) {
				// 保存路径供清理轮询。
				this.reftableTablesListPath = tablesListPath;
				// 建立清单文件fs.watch。
				this.reftableTablesListWatcher = watchWithErrorHandler(
					// 明确文件路径。
					tablesListPath,
					// 清单事件不解析其正文，只提示分支刷新。
					() => {
						// 去抖刷新。
						this.scheduleRefresh();
					},
					// 错误处理仍走统一重建。
					() => this.handleGitWatcherError(),
				);
				// 单文件监听创建失败则不加下面watchFile轮询。
				if (!this.reftableTablesListWatcher) {
					// 同步失败回调已清整组并安排重试；不在这里再次关闭或重复排队。
					return;
				}
				// 除事件监听外，每250ms轮询清单元数据；匿名回调所以清理按整个路径取消。
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					// 只在三个元数据字段任一变化时刷新。
					if (
						// 修改时间变化。
						current.mtimeMs !== previous.mtimeMs ||
						// 状态变更时间变化。
						current.ctimeMs !== previous.ctimeMs ||
						// 大小变化。
						current.size !== previous.size
					) {
						// 轮询事件也复用同一调度器，不直接通知UI“已换分支”。
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/** Read-only view for extensions - excludes setExtensionStatus, setAvailableProviderCount and dispose */
/**
 * Pick按名字选出扩展可见的API类型，不生成运行时包装、不冻结实例。
 * 例：可getGitBranch和onBranchChange，但类型层面不暴露dispose/setExtensionStatus；onBranchChange仍会添加订阅，“只读视图”不等于绝无副作用。
 */
export type ReadonlyFooterDataProvider = Pick<
	// 被选取成员的原类型来自FooterDataProvider类。
	FooterDataProvider,
	// 联合字符串列出允许的四个方法名。
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
