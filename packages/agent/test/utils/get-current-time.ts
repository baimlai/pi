// 测试用时间工具：读取宿主时钟，按给定或宿主默认时区格式化文字，并把同一时刻的Unix毫秒值放入details。
// obj/opt/str构造参数schema，Static是编译期的值类型推导。
import { obj, opt, type Static, str } from "@earendil-works/pi-schema";
// 结果与工具接口只参与类型检查，不实例化Agent。
import type { AgentTool, AgentToolResult } from "../../src/types.ts";

// 空接口继承AgentToolResult并指定details有utcTimestamp:number；名字不意味着使用某个远端时间服务。
export interface GetCurrentTimeResult extends AgentToolResult<{ utcTimestamp: number }> {}

// 读当前时间并返回Promise结果；例传UTC输出该时区日期文字，details仍是同一时刻的毫秒数。
// 流程：new Date→有truthy timezone则指定时区格式化，否则用宿主默认时区；指定分支格式化/包装失败会转报Invalid timezone。读取本机时钟，无网络；不能据错误文案断定所有失败都真由时区名造成。
export async function getCurrentTime(timezone?: string): Promise<GetCurrentTimeResult> {
	// 只取一次日期对象，后续文字和时间戳都从它计算，避免两次读取跨秒不一致。
	const date = new Date();
	// if判断字符串truthy，空串会和undefined一样走默认时区分支，并非提交给Intl报错。
	if (timezone) {
		// try包住指定时区的格式化与结果组装，catch不只覆盖时区名校验。
		try {
			// 按en-US语言地区规则格式化日期时间，具体文字受宿主Intl/时区数据库影响，不应写死每台机器的全部输出。
			const timeStr = date.toLocaleString("en-US", {
				// 把传入时区交给Intl解释，例America/New_York；不把Date所表示的实际时刻改成另一个时刻。
				timeZone: timezone,
				// full日期样式通常包含星期和完整年月日，具体形式由en-US实现决定。
				dateStyle: "full",
				// long时间样式包含时间及相应时区表示，不等于ISO字符串。
				timeStyle: "long",
			});
			// 返回工具结果普通对象；async函数再把它包装成Promise。
			return {
				// content面向模型，放格式化后的可读时间文字。
				content: [{ type: "text", text: timeStr }],
				// getTime取自Unix纪元起的毫秒数，不因显示时区改变；utcTimestamp这个键名不表示另查一次UTC服务器。
				details: { utcTimestamp: date.getTime() },
			};
			// 忽略原抛出值，统一包装指定分支的失败；错误身份/原因不直接保留。
		} catch (_e) {
			// 错误中附时区输入及同一Date的ISO时间；这是异常消息，不是成功结果的content。
			throw new Error(`Invalid timezone: ${timezone}. Current UTC time: ${date.toISOString()}`);
		}
	}
	// 没给truthy时区时使用宿主默认时区，仍指定en-US及full/long样式；这里不在上面的try内。
	const timeStr = date.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" });
	// 返回默认时区的成功结果；此分支错误会直接成为async Promise拒绝，不统一包装Invalid timezone。
	return {
		// 格式化文本放进模型可见文字块。
		content: [{ type: "text", text: timeStr }],
		// 程序详情仍保存同一个date的毫秒值。
		details: { utcTimestamp: date.getTime() },
	};
}

// 模块加载时建立开放对象规则：timezone可省略，提供时要求字符串；规则本身不检查IANA时区是否存在。
const getCurrentTimeSchema = obj(
	// opt包装str使obj不把timezone列为必填；description只是两个时区示例，不限制只能用它们。
	{ timezone: opt(str({ description: "Optional timezone (e.g., 'America/New_York', 'Europe/London')" })) },
	// Open, as the tool accepted extra arguments before it moved from TypeBox.
	// 开放额外字段以维持测试工具既有接受范围；不是删除这些字段。
	{ open: true },
);

// Static<typeof schema>推得timezone?:string，运行时并不因此自动验证传入对象。
type GetCurrentTimeParams = Static<typeof getCurrentTimeSchema>;

// 导出可供Agent执行的时间工具，TDetails明确详情字段类型；execute把参数转交getCurrentTime，不在导出时读时钟。
export const getCurrentTimeTool: AgentTool<typeof getCurrentTimeSchema, { utcTimestamp: number }> = {
	// UI展示名Current Time。
	label: "Current Time",
	// 模型调用匹配get_current_time。
	name: "get_current_time",
	// 给模型的用途文字。
	description: "Get the current date and time",
	// 复用模块级参数规则对象。
	parameters: getCurrentTimeSchema,
	// async执行函数接收调用id和推导的参数，id在此未用；返回getCurrentTime的Promise，async会采用其完成/拒绝状态。
	execute: async (_toolCallId: string, args: GetCurrentTimeParams) => {
		// 只透传timezone，没有取消或超时逻辑；手工直接调用也不会自动验证schema。
		return getCurrentTime(args.timezone);
	},
};
