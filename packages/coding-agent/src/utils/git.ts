// 解析包来源中的Git地址，供包管理器和资源界面识别仓库/引用；全程只处理文字，不联网、不clone、不验证仓库或ref存在。
// hosted-git-info处理常见托管站写法，其他域名走通用解析；最终仅对安装目录会用到的host/path做此处定义的路径检查。
import hostedGitInfo from "hosted-git-info";

/**
 * Parsed git URL information.
 */
export type GitSource = {
	/** Always "git" for git sources */
	// 字面量类型用作联合来源类型的判别标签，不是任意字符串。
	type: "git";
	/** Clone URL (always valid for git clone, without ref suffix) */
	// 供后续git clone使用的仓库文字，已按本解析器规则拆除@ref；这里不实际试运行git验证可访问性。
	repo: string;
	/** Git host domain (e.g., "github.com") */
	// 安装位置/身份归类所用主机；URL分支取hostname，不包含端口、账号或密码。
	host: string;
	/** Repository path (e.g., "user/repo") */
	// 去掉末尾.git和前导/后的仓库路径，至少有两段；通用站点允许多级组路径。
	path: string;
	/** Git ref (branch, tag, commit) if specified */
	// ?表示可省略，文字可含分支斜杠；这里不校验git ref语法或目标存在。
	ref?: string;
	/** True if ref was specified. `pi update` reconciles the checkout to the ref but does not move the ref. */
	// 根据最终ref的真值生成，不意味着必须固定commit哈希，命名分支/标签也会标true。
	pinned: boolean;
};

// 按本项目@ref约定拆仓库和引用，输入地址文字，返回{repo,ref?}，无I/O；无法完整拆分则原串作为repo。
// 分别处理git@host:path、协议URL、host/path；只找仓库路径里的首个@，不把ssh账号git@当ref。
// 例如git@host:group/repo@feature/x拆成仓库git@host:group/repo和feature/x；空repoPath/空ref不拆。
function splitRef(url: string): { repo: string; ref?: string } {
	// 正则捕获主机和冒号后的路径，仅针对字面git@开头的scp式地址。
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	// match结果非null时，先走scp分支而非URL构造器。
	if (scpLikeMatch) {
		// 捕获组2是仓库路径及可选引用，??为类型允许的缺省提供空串。
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		// 只在路径中查@，避免主机前的git@误判；分支名剩余@不继续拆分。
		const refSeparator = pathWithMaybeRef.indexOf("@");
		// 没有分隔符保持输入不变，不添加ref字段。
		if (refSeparator < 0) return { repo: url };
		// slice终点不包含@本身。
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		// @后全部剩余文字属于引用，允许feature/x形式。
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		// 任一半为空时不认为它是完整引用写法。
		if (!repoPath || !ref) return { repo: url };
		return {
			// 重建仅去掉引用的scp地址，保留输入捕获的主机。
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			// 属性简写等于ref:ref，保留引用文字，不在此解码。
			ref,
		};
	}

	// 有协议分隔符时先让URL解析账号、主机、路径，避免从账号中的@拆错。
	if (url.includes("://")) {
		try {
			// URL构造器会执行其标准规范化并可抛错；不发网络请求。
			const parsed = new URL(url);
			// 只在pathname去前导斜杠，查询参数/hash不在这段@引用搜索范围内。
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			// 查路径首个@，不是地址中的账号分隔符。
			const refSeparator = pathWithMaybeRef.indexOf("@");
			// 无@时保持原地址文字，避免无必要的URL重写。
			if (refSeparator < 0) return { repo: url };
			// 从路径中分离仓库部分与剩余引用。
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			// 引用可能包含路径斜杠，不继续按/切掉它。
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			// 只有完整两边都有值时才采用拆分。
			if (!repoPath || !ref) return { repo: url };
			// 修改URL对象路径，账号/主机等其他组成保持URL对象当前值。
			parsed.pathname = `/${repoPath}`;
			return {
				// toString序列化地址，再去掉最末一个/；并非完整URL净化器。
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			// 解析失败不在拆分阶段抛错，后续地址解析层再判断是否接受。
			return { repo: url };
		}
	}

	// 非协议/非scp写法将首段视为host，余下部分视为仓库路径。
	const slashIndex = url.indexOf("/");
	// 缺斜杠无法分出仓库路径，保持原串交后续识别。
	if (slashIndex < 0) {
		return { repo: url };
	}
	// 保留第一段原文字，具体域名形式由后面的通用解析检查。
	const host = url.slice(0, slashIndex);
	// 路径部分可能带本项目@ref后缀。
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	// 同样只查路径中第一个@。
	const refSeparator = pathWithMaybeRef.indexOf("@");
	// 没引用后缀时不重建地址。
	if (refSeparator < 0) {
		return { repo: url };
	}
	// 从分隔符前后取两个新字符串，原输入不变。
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	// 包含后面所有字符，而非只取最后一个路径段。
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	// 空路径或空引用仍不视为完整后缀。
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		// 仓库只保留host/路径，引用另存，后续调用方负责选择协议。
		repo: `${host}/${repoPath}`,
		ref,
	};
}

