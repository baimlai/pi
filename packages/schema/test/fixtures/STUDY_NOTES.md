# 官方 JSON 夹具怎样参与测试

“夹具”是测试预先准备的输入与资源。本目录保留第三方 JSON 正文；中文说明写在本页，不把注释插入标准 JSON，也不改上游的说明字符串、预期值、数字写法、空白或引用地址。来源核对完成应登记为 `reference`，不能登记为整文件中文逐句注释 `complete`。

## 来源与保留范围

`json-schema-test-suite/` 来自 [JSON-Schema-Test-Suite 的固定提交 3f05891cac5d51ffa068d7076d1372130e00c829](https://github.com/json-schema-org/JSON-Schema-Test-Suite/tree/3f05891cac5d51ffa068d7076d1372130e00c829)。本地 [README.md](json-schema-test-suite/README.md) 记录该版本，[LICENSE](json-schema-test-suite/LICENSE) 保留 MIT 许可正文。本轮从该提交的归档逐一比对：180 份 JSON 和 LICENSE 均逐字节相同；两版 `tests/` 的文件集合也分别完整，没有因只复制部分关键字而漏掉可选测试。

| 本地范围 | JSON 文件数 | 用途 |
| --- | ---: | --- |
| `json-schema-test-suite/tests/draft2020-12/` | 80 | draft 2020-12 的核心、可选与格式测试。 |
| `json-schema-test-suite/tests/draft7/` | 64 | draft 7 的核心、可选与格式测试。 |
| `json-schema-test-suite/remotes/` | 36 | 测试引用的独立 schema 资源，包括历史 draft 资源；这是上游 remotes 的选定子集，未声称复制全部上游资源。 |
| `meta-schemas/` | 9 | 两版官方 meta-schema 及 2020-12 的七份词汇规则文件。 |

Meta-schema 是“描述 schema 本身应该长什么样的 schema”，例如 `type` 关键字的值应为合法类型名称或名称数组。它不是业务数据，也不是 TypeScript 的类型声明。

本地 [meta-schemas/README.md](meta-schemas/README.md) 记录官方地址和 AFL-3.0 或 BSD-3-Clause 许可来源；[官方规范仓库的 LICENSE](https://github.com/json-schema-org/json-schema-spec/blob/main/LICENSE) 提供相应许可文本。2026-11-05 从下表官方地址获取内容，9 份均与本地逐字节一致。原 meta-schema 来源记录没有固定 Git 提交，本次记录的是核对日期、地址与内容指纹，不把当前官网内容冒称成某个未核实的历史提交。逐文件 SHA-256 与来源见 [Session 16 报告](../../../../../docs/learning/pi/session-reports/16.md)。SHA-256 是文件字节的摘要，可用于发现后续内容变化，不能证明说明解释正确。

| 本地 `meta-schemas/` 文件 | 官方来源与作用 |
| --- | --- |
| `draft-07-schema.json` | [draft-07/schema](https://json-schema.org/draft-07/schema)：集中描述 draft 7 的关键字、递归 schema 和 `definitions`。本地加载表使用历史的 `http://json-schema.org/draft-07/schema` 键。 |
| `draft2020-12-schema.json` | [2020-12/schema](https://json-schema.org/draft/2020-12/schema)：通过相对 `$ref` 组合七份词汇 meta-schema，并保留部分旧关键字的描述。 |
| `draft2020-12-meta-core.json` | [meta/core](https://json-schema.org/draft/2020-12/meta/core)：`$id`、`$schema`、引用、锚点、词汇表与 `$defs` 的外形。 |
| `draft2020-12-meta-applicator.json` | [meta/applicator](https://json-schema.org/draft/2020-12/meta/applicator)：组合规则、对象/数组子规则，以及条件分支等应用规则。 |
| `draft2020-12-meta-unevaluated.json` | [meta/unevaluated](https://json-schema.org/draft/2020-12/meta/unevaluated)：`unevaluatedItems` 与 `unevaluatedProperties` 的规则外形。 |
| `draft2020-12-meta-validation.json` | [meta/validation](https://json-schema.org/draft/2020-12/meta/validation)：类型、枚举、数字边界、长度与必需属性等断言关键字。 |
| `draft2020-12-meta-meta-data.json` | [meta/meta-data](https://json-schema.org/draft/2020-12/meta/meta-data)：标题、描述、默认值、读写提示与例子等注解。 |
| `draft2020-12-meta-format-annotation.json` | [meta/format-annotation](https://json-schema.org/draft/2020-12/meta/format-annotation)：声明 `format` 是字符串；加载此文档不等于启用格式断言。 |
| `draft2020-12-meta-content.json` | [meta/content](https://json-schema.org/draft/2020-12/meta/content)：内容编码、媒体类型和内容 schema 的外形。 |

## 一份测试 JSON 的读法

`tests/` 中每份 JSON 的最外层是数组；数组每项为一个测试组。测试组的 `schema` 是待验证的规则，`tests` 是多个输入与预期结果。可选的其他字段（例如注释）仍保留上游内容，本地加载器不会逐个解释全部字段。

| 层级与字段 | 含义 |
| --- | --- |
| 测试组的 `description` | 该组规则的英文说明，用于测试报告与已知失败条目的精确匹配。 |
| 测试组的 `schema` | 同组各输入使用的 JSON Schema；可以是规则对象，也可以是布尔 schema。 |
| 测试组的 `tests` | 输入案例数组；不是 TypeScript 函数列表。 |
| 每个案例的 `description` | 这一个输入的说明，与测试组说明共同组成案例身份。 |
| 每个案例的 `data` | 传入校验器的原始 JSON 值；可能是数字、字符串、对象、数组、布尔值或 null。 |
| 每个案例的 `valid` | 规范期望的合法性布尔值；`false` 表示输入应被拒绝，此时校验器返回 `false` 才算测试正确。 |

例子取自完整保留的 [draft7/type.json](json-schema-test-suite/tests/draft7/type.json)：第一组的规则是 `{ "type": "integer" }`。数字 `1` 的预期是 `true`，字符串 `"1"` 的预期是 `false`；这里的测试没有开启 `coerce`，不会先把字符串转成数字。JSON 文本中的 `1.0` 经 JavaScript `JSON.parse` 后同样是整数值 `1`，因此它也预期合法。这是数据与加载流程的说明，不是在夹具中添加新的测试。

## 从文件到实际断言

读取和登记由本包手写的 [suite.ts](../suite.ts) 与 [conformance.test.ts](../conformance.test.ts) 完成，其源码已有逐句中文说明。完整流程为：

1. `suiteFiles()` 从两版测试目录递归收集小写 `.json` 文件，各层按名称排序；目录 `draft2020-12` 映为编译选项 `"2020-12"`，目录 `draft7` 映为 `"7"`。它读 UTF-8 并执行 `JSON.parse`；文件或 JSON 错误直接抛出。
2. `SuiteGroup`、`SuiteFile` 是 TypeScript 接口，只在开发时约束后续代码。JSON.parse 不会因为赋值给这些接口，就自动验证文件是否满足接口或 meta-schema；这里信任入仓的测试数据。
3. `suiteSchemas()` 同步读取 36 份 remotes 和 9 份 meta-schema，生成 45 个 URI 键对应本地规则的资源表；每次调用重新读取和解析，返回新的对象。
4. 一致性测试按文件、测试组、输入登记用例。每个输入的第一项用例独立 `compile(group.schema, options)`，比较真实 `check(test.data)` 与 `test.valid`。`options.draft` 来自目录映射，`options.schemas` 是上述本地资源表。
5. 只有文件名包含精确的 `/optional/format/` 时，才显式传入本包的 `formats` 表。`optional/format-assertion.json` 不符合这段目录匹配，不能因文件名包含 format 就说启用了格式函数表。
6. 每个输入另登记一项普通用例，比较 `errors(data).length === 0` 与本库 `check(data)` 是否一致；它检验内部一致性，不再次与官方 `valid` 进行独立比较。

实际例子：[draft2020-12/refRemote.json](json-schema-test-suite/tests/draft2020-12/refRemote.json) 第一组的 `$ref` 是 `http://localhost:1234/draft2020-12/integer.json`。加载器把这个 URI 作为表的键，值来自本地 [remotes/draft2020-12/integer.json](json-schema-test-suite/remotes/draft2020-12/integer.json)，内容要求 `integer`；输入 `1` 预期合法，`"a"` 预期不合法。测试不用启动 1234 端口，也不在线下载引用。含 `#/$defs/integer` 的引用还会在已登记的文档内继续定位，相关实现见本包 resolver 的注释。

`remotes/draft2019-09/` 的存在也不表示本包新支持了完整 draft 2019-09。它提供两版测试需要引用的历史文档；当前测试明确登记了跨 draft 引用的已知差异。

## 范围与结果应该怎样计算

本轮读取 144 份测试 JSON，共 784 组、4213 个输入。分组如下：

| draft | 类别 | 文件数 | 组数 | 输入数 |
| --- | --- | ---: | ---: | ---: |
| 2020-12 | 核心 | 46 | 384 | 1298 |
| 2020-12 | 可选（不含下行格式目录） | 13 | 50 | 162 |
| 2020-12 | `optional/format/` | 21 | 28 | 895 |
| 7 | 核心 | 37 | 258 | 925 |
| 7 | 可选（不含下行格式目录） | 8 | 38 | 118 |
| 7 | `optional/format/` | 19 | 26 | 815 |

每个输入产生两项测试，所以指定 `conformance.test.ts` 实际执行 8426 项。当前测试有 9 个 `it.fails`：自定义词汇开关 1 项、format-assertion 2 项、跨 draft 2 项、draft 7 的内容断言 4 项。`it.fails` 要求该回调仍抛异常才算符合预期；它不是跳过，也不证明异常必然来自预想原因。其配套 errors/check 一致性用例照常运行。

2026-11-05 的指定文件验证为 **8417 普通通过、9 个预期失败**。这说明现有用例及失败登记符合当前实现，不能写成“所有 4213 个官方输入均按规范通过”。本轮没有执行完整多库基准，没有改 known-failure 名单，也没有修改任何第三方数据。

## 以后升级时复核什么

先确认上游固定版本与许可，再比较两版 tests 的文件集合及每个文件字节；保留所需 remotes 与 meta-schema 的来源地址和指纹。英文 description 是已知失败身份的一部分，不能为了翻译直接改写它。更新后重新核对读取路径、引用资源、格式开关、失败名单及真实测试结果，按本轮报告中的逐文件边界更新来源记录；来源比对与语义复核分别记录。
