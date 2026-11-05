// The format checks of JSON Schema 2020-12, for compile()'s `formats` option. An optional entry point: schemas
// compiled without it treat `format` as an annotation and do not bundle these checks.
// 可选的字符串格式检查表：调用方显式传给compile(schema,{formats})才会采用已登记检查。
// 例{type:"string",format:"email"}配此表可拒绝"not an email"；不传对应条目时format只作说明。
// 本入口只组装函数引用，不立即校验字符串、不联网确认邮箱/域名存在，也不转换或清理输入。
// ./typebox下30份文件改编自TypeBox 1.3.27，MIT许可见packages/schema/LICENSES/typebox-LICENSE；保留第三方正文，学习清单单列来源。

// import type只供TS检查，运行JS擦除；FormatCheck约定接string回boolean，不表示自动运行校验。
import type { FormatCheck } from "../types.ts";
// 日期检查：数字年月日格式，再按月份/闰年判天数。
import { IsDate } from "./typebox/date.ts";
// 日期时间组合：拆T/t后分别使用日期与时间检查。
import { IsDateTime } from "./typebox/date_time.ts";
// 持续时长使用本地正则，不计算实际起止时间。
import { IsDuration } from "./typebox/duration.ts";
// 普通邮箱的语法检查，不发送邮件。
import { IsEmail } from "./typebox/email.ts";
// 普通主机名委托IDNA标签检查，不查询DNS。
import { IsHostname } from "./typebox/hostname.ts";
// 国际化邮箱先NFC归一后匹配，归一只在检查内部，不改调用方字符串。
import { IsIdnEmail } from "./typebox/idn_email.ts";
// 国际化主机名使用IDNA映射/标签与双向文字规则的本地实现。
import { IsIdnHostname } from "./typebox/idn_hostname.ts";
// IPv4地址的点分数字语法。
import { IsIPv4 } from "./typebox/ipv4.ts";
// IPv6地址的十六进制/压缩等正则语法。
import { IsIPv6 } from "./typebox/ipv6.ts";
// IRI先排非法字符/百分号，再用URL.canParse及有限IPvFuture替换检查。
import { IsIri } from "./typebox/iri.ts";
// IRI引用允许相对形式，内部固定示例base只帮助解析，不请求该地址。
import { IsIriReference } from "./typebox/iri_reference.ts";
// JSON Pointer语法，如/a~1b；不验证它在某份JSON里能找到目标。
import { IsJsonPointer } from "./typebox/json_pointer.ts";
// Pointer的URI片段形式，如#/name，与普通Pointer条目分开。
import { IsJsonPointerUriFragment } from "./typebox/json_pointer_uri_fragment.ts";
// 尝试new RegExp(value,"u")，构造异常转false，不拿该正则匹配其他数据。
import { IsRegex } from "./typebox/regex.ts";
// 相对JSON Pointer检查开头层数和后续Pointer/#形式，不执行定位。
import { IsRelativeJsonPointer } from "./typebox/relative_json_pointer.ts";
// 时间检查默认要求时区，并对秒60走闰秒分钟位置判断。
import { IsTime } from "./typebox/time.ts";
// URI通过本地正则判断，不向目标发请求。
import { IsUri } from "./typebox/uri.ts";
// URI引用正则允许相对形式。
import { IsUriReference } from "./typebox/uri_reference.ts";
// URI模板只检查占位写法，不展开变量。
import { IsUriTemplate } from "./typebox/uri_template.ts";
// URL条目直接使用当前运行时URL.canParse，不保证远端可访问。
import { IsUrl } from "./typebox/url.ts";
// UUID检查十六进制分组形状，不证明ID来自某个系统或真实唯一。
import { IsUuid } from "./typebox/uuid.ts";

/**
 * Every format JSON Schema 2020-12 defines, by name, plus `url` and `json-pointer-uri-fragment`, which TypeBox and
 * ajv-formats also check. The checks are adapted from TypeBox 1.3.27 (MIT).
 */
// Readonly<Record<string,FormatCheck>>是“名字→检查函数”的只读类型视图；Object.freeze实际浅冻结此表，函数内部不因此冻结。
// Compiler只取schema.format对应的自有条目；实际stringCheck调用所选函数，false表示该格式断言失败，回调异常可向外传播。
export const formats: Readonly<Record<string, FormatCheck>> = Object.freeze({
	// 简写date: IsDate把函数引用放入表，不是此刻调用IsDate。
	date: IsDate,
	// 带连字符的属性名加引号；通过formats["date-time"]读取。
	"date-time": IsDateTime,
	// 例P1D表示一天的持续时长写法。
	duration: IsDuration,
	// 普通邮箱格式名。
	email: IsEmail,
	// 普通主机名格式名。
	hostname: IsHostname,
	// 国际化邮箱格式名。
	"idn-email": IsIdnEmail,
	// 国际化主机名格式名。
	"idn-hostname": IsIdnHostname,
	// IPv4条目。
	ipv4: IsIPv4,
	// IPv6条目。
	ipv6: IsIPv6,
	// 国际化资源标识符条目。
	iri: IsIri,
	// 可相对的IRI引用条目。
	"iri-reference": IsIriReference,
	// 普通JSON Pointer条目，空串也可表示根。
	"json-pointer": IsJsonPointer,
	// 标准列表之外也提供的URI片段Pointer条目。
	"json-pointer-uri-fragment": IsJsonPointerUriFragment,
	// 正则表达式字符串条目。
	regex: IsRegex,
	// 相对Pointer条目，例如0#。
	"relative-json-pointer": IsRelativeJsonPointer,
	// 表的FormatCheck只传一个value，IsTime的strictTimeZone因此使用默认true。
	time: IsTime,
	// 绝对URI条目。
	uri: IsUri,
	// URI引用条目。
	"uri-reference": IsUriReference,
	// 模板条目，例如/users/{id}。
	"uri-template": IsUriTemplate,
	// TypeBox/ajv-formats额外提供的url条目，语义取决于本地URL解析器。
	url: IsUrl,
	// UUID分组形状条目。
	uuid: IsUuid,
});