// 尝试解码一次百分号转义用于路径验证，输入字符串，返回解码串或null，无副作用。
// 例如%2F变/、无效%序列抛URIError时变null；不是反复解码直到稳定，也不把+转空格。
function decodeForValidation(value: string): string | null {
	try {
		// 对整个输入片段解码，而非URL解析或仓库下载。
		return decodeURIComponent(value);
	} catch {
		// 无法解码视作不安全候选的标记，交上层拒绝。
		return null;
	}
}

// 检查安装目录片段的若干危险形式，输入片段和是否允许/，返回是否发现问题，无I/O。
// 同查原串及一次解码结果：拒绝NUL、反斜杠、绝对/开头、..路径段；例如user/%2e%2e/repo会被拒绝。
// allowSlash=false用于host，true用于仓库多级路径；它不验证所有域名/URL规则，也不检查ref或文件系统实际归属。
function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
	// 先解码，避免只检查表面文字而放过编码后的路径分隔符/上级目录。
	const decoded = decodeForValidation(value);
	// 非法编码直接判为不接受，不拿原串继续假装检查通过。
	if (decoded === null) {
		return true;
	}
	// 两份候选都检查，返回值本身仍保留原来的地址/路径编码。
	const candidates = [value, decoded];
	// 任一表现形式命中危险规则就立即返回true。
	for (const candidate of candidates) {
		// NUL可能破坏路径API输入，反斜杠/前导斜杠可能改变安装位置解释。
		if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) {
			return true;
		}
		// host不应再含目录分隔符；仓库路径则允许组/项目多段。
		if (!allowSlash && candidate.includes("/")) {
			return true;
		}
		// 拒绝完整上级段..，不误把普通名称repo..name当上级目录。
		if (candidate.split("/").includes("..")) {
			return true;
		}
	}
	// 这组规则未发现问题，不表示仓库存在、ref有效或最终操作必定安全。
	return false;
}

// 从各解析器结果构造统一GitSource，输入仓库文字/host/path/可选ref，返回对象或null，不联网。
// 去path末尾.git、检查非空及至少两段，然后执行安装路径检查；例如group/repo.git转group/repo，repo原克隆文字保持输入。
// ref只决定返回字段和pinned真值，不走host/path校验，因此pinned表示指定引用而非验证它不可变。
function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): GitSource | null {
	// 先拒绝传入的绝对路径，不能因为随后去前导/而掩盖它原本绝对的事实。
	if (args.path.startsWith("/")) {
		return null;
	}
	// 仅去小写.git末尾和前导/；不是realpath、分隔符全面转换或大小写折叠。
	const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
	// host/path必须非空，路径至少两段；这里只数段，不额外要求每段都非空。
	if (!args.host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}
	// 主机不允许斜杠，仓库路径允许多级，任一不通过都拒绝。
	if (hasUnsafeGitInstallPart(args.host, false) || hasUnsafeGitInstallPart(normalizedPath, true)) {
		return null;
	}

	return {
		// 标记为Git来源，供上层联合类型分支分流。
		type: "git",
		// 克隆地址原样保留本阶段输入，不用规范化path倒推替换地址。
		repo: args.repo,
		// host供安装缓存目录和来源展示使用。
		host: args.host,
		// 安装身份路径使用去.git后的版本。
		path: normalizedPath,
		// 引用可缺省，没有在这里创建/切换本地分支。
		ref: args.ref,
		// Boolean将非空引用转true，undefined/空串转false。
		pinned: Boolean(args.ref),
	};
}

// 托管站识别失败后的通用地址解析，输入文字，返回统一GitSource或null，无I/O。
// 支持git@host:path、固定协议前缀和带点域名/localhost简写；例如git.example/group/sub/repo允许多级组，裸user/repo拒绝。
// 先拆@ref，再从地址取host/path，最后共用安装路径验证；协议分支的startsWith为大小写敏感，不应从入口正则i推断所有大小写协议都一定接受。
function parseGenericGitUrl(url: string): GitSource | null {
	// 解构重命名把repo字段取为repoWithoutRef，避免与下面可重写的repo混淆。
	const { repo: repoWithoutRef, ref } = splitRef(url);
	// 通用简写分支可能补https://，因此地址变量可修改。
	let repo = repoWithoutRef;
	// 先声明空值，后面互斥分支填入，最终由buildGitSource验证。
	let host = "";
	// 路径是仓库位置而非ref，拆分时已单独保留引用。
	let path = "";

	// SCP风格只认git@账号写法。
	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	// 如果正则匹配，直接从捕获组取host和path，不用URL构造器解释冒号。
	if (scpLikeMatch) {
		// 捕获组缺值的类型回退不表示任意空host会被接受，最终仍统一验证。
		host = scpLikeMatch[1] ?? "";
		// 冒号后的路径可能含多级组或.git后缀。
		path = scpLikeMatch[2] ?? "";
	} else if (
		// 各行是同一或条件：这些协议由URL构造器处理，未添加file://等其他协议。
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		try {
			// URL负责语法分解/标准规范化，不进行DNS或仓库访问。
			const parsed = new URL(repoWithoutRef);
			// hostname不带端口；repo仍保留克隆地址上的账号/端口等文字。
			host = parsed.hostname;
			// URL路径最前的/是地址分隔符，取出仓库相对部分。
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			// 非法URL不抛给包来源分类器，让它知道这里不接受为Git来源。
			return null;
		}
	} else {
		// 无协议时必须能拆成主机/仓库路径。
		const slashIndex = repoWithoutRef.indexOf("/");
		// 单独主机或单词不是可安装仓库。
		if (slashIndex < 0) {
			return null;
		}
		// 首段作为host，其后全部作为path，不限定只有两级组/项目。
		host = repoWithoutRef.slice(0, slashIndex);
		// 从首个/后开始，不丢掉更深子组。
		path = repoWithoutRef.slice(slashIndex + 1);
		// 裸主机至少含点或正好localhost，避免把普通user/repo通用化为任意域名。
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		// 被接受的无协议形式默认补HTTPS，不在此尝试SSH连接。
		repo = `https://${repoWithoutRef}`;
	}

	// 所有分支共用相同字段/路径检查与pinned规则。
	return buildGitSource({ repo, host, path, ref });
}

