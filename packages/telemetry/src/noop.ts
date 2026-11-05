/**
 * 遥测未启用时的共享空实现：丢弃记录操作，却照常同步调用业务callback并用Promise保留结果/异常。
 * 例NOOP_TELEMETRY_CONTEXT.startSpan({name:"read"},()=>42)仍执行callback并最终得到42，不产生span记录或上传。
 * 冻结的句柄被所有调用复用，子span仍是同一个空对象；metrics/propagation能力也保持可用，不检查/保存传入元数据。
 */
// SpanOptions/Propagation/Span全为类型，import type擦除，避免为接口在运行时依赖index。
import type { SpanOptions, TelemetryPropagation, TelemetrySpan } from "./index.ts";
// 三类指标句柄及工厂类型，不导入某个实际后端实现。
import type { TelemetryCounter, TelemetryHistogram, TelemetryMetrics, TelemetryUpDownCounter } from "./metrics.ts";

// startNoopSpan<T>忽略选项但立即调callback，例回调返回对象就Promise得到同对象；async会把同步throw变成相同值的拒绝，并同化返回Promise，不吞业务失败。
async function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	// 调用在当前同步栈进入；没有await也不表示返回同步T，外层async仍给Promise<T>，且传共享空span。
	return callback(noopTelemetrySpan);
}

// 共享冻结counter，add忽略参数直接void，不建立测量数组。
const noopCounter: TelemetryCounter = Object.freeze({ add: () => {} });
// 可增减counter也共享，但与普通counter是不同句柄对象。
const noopUpDownCounter: TelemetryUpDownCounter = Object.freeze({ add: () => {} });
// histogram的record同样空操作，不读context/桶/属性。
const noopHistogram: TelemetryHistogram = Object.freeze({ record: () => {} });

/** Shared instruments that never inspect or retain metadata, measurements, or contexts. */
// NOOP指标能力对象冻结，例counter("a")与counter("b")得同一noopCounter；不按名字建缓存，不读options。
export const NOOP_TELEMETRY_METRICS: TelemetryMetrics = Object.freeze({
	// 工厂忽略名字/元数据，返回共享counter。
	counter: () => noopCounter,
	// 返回共享upDownCounter。
	upDownCounter: () => noopUpDownCounter,
	// 返回共享histogram。
	histogram: () => noopHistogram,
});

/** Shared propagation capability that neither inspects nor retains its inputs. */
// NOOP传播能力也共享冻结；例inject(span)无载荷，extract任意carrier回空上下文，不解析JSON或验证身份。
export const NOOP_TELEMETRY_PROPAGATION: TelemetryPropagation = Object.freeze({
	// 无上下文导出，始终undefined，不保存参数。
	inject: () => undefined,
	// 调用时读取模块绑定NOOP_TELEMETRY_CONTEXT，返回共享空span，不创建新的根。
	extract: () => NOOP_TELEMETRY_CONTEXT,
});

// 先构造空span再freeze，所有记录方法只空返回；对象声明受TelemetrySpan类型约束，不含业务callback实现的副本。
const noopTelemetrySpan: TelemetrySpan = {
	// 空span仍暴露同一NOOP指标能力。
	metrics: NOOP_TELEMETRY_METRICS,
	// 仍暴露NOOP传播能力。
	propagation: NOOP_TELEMETRY_PROPAGATION,
	// 子span仍经startNoopSpan立即执行业务callback，并拿同一个空span。
	startSpan: startNoopSpan,
	// addLink不读取/保存目标或属性。
	addLink: () => {},
	// addEvent不记录事件。
	addEvent: () => {},
	// setAttributes不修改任何状态。
	setAttributes: () => {},
	// setStatus不记录error等值，业务Promise的成败仍按callback返回/抛错。
	setStatus: () => {},
};
// 浅冻结span成员，空对象内没有另行累积可变记录；不冻结用户传入数据。
Object.freeze(noopTelemetrySpan);

/** Shared telemetry context used when an application does not provide one. */
// 公开根上下文直接别名共享空span，静态类型也是TelemetrySpan，实际父子均复用它，不代表分配一份真实计时span。
export const NOOP_TELEMETRY_CONTEXT: TelemetrySpan = noopTelemetrySpan;
