// Watchable document addresses (slice 6a §11; decision "One retirement mechanism"): the frames of a source that
// follows one address, a singleton's slot or one key of a keyed slot. A change arrives with its ops, a write over
// another base as a root replacement, a retirement as `[["r", initial()]]` with the `retired` flag, and a document
// created after a retirement in the same batch as one root replacement with the flag.

// 文件导读
// 所属：packages/chord/src/documents，文档地址的可观察源基类（watch 帧生成）。
// 职责边界：仅保存本批帧内容并把值/ops/retired 发布给 Source 的 watch/subscriber；不读写 store、不管理 slot 生命周期。
// 上游：SingletonSlot、KeySource 继承并在 adopt/retire/迁移时调用 written/retired/replaced；下游：Batch.deliver 调用 deliver，Source.publish 把帧交给 watch。
// 结果/错误：这些方法不抛业务错误；changed() 只登记批次，投递异常由 Batch 隔离上报。
// 能力清单：NO_OPS 共享空 ops；AddressSource 抽象类（#ops/#retired 暂存、deliver 投递、written 写帧、retired 退役帧、replaced 根替换帧）。
// 组合关系：提交收养 → slot.adopt → written(before, prepared) → changed() 登记 → Batch 调 deliver → publish → watch 收到帧。
// 示例：slot.written(before, prepared) 后，watched 的 source 在下一批 deliver 中发出 { value: prepared.value, ops: prepared.ops, retired: false }。
// 阅读顺序：先看 deliver 的复位逻辑，再看 written/retired/replaced 如何决定 ops，最后看 slot.ts 的 adopt/retire。
import type { Context } from "../context/index.ts";
import type { Op, Prepared } from "../delta/index.ts";
import { Source } from "../state/internal.ts";
import type { JsonObject } from "./definition.ts";

// 共享的空 ops 数组：无变化时复用，避免每帧分配；readonly Op[] 只是编译期只读，运行期没有冻结。
const NO_OPS: readonly Op[] = [];

// 例：singleton 从 {a:1} 写成 {a:2}，watched 时 written 记录 [["a",2]]；deliver 后 watch 收到 value 帧。
// 抽象类只提供帧状态与投递逻辑，当前值由子类实现。
/** A source following one document address; `value` is the document's, or `initial()` while it is absent. */
export abstract class AddressSource extends Source {
	/** The ops of the current batch's frame, and whether the document was retired in it. */
	// #ops / #retired 是当前批次待投递帧的暂存；只有被观察的 source 才写入，未观察时不保留帧内容。
	#ops = NO_OPS;
	#retired = false;

	// 抽象 accessor：子类给出文档当前值；abstract 只存在于类型层，子类必须实现，override 让 TS 检查基类确实有该成员。
	// 这里只读：值变化通过 adopt 流程写回槽，source 不持有可写状态。
	abstract override get value(): JsonObject;

	// 函数说明：Batch 在 adopt 后调用 deliver；输入 context，无返回；副作用是 publish 本批帧并清空暂存。
	// 例子（真实运行时行为）：一次幂等写入被收养后，watch 收到 { value, ops, retired }，随后 #ops 复位。
	// publish 是 Source 的受保护方法：对每个 watch 调用 advance，并同步喂给 subscriber；ops/retired 原样进入 WatchCall。
	// 立即复位防止同一 source 在下一批重复携带旧 ops；帧只描述上次投递以来发生的变化。
	deliver(context: Context): void {
		this.publish(this.value, this.#ops, this.#retired, context);
		this.#ops = NO_OPS;
		this.#retired = false;
	}

	// 函数说明：一次提交收养了该文档的变化；输入 before（收养前内存值）与 prepared（Delta 的 base/value/ops）；无返回。
	// 主要流程：watched 时决定帧的 ops，然后 changed() 把 source 登记进当前批次，并让依赖它的 derive 失效。
	// 为什么可能整根替换：prepared.base !== before 说明草稿基于另一个值（期间被别的提交改过），ops 不能安全叠加，只能发 [["r", value]]。
	// 同一批里文档先退役再写入时同样发整根替换，避免 watch 把新值当作旧文档的补丁。
	// 比较的是对象身份而不是 revision：Delta 的 base 是 beginChange 时 tracker.value 的引用。
	// prepared.value 只被读入帧；本方法不修改文档或 tracker。
	/**
	 * A commit wrote the document, which read `before`: its ops, or a root replacement when the draft started from
	 * another base or the document was retired earlier in the batch.
	 */
	written(before: JsonObject, prepared: Prepared<JsonObject>): void {
		// 只有被观察的 source 才保留帧内容；未观察时 changed() 仍会让依赖的 derive 失效，但不需要分配 ops。
		// The ops are kept for a frame, which only a watched source gets: an unwatched one keeps none.
		if (this.watched) this.#ops = prepared.base === before && !this.#retired ? prepared.ops : [["r", prepared.value]];
		this.changed();
	}

	// 函数说明：文档被退役；输入 initial（新的缺席值），无返回；副作用是帧变为整根替换并带 retired 标志。
	// 例：retire 后 watch 收到 { value: initial(), ops: [["r", initial()]], retired: true }。
	// changed() 先标脏依赖；retiredInBatch() 必须在 changed 之后调用，把 retired 标志沿 derive 链传播（rule 21）。
	// 未观察的 source 不保存帧内容，但依赖者仍会被 invalidate，因此 retiredInBatch 不能省。
	/** The document was retired: it reads `initial` again, and the frame says so. */
	retired(initial: JsonObject): void {
		// 帧内容在 deliver 时清零；这里只记录待投递状态，不改变文档值。
		// Reset by the frame, which only a watched source gets.
		if (this.watched) {
			this.#ops = [["r", initial]];
			this.#retired = true;
		}
		this.changed();
		this.retiredInBatch();
	}

	// 函数说明：提交之外的值变化（迁移、加载）也发一帧；无参数，副作用是 [["r", this.value]] 与标脏。
	// 例：hydrate 发现定义升版并迁移了值，于是 batch.commit(() => this.replaced()) 让 watch 看到整根新值。
	// 读取 this.value 得到当前（已迁移）值；ops 用根替换而不是增量，因为变化不是一次可追踪的草稿。
	/** The value changed outside a commit (a migration, a load): a root replacement. */
	replaced(): void {
		if (this.watched) this.#ops = [["r", this.value]];
		this.changed();
	}
}