/**
 * Parse git source into a GitSource.
 *
 * Rules:
 * - With git: prefix, accept all historical shorthand forms.
 * - Without git: prefix, only accept explicit protocol URLs.
 */
// 对外Git来源识别入口，输入用户/配置来源文字，返回GitSource或null；不安装、不执行git，也不保证引用可访问。
// 无来源标签时入口正则只放行显式协议；以git:开头则先剥标签后尝试历史简写，例如git:github.com/user/repo@v1。
// 先用hosted-git-info尝试原候选及补HTTPS候选，命中即交统一构造；都没识别才走通用域名解析，不是遍历所有候选选最好结果。
export function parseGitUrl(source: string): GitSource | null {
	// 只清理来源两端空白，不删除地址内部空格。
	const trimmed = source.trim();
	// 这是大小写精确的文字前缀检查；git://也会命中并被剥掉git:，不能从后面的协议正则推断这种输入一定被接受。
	const hasGitPrefix = trimmed.startsWith("git:");
	// 有标签时剥掉前四字符并再trim，避免git: 后空格影响地址识别。
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	// 没有来源标签时，不把普通host/path或git@...误当显式Git来源；正则i仅控制这里的匹配。
	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	// 先按本项目@引用约定拆一次，供托管库的#引用格式和最终repo字段使用。
	const split = splitRef(url);

	// 优先尝试把@ref改成托管库识别的#ref，再试原地址；无ref时第一项undefined被filter移除。
	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		// 类型谓词告诉TS过滤后是string[]，Boolean在运行时去掉undefined/空字符串。
		(value): value is string => Boolean(value),
	);
	// 保持候选优先级，识别成功后立即返回，不做网络检查。
	for (const candidate of hostedCandidates) {
		// 第三方只解析已支持托管站的地址形状，未知站点返回undefined。
		const info = hostedGitInfo.fromUrl(candidate);
		// 有解析结果才读取其domain/user/project/committish字段。
		if (info) {
			// 已拆ref却仍在project里保留@的候选说明拆法未被库正确解释，跳过它。
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			// 已有这些协议或scp形式就保留原地址，其余托管简写统一尝试补HTTPS。
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			// 返回统一检查结果，即使结果null也不会继续尝试其他候选；不从库的https()方法生成clone地址。
			return buildGitSource({
				// 用拆掉@ref后的地址按上述条件补HTTPS，保留本实现的重建规则。
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				// 库的domain无值则空串，统一构造器会拒绝缺主机。
				host: info.domain || "",
				// 模板字符串由库的用户/项目字段组成身份路径，后面去末尾.git。
				path: `${info.user}/${info.project}`,
				// 库识别出的非空引用优先，其次本项目@ref，再缺省undefined。
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	// 第一轮未命中再尝试加HTTPS的写法，主要兼容host/path；已有协议的输入也会机械形成候选，不保证都有效。
	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		// 同一类型收窄规则，让for...of中的candidate确定为string。
		(value): value is string => Boolean(value),
	);
	// 再按顺序让托管库尝试，成功即构造统一对象。
	for (const candidate of httpsCandidates) {
		// 不会发HTTP请求，fromUrl只解释字符串。
		const info = hostedGitInfo.fromUrl(candidate);
		// 未识别返回undefined就继续下个候选。
		if (info) {
			// 与第一轮相同，避免把尚残留@引用的项目名当正确解析结果。
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			// 第二轮采用补HTTPS地址，其余字段/路径检查与第一轮一致。
			return buildGitSource({
				// clone文字去@ref，引用单独保存。
				repo: `https://${split.repo}`,
				// 仅从库读取主机，缺省会由构造器拒绝。
				host: info.domain || "",
				// 使用托管库识别的用户/仓库作为安装身份路径。
				path: `${info.user}/${info.project}`,
				// 库的#引用优先，兼容本项目@引用回退。
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	// 托管站两轮均未识别，最后支持自建Git域名/localhost等通用形式，仍执行统一路径检查。
	return parseGenericGitUrl(url);
}
