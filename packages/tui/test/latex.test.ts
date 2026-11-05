// 用真实会话里的公式和小型边界样例核对LaTeX到Unicode文字的转换；只比较内存字符串，不启动TeX或操作终端。
// 这些断言固定当前支持子集的文字、空格与换行，不验证数学等式是否成立，也不验证Markdown如何提取数学分隔符。
// 引入Node断言工具；strictEqual逐字比较字符串，任何排版空格不同都会使测试失败。
import assert from "node:assert";
// describe组织测试组，it注册具体测试；这里的回调同步执行断言，没有异步资源需要等待。
import { describe, it } from "node:test";
// 从包的公共入口取renderLatex，同时覆盖该重导出可用；输入是已去外层数学分隔符的公式正文。
import { renderLatex } from "../src/index.ts";

// 每条样例是长度为2的只读元组：source是输入，expected是预期文字；字段名仅帮助开发期阅读。
// readonly限制TypeScript中的写入，不会在运行时冻结数组；这里也没有额外检查任意外部数据。
type LatexCase = readonly [source: string, expected: string];

// 把一组输入/预期元组注册为独立测试；参数只读，返回void，不修改样例或现在就执行全部渲染。
// 流程是遍历元组、生成可辨认标题、由测试运行器调用断言回调；例如["x^2", "x²"]注册一个渲染测试。
// 渲染结果不符时strictEqual抛出断言错误，由node:test记录失败，不在此吞掉。
function defineCases(cases: readonly LatexCase[]): void {
	// for...of按数组顺序取样例，[source, expected]解构元组的两项，const固定每轮绑定。
	for (const [source, expected] of cases) {
		// JSON.stringify让标题显示输入中的反斜杠/换行转义；箭头函数把本条断言交给测试运行器，捕获本轮输入与预期。
		it(`renders ${JSON.stringify(source)}`, () => {
			// 省略第二个参数使用普通模式；即使未开display，矩阵/分段环境也可能生成多行，结果必须与expected严格相同。
			assert.strictEqual(renderLatex(source), expected);
		});
	}
}

// 注册总测试组，其回调继续声明子组和测试；组名只作报告分类，不作为传给渲染器的参数。
describe("renderLatex", () => {
	// 收集雅可比猜想会话中的公式；标题提到dollar是样例来源，下面没有传入美元数学分隔符。
	describe("Jacobian conjecture session using dollar delimiters", () => {
		// 将每个二元数组交给统一注册函数，单条公式失败不会混淆为同一个大断言。
		defineCases([
			// String.raw保留反斜杠，不用写双反斜杠；黑板体C、上标3和箭头分别转成ℂ、³、→。
			[String.raw`\mathbb{C}^3 \to \mathbb{C}^3`, "ℂ³ → ℂ³"],
			[
				// 集合括号由转义命令保留，分隔用的显式间距归一为空格；同一行也检查多项式上标和蕴含/属于/正负符号。
				String.raw`\{3x+2y,\; 27x^2-4z-1,\; x(x-1)(x+1)\} \quad\Rightarrow\quad x \in \{0, \pm 1\},`,
				// 预期集合文字保留逗号及末尾标点，指数2变为²，不执行求根或证明。
				"{3x+2y, 27x²-4z-1, x(x-1)(x+1)} ⇒ x ∈ {0, ± 1},",
			],
			// F的数字下标变₁；普通分数写成斜杠，复合分母4x²加括号以显示分组，句点保留。
			[String.raw`F_1 = -\frac{1}{4x^2}.`, "F₁ = -1/(4x²)."],
			// 负整数无需命令转换，仍返回原来的-2。
			["-2", "-2"],
			// 普通坐标元组中的斜杠已经是文本，不会被重新计算为小数。
			["(0,0,-1/4)", "(0,0,-1/4)"],
			// 另一组带负分数坐标保持次序和标点，验证纯文本可直接通过。
			["(1,-3/2,13/2)", "(1,-3/2,13/2)"],
			// 三个正整数坐标不需要脚标或命令解析，原样输出。
			["(1,1,1)", "(1,1,1)"],
			// 含0的坐标同样保持内容，不根据会话背景判断是不是解。
			["(2,1,0)", "(2,1,0)"],
			// 坐标里的显式逗号后空格被保留为单个空格，不全部紧缩成无空格。
			["(-1/4, 0, 0)", "(-1/4, 0, 0)"],
			// 转义大括号包围三个坐标；转换器保留集合结构而不解释其中的数值关系。
			[String.raw`\{(0,0,-1/4), (1,-3/2,13/2), (-1,3/2,13/2)\}`, "{(0,0,-1/4), (1,-3/2,13/2), (-1,3/2,13/2)}"],
			// 检查另一个普通三元组，避免对数字正文附加排版字符。
			["(2,1,1)", "(2,1,1)"],
			// 多个分数字面量仍用原有斜杠；这条没有LaTeX分数命令。
			["(7/3,-2/5,11/7)", "(7/3,-2/5,11/7)"],
			// 集合内的函数/减号保持正文，分号间距命令只留下一个分隔空格。
			[String.raw`\{y - p(x),\; q(x)\}`, "{y - p(x), q(x)}"],
			// 命名算子deg与后面的q分开，并在等号两侧规范空格。
			[String.raw`\deg q = 3`, "deg q = 3"],
			// 域扩张样式只作文字排版：黑板体和三个F下标被转换，冒号与方括号保留。
			[String.raw`[\mathbb{C}(x,y,z):\mathbb{C}(F_1,F_2,F_3)] = 3`, "[ℂ(x,y,z):ℂ(F₁,F₂,F₃)] = 3"],
			// 已有普通等式保留正文；加号不采用等号那样统一加空格的规则。
			["u = 1+xy", "u = 1+xy"],
			// 两个平方指数都转为Unicode上标，变量相乘的邻接形式不插入乘号。
			["G = u^2 z + y^2(4+3xy)", "G = u² z + y²(4+3xy)"],
			// 只将F_1变为F₁，uG作为原有连写正文输出。
			["F_1 = uG", "F₁ = uG"],
			// 下标2转换后保留加法及相邻字母，不自动重写代数式。
			["F_2 = y + 3xG", "F₂ = y + 3xG"],
			// 紧贴的等号被规范为两侧各一个空格，这是输出格式变化而非数值计算。
			["x=0", "x = 0"],
			// 两个数字下标与连等号一起转换，链中的每个等号都规范间距。
			["F_2 = F_3 = 0", "F₂ = F₃ = 0"],
			// xy和负分数字面量保持内容，只统一已有等号的间距。
			["xy = -3/2", "xy = -3/2"],
			// 无大括号的单字符指数2也被识别，后面的z仍在基线上。
			["x^2 z = 13/2", "x² z = 13/2"],
			// 星号没有这里可用的Unicode上标映射，回退为^*，不能声称所有上标都成为单个Unicode字形。
			[String.raw`\mathbb{C}^*`, "ℂ^*"],
			// 映射箭头转↦；tfrac在普通模式仍是线性分数，复合分母加括号，间距命令归一为空格。
			[String.raw`s \mapsto (s,\, -\tfrac{3}{2s},\, \tfrac{13}{2s^2})`, "s ↦ (s, -3/(2s), 13/(2s²))"],
			// 单个普通字母X原样返回，作为无需转换的最小样例。
			["X", "X"],
			// 下标正负号不能映射为Unicode下标，使用_±文字回退。
			[String.raw`p_\pm`, "p_±"],
			// 函数参数内的负号保留，右侧三项F的数字下标分别转换。
			["F(-x,-y,z) = (F_1, -F_2, -F_3)", "F(-x,-y,z) = (F₁, -F₂, -F₃)"],
			// 普通字符串中的_0也走脚标解析，得到p₀。
			["p_0", "p₀"],
			// 箭头与无穷符号同时转换，前后仍以空格隔开。
			[String.raw`s \to \infty`, "s → ∞"],
			// 零坐标元组照常作为普通正文通过。
			["(0,0,0)", "(0,0,0)"],
			// 没有左右操作数的独立蕴含命令也能映射成⇒。
			[String.raw`\Rightarrow`, "⇒"],
			// 大于等于命令转≥，数字2仍是普通基线文字。
			[String.raw`\ge 2`, "≥ 2"],
			// 同一大于等于关系用于数字3，这条预期也固定≥后保留一个空格。
			[String.raw`\ge 3`, "≥ 3"],
			// 单个数字1是最小普通文本样例，不被添加额外空格或换行。
			["1", "1"],
			// 字体包装和旧式rm字体声明不产生终端字体效果；diag正文保留，长ASCII下标intrinsic用下划线回退，lambda转λ。
			[String.raw`\mathrm{diag}(-1/2,1,1),\quad F_{\rm intrinsic}(\lambda)`, "diag(-1/2,1,1), F_intrinsic(λ)"],
			// 普通加法和字母连写没有需要转换的命令，输出与输入相同。
			["4+3xy", "4+3xy"],
		]);
	});

	// 收集卫星计算会话文字；组名中的bracket不表示此处测试外层方括号数学分隔符的识别。
	describe("satellite calculation session using bracket delimiters", () => {
		// 仍按元组逐条注册；单位和数值只是排版样本，不检查换算是否正确。
		defineCases([
			[
				// 近似号、text单位、显式空格和分数混用；分子0.1 lux及分母100 lm/W都不是简单原子，线性分数两侧加括号。
				String.raw`E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}} = 0.001\ \text{W/m}^2`,
				// 预期近似号为≈、平方米的2为²；lux、lm/W和W/m仍是单位文字。
				"E ≈ (0.1 lux)/(100 lm/W) = 0.001 W/m²",
			],
			// boxed用ASCII方括号表示包围效果，不在终端绘制真正的TeX边框。
			[String.raw`\boxed{1\ \text{milliwatt per square metre}}`, "[1 milliwatt per square metre]"],
			// 分组大括号不输出，组内逗号保留成千位分隔；km和m后的平方转为上标。
			[String.raw`5\ \text{km}^2 = 5{,}000{,}000\ \text{m}^2`, "5 km² = 5,000,000 m²"],
			[
				// 此String.raw跨两行：第一行是光功率乘法，第二行接等号与boxed结果；普通物理换行归一为空格，而非强制输出换行。
				String.raw`P_{\text{light}} = 0.001 \times 5{,}000{,}000
= \boxed{5{,}000\ \text{W}}`,
				// 长ASCII文字下标light回退成_light，乘号×和方括号结果在同一行；数字仅按样例原样显示。
				"P_light = 0.001 × 5,000,000 = [5,000 W]",
			],
			[
				// 两行输入分别给出电功率乘法和boxed结果；text中的electric作为下标正文，物理换行只作空白。
				String.raw`P_{\text{electric}} = 5\ \text{kW} \times 0.2
= \boxed{1\ \text{kW}}`,
				// 预期保持P_electric文字回退，0.2等数值不经计算器重新求值。
				"P_electric = 5 kW × 0.2 = [1 kW]",
			],
			// 圆周率与平方指数转换；括号内单位文字保留，不验证19.6这一数值近似。
			[String.raw`\pi(2.5\ \text{km})^2 = 19.6\ \text{km}^2`, "π(2.5 km)² = 19.6 km²"],
			[
				// 第一行是单位面积功率乘面积，下一行是近似的boxed文字；这里没有显式的环境换行命令。
				String.raw`0.001\ \text{W/m}^2 \times 19.6 \times 10^6\ \text{m}^2
\approx \boxed{20\ \text{kW optical}}`,
				// 合并成一行并输出10⁶、≈和方括号；optical保留为普通单位说明。
				"0.001 W/m² × 19.6 × 10⁶ m² ≈ [20 kW optical]",
			],
			[
				// 第一行给出功率乘线性分数小时，第二行给出boxed能量结果；两个物理源行合并显示为一条文字，不在框内保留LF。
				String.raw`1\ \text{kW} \times \frac{1}{3600}\ \text{hour}
= \boxed{0.28\ \text{Wh}}`,
				// 分数1/3600保持斜杠，空白合并后单位hour与Wh仍有分隔。
				"1 kW × 1/3600 hour = [0.28 Wh]",
			],
		]);
	});

	// 另一组雅可比会话样例；实际传入的是公式正文，括号/方括号数学分隔提取属于上游Markdown职责。
	describe("Jacobian conjecture sessions using parenthesis and bracket delimiters", () => {
		// 注册导数行列式、aligned行组和普通正文的逐条精确输出。
		defineCases([
			[
				// det、负间距、left/right和偏导分数组合；本例普通模式中复合分子分母各用括号包围。
				String.raw`\det\!\left(\frac{\partial(F_1,F_2,F_3)}{\partial(x,y,z)}\right)=-2.`,
				// 行列式自身括号外还保留分数的分组括号，因此出现多层括号；等号和句点位置也严格匹配。
				"det((∂(F₁,F₂,F₃))/(∂(x,y,z))) = -2.",
			],
			[
				// 整个模板是三行aligned：三组F取值由显式双反斜杠分行，&作对齐标记，tfrac的紧凑单字符参数/分组参数都要解析。
				String.raw`\begin{aligned}
F(0,0,-\tfrac14)&=(-\tfrac14,0,0),\\
F(1,-\tfrac32,\tfrac{13}2)&=(-\tfrac14,0,0),\\
F(-1,\tfrac32,\tfrac{13}2)&=(-\tfrac14,0,0).
\end{aligned}`,
				// 预期三行由字符串中的\n连接；等式只做脚标/分数转换，不验证三个F值真的相等。
				"F(0,0,-1/4) = (-1/4,0,0),\nF(1,-3/2,13/2) = (-1/4,0,0),\nF(-1,3/2,13/2) = (-1/4,0,0).",
			],
			// 连写等号仍被补两侧空格，三个分量数字下标变成₁、₂、₃。
			["F=(F_1,F_2,F_3)", "F = (F₁,F₂,F₃)"],
			// 单个函数名字母无需转换，直接返回。
			["F", "F"],
			// 单个数值3也不会被误判为数学环境或脚标。
			["3", "3"],
		]);
	});

	// 雅可比矩阵会话样本同时覆盖矩阵、aligned、分数和字体包装；标题只是来源分类。
	describe("Jacobian matrix session using dollar delimiters", () => {
		// 普通模式样例不传display，矩阵本身仍允许多行，这是与分数堆叠开关不同的能力。
		defineCases([
			[
				// 模板包含J等号和3×3 pmatrix：&分列、双反斜杠分行，每个单元是f数字下标的偏导分数。
				String.raw`J = \begin{pmatrix}
\frac{\partial f_1}{\partial x} & \frac{\partial f_1}{\partial y} & \frac{\partial f_1}{\partial z} \\
\frac{\partial f_2}{\partial x} & \frac{\partial f_2}{\partial y} & \frac{\partial f_2}{\partial z} \\
\frac{\partial f_3}{\partial x} & \frac{\partial f_3}{\partial y} & \frac{\partial f_3}{\partial z}
\end{pmatrix}`,
				// 预期三行使用括号分段字形和│列分隔，后两行前置空格与J = 对齐；矩阵单元里的分数保持线性。
				"J = ⎛ (∂ f₁)/(∂ x) │ (∂ f₁)/(∂ y) │ (∂ f₁)/(∂ z) ⎞\n    ⎜ (∂ f₂)/(∂ x) │ (∂ f₂)/(∂ y) │ (∂ f₂)/(∂ z) ⎟\n    ⎝ (∂ f₃)/(∂ x) │ (∂ f₃)/(∂ y) │ (∂ f₃)/(∂ z) ⎠",
			],
			[
				// 三行aligned分别给f₁、f₂、f₃多项式；显式分行保留，而每行内的幂转Unicode上标。
				String.raw`\begin{aligned}
f_1 &= (1+xy)^3 z + y^2(1+xy)(4+3xy) \\
f_2 &= y + 3x(1+xy)^2 z + 3xy^2(4+3xy) \\
f_3 &= 2x - 3x^2y - x^3z
\end{aligned}`,
				// 输出三行多项式，&本身不出现；这里不要求各等号按最宽变量额外补齐。
				"f₁ = (1+xy)³ z + y²(1+xy)(4+3xy)\nf₂ = y + 3x(1+xy)² z + 3xy²(4+3xy)\nf₃ = 2x - 3x²y - x³z",
			],
			// 逗号分隔的变量串保持空格和次序。
			["x, y, z", "x, y, z"],
			// 加外层普通圆括号仍是普通正文，不被当成Markdown数学分隔符。
			["(x, y, z)", "(x, y, z)"],
			// 显式间距命令化成单空格，tfrac14等价于分子1、分母4的线性分数。
			[String.raw`(0,\; 0,\; -\tfrac14)`, "(0, 0, -1/4)"],
			// 负分数在坐标首项中仍保留负号，其他坐标不变。
			[String.raw`(-\tfrac14,\; 0,\; 0)`, "(-1/4, 0, 0)"],
			// 覆盖tfrac紧凑参数和带大括号参数混用的正x坐标样本。
			[String.raw`(1,\; -\tfrac32,\; \tfrac{13}{2})`, "(1, -3/2, 13/2)"],
			// 与上一条相同的分数规则用于负x坐标，正负号不重新计算。
			[String.raw`(-1,\; \tfrac32,\; \tfrac{13}{2})`, "(-1, 3/2, 13/2)"],
			// frac也支持单字符参数1与4，不要求每个参数都写花括号。
			[String.raw`(-\frac14, 0, 0)`, "(-1/4, 0, 0)"],
			// 函数映射中的C转ℂ、3转上标、to转箭头，冒号保留。
			[String.raw`F: \mathbb{C}^3 \to \mathbb{C}^3`, "F: ℂ³ → ℂ³"],
			[
				// 一条长连等式含三处函数坐标和最后结果；各分数独立解析，正文中的函数值关系不做求值。
				String.raw`F(0,0,-\tfrac14) = F(1,-\tfrac32,\tfrac{13}{2}) = F(-1,\tfrac32,\tfrac{13}{2}) = (-\tfrac14, 0, 0)`,
				// 预期所有等号间距一致，三个函数调用及末尾元组仍按输入顺序连写。
				"F(0,0,-1/4) = F(1,-3/2,13/2) = F(-1,3/2,13/2) = (-1/4, 0, 0)",
			],
			// 单独黑板体复空间记号覆盖ℂ与上标3组合。
			[String.raw`\mathbb{C}^3`, "ℂ³"],
			[
				// aligned环境里只有一段，没有显式双反斜杠分行：三条物理源行用quad和逗号衔接，应合并成一条输出。
				String.raw`\begin{aligned}
f_1 &= \frac{f_1^{\text{ut}}(u,t)}{x^2}, \quad
f_2 = \frac{f_2^{\text{ut}}(u,t)}{x}, \quad
f_3 = x\,(2 - 3u - t)
\end{aligned}`,
				// 文本ut中的字母都有Unicode上标映射，变ᵘᵗ；两个线性分数和最后普通乘积仍在一行。
				"f₁ = (f₁ᵘᵗ(u,t))/(x²), f₂ = (f₂ᵘᵗ(u,t))/x, f₃ = x (2 - 3u - t)",
			],
			// J的F下标没有可用Unicode下标映射，回退为J_F；命名det与后续变量间保留空格。
			[String.raw`\det J_F`, "det J_F"],
			// 再次覆盖紧凑tfrac在普通坐标中的负分数。
			[String.raw`(-\tfrac14, 0, 0)`, "(-1/4, 0, 0)"],
			// 变量替换样式u = xy原样排版，不执行代入。
			["u = xy", "u = xy"],
			// 平方后紧跟z，只把2放到上标，z仍在基线。
			["t = x^2z", "t = x²z"],
			// 不等号命令转为≠，两侧规范留空。
			[String.raw`x \neq 0`, "x ≠ 0"],
			// 两个f的数字下标和文本ut上标同时生效，花括号只用于分组。
			[String.raw`f_1^{\text{ut}}, f_2^{\text{ut}}`, "f₁ᵘᵗ, f₂ᵘᵗ"],
			// 变量用逗号直接相连时不会凭空增加逗号后空格。
			["u,t", "u,t"],
			// 单个x不需要任何转换。
			["x", "x"],
			// 同一字符串中普通x与平方x并存，逗号和已有空格保持。
			["x, x^2", "x, x²"],
			// n具备Unicode上标形式，两个ℂⁿ和箭头组合转换。
			[String.raw`\mathbb{C}^n \to \mathbb{C}^n`, "ℂⁿ → ℂⁿ"],
			// geq是大于等于命令的另一拼法，也映射为≥。
			[String.raw`n \geq 2`, "n ≥ 2"],
			// 黑板体P有对应Unicodeℙ，再组合上标3。
			[String.raw`\mathbb{P}^3`, "ℙ³"],
		]);
	});

	// 复杂公式会话作为固定样例回归，不是性能计时或完整TeX兼容性压力基准。
	describe("extended formulas from a renderer stress-test session", () => {
		// 用同一元组注册器覆盖嵌套分数、算子脚标、多行矩阵与分段排版。
		defineCases([
			// iπ不能全部转成Unicode上标，整体回退为^(iπ)；等号仍规范空格。
			[String.raw`e^{i\pi}+1=0`, "e^(iπ)+1 = 0"],
			[
				// 整个跨行boxed输入包含配分函数、积分、指数函数、嵌套括号、分数与字体包装；物理换行都只是空白，没有环境行分隔。
				String.raw`\boxed{
\mathcal{Z}(\beta)
=
\int_{\mathcal M}
\exp\!\left(
-\beta\left[
\frac12 g^{ij}(x)\,\partial_i\phi\,\partial_j\phi
+V(\phi)
\right]\right)
\mathcal D\phi
}`,
				// 预期只有一行：cal字体退回普通Z/M/D，积分下标M用_M，希腊字母与可映射的ij脚标按字符转换，框用方括号。
				"[Z(β) = ∫_M exp( -β[ 1/2 gⁱʲ(x) ∂ᵢϕ ∂ⱼϕ +V(ϕ) ]) Dϕ]",
			],
			[
				// 两行aligned把张量散度和场方程分开；第一行结束的双反斜杠带[4pt]间距参数，渲染器只保留换行，不输出该排版长度。
				String.raw`\begin{aligned}
\nabla_\mu T^{\mu\nu}
&=
\frac{1}{\sqrt{-g}}
\partial_\mu\!\left(\sqrt{-g}\,T^{\mu\nu}\right)
+\Gamma^\nu_{\mu\lambda}T^{\mu\lambda}
=0, \\[4pt]
R_{\mu\nu}-\frac12 Rg_{\mu\nu}+\Lambda g_{\mu\nu}
&=
\frac{8\pi G}{c^4}T_{\mu\nu}.
\end{aligned}`,
				// 希腊多字符脚标不能全用Unicode脚标表示时回退为_(μν)等；根号复合内容和普通分数用括号保持分组。
				"∇_μ T^(μν) = 1/(√(-g)) ∂_μ(√(-g) T^(μν)) +Γ^ν_(μλ)T^(μλ) = 0,\nR_(μν)-1/2 Rg_(μν)+Λ g_(μν) = (8π G)/(c⁴)T_(μν).",
			],
			[
				// 模板先写复积分公式，再紧接三行pmatrix的行列式；矩阵的&与双反斜杠决定列/行，其他物理换行只归一为空格。
				String.raw`f(z)
=
\frac{1}{2\pi i}
\oint_{\gamma}
\frac{f(\zeta)}{\zeta-z}\,d\zeta,
\qquad
\det\!\begin{pmatrix}
\lambda-a & -b & 0\\
-c & \lambda-d & -e\\
0 & -f & \lambda-g
\end{pmatrix}
=0.`,
				// 用行数组构造精确预期，避免一条过长字符串难以区分矩阵行；后两行必须与第一行矩阵起点对齐。
				[
					// 第一行含矩阵首行和后续等号/句点，各列中较短的内容用空格补齐列宽。
					"f(z) = 1/(2π i) ∮_γ (f(ζ))/(ζ-z) dζ, det⎛ λ-a │ -b  │ 0   ⎞ = 0.",
					// 模板插值中的repeat(40)生成40个普通空格，将矩阵中间行移到第一行矩阵所在列。
					`${" ".repeat(40)}⎜ -c  │ λ-d │ -e  ⎟`,
					// 末行采用相同40格缩进，括号底部字形闭合矩阵；数字40是此固定样例的预期，不是动态终端宽度。
					`${" ".repeat(40)}⎝ 0   │ -f  │ λ-g ⎠`,
					// join用LF连接三行，实际断言会连同每行空格一起比较。
				].join("\n"),
			],
			[
				// 整段输入含求和、下括注、指数以及两行cases：underbrace在此用文字下标近似，cases把条件式排为多行。
				String.raw`\Psi(x,t)=
\sum_{n=1}^{\infty}
\underbrace{
c_n
\sqrt{\frac{2}{L}}
\sin\!\left(\frac{n\pi x}{L}\right)
}_{\text{spatial eigenmode}}
\exp\!\left(-\frac{i\hbar n^2\pi^2}{2mL^2}t\right),
\qquad
|\Psi(x,t)|^2
=
\begin{cases}
\Psi^\ast\Psi, & 0<x<L,\\
0, & \text{otherwise}.
\end{cases}`,
				// 97格缩进使cases首尾行与长公式末尾左大括号对齐；两行条件之间插一条仅含大括号中段⎨的行，长公式落在其基线，otherwise不重复加if。
				`${" ".repeat(97)}⎧ Ψ^∗Ψ if 0 < x < L,\nΨ(x,t) = ∑ₙ₌₁^∞ cₙ √(2/L) sin((nπ x)/L)_(spatial eigenmode) exp(-(iℏ n²π²)/(2mL²)t), |Ψ(x,t)|² = ⎨\n${" ".repeat(97)}⎩ 0    otherwise.`,
			],
			// 一元二次求根式仍是文本转换：复合分子/分母以括号包住，根号内平方变Unicode上标。
			[String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, "x = (-b±√(b²-4ac))/(2a)"],
			// 积分上下界默认线性附在积分号旁，负平方指数回退^(-x²)，根π作分子时用括号。
			[String.raw`\int_0^\infty e^{-x^2}\,dx=\frac{\sqrt{\pi}}{2}`, "∫₀^∞ e^(-x²) dx = (√π)/2"],
			// 复指数回退^(iθ)，sin/cos作为命名算子与后面变量留空格，不执行欧拉公式推导。
			[String.raw`e^{i\theta}=\cos\theta+i\sin\theta`, "e^(iθ) = cos θ+i sin θ"],
			// 求和的n=1可以转换成Unicode下标，∞无法转上标时保留^∞；后面的分数仍是线性的。
			[String.raw`\sum_{n=1}^{\infty}\frac{1}{n^2}=\frac{\pi^2}{6}`, "∑ₙ₌₁^∞1/(n²) = π²/6"],
			// lim的下界在普通模式中用方括号显示，sin与x保持命名算子间距，末尾等号规范。
			[String.raw`\lim_{x\to 0}\frac{\sin x}{x}=1`, "lim[x→0] (sin x)/x = 1"],
			[
				// 两行物理源文字组成一个极限公式，left/right只控制分隔符语义，这里不会强制放大括号。
				String.raw`\lim_{n\to\infty}
\left(1+\frac{1}{n}\right)^n=e`,
				// 下界写成[n→∞]，外层n具备Unicode上标ⁿ，物理换行没有输出为新行。
				"lim[n→∞] (1+1/n)ⁿ = e",
			],
			[
				// 积分式分两条物理源行，第二行接等式；线性frac包住复合分母，ln作为命名算子显示。
				String.raw`\int_0^1 \frac{x^2}{1+x^3}\,dx
=\frac{1}{3}\ln 2`,
				// 预期积分上下界为₀¹、两边分数为斜杠形式，等式不在此做积分计算。
				"∫₀¹ x²/(1+x³) dx = 1/3 ln 2",
			],
			[
				// 求和与后续等式跨物理换行；大括号包住k+1与n+1，分别供分数分母和脚标解析。
				String.raw`\sum_{k=1}^{n}\frac{k}{k+1}
=n+1-H_{n+1}`,
				// 求和上下界有可用Unicode字形，H的n+1也映射为ₙ₊₁，不额外添加求和内容的空格。
				"∑ₖ₌₁ⁿk/(k+1) = n+1-Hₙ₊₁",
			],
			[
				// 多行源码构造一个外层分数，分子里是两个分数相减、分母又是分数；displaystyle在这里不把缺省display切为true。
				String.raw`\frac{
  \displaystyle \frac{x^2+1}{x-1}
  -
  \displaystyle \frac{2x}{x+1}
}{
  \displaystyle \frac{x}{x^2-1}
}`,
				// 全部仍用线性斜杠与分组括号，物理缩进/换行只留下需要的空白；不是TeX的二维分式图。
				"((x²+1)/(x-1) - 2x/(x+1))/(x/(x²-1))",
			],
			[
				// 极限接一个嵌套分数：分子为sin(x)/x减1，分母为(e^x-1)/x减1，物理多行不表示多条输出。
				String.raw`\lim_{x\to 0}
\frac{
  \displaystyle \frac{\sin x}{x}-1
}{
  \displaystyle \frac{e^x-1}{x}-1
}
=0`,
				// 嵌套分数的复合两侧各带括号，e的x上标可映射为ˣ；这里只固定渲染文字，不判断这个极限值。
				"lim[x→0] ((sin x)/x-1)/((eˣ-1)/x-1) = 0",
			],
			[
				// 分子与分母都含继续嵌套的倒数；大括号表示解析分组，不逐层输出原有花括号。
				String.raw`\frac{
  1+\displaystyle\frac{1}{1+\frac{1}{x}}
}{
  1-\displaystyle\frac{1}{1-\frac{1}{x}}
}`,
				// 普通模式输出一条线性连分式，括号保留各层加减法范围，未自动做代数化简。
				"(1+1/(1+1/x))/(1-1/(1-1/x))",
			],
			[
				// 求和后带复合分数，内部的displaystyle仍仅作为被接受的样式命令忽略，不改变外层选项。
				String.raw`\sum_{n=1}^{\infty}
\frac{
  \displaystyle \frac{1}{n}-\frac{1}{n+1}
}{
  \displaystyle 1+\frac{1}{n^2}
}`,
				// 预期求和脚标与线性分式同处一行，括号区分整个分子和分母，平方仍为²。
				"∑ₙ₌₁^∞ (1/n-1/(n+1))/(1+1/(n²))",
			],
		]);
	});

	// 用一条混合公式核对常见符号、上下界、根号及脚标；回调不收测试上下文，执行同步精确断言，失败向运行器抛出。
	it("renders common symbols, roots, sums, and integrals", () => {
		// 比较实际转换串与完整预期，不能仅凭含有某个符号就算通过。
		assert.strictEqual(
			// 输入同时含求和、alpha下标、积分、负平方指数、控制空格和根π；默认不启用纵向显示排版。
			renderLatex(String.raw`\sum_{i=0}^n \alpha_i + \int_0^\infty e^{-x^2}\,dx = \sqrt{\pi}`),
			// 预期上下界尽量用Unicode脚标，无法映射的负平方指数用括号回退。
			"∑ᵢ₌₀ⁿ αᵢ + ∫₀^∞ e^(-x²) dx = √π",
		);
	});

	// 组合检查二项式与单/多字符重音的有限表示；断言的是终端文字近似，不保证TeX字体或完整重音绘制。
	it("renders common accents and binomial notation", () => {
		// 一次严格比较四项输出及中间加号，保持样例整体顺序。
		assert.strictEqual(
			// binom提供两参数，vec/hat作用于单字母，overline作用于AB两个字母，走不同重音分支。
			renderLatex(String.raw`\binom{n}{k}+\vec{x}+\hat{y}+\overline{AB}`),
			// 二项式用(n choose k)近似，单字母附组合重音；多字母overline回退为命令名加括号。
			"(n choose k)+x⃗+ŷ+overline(AB)",
		);
	});

	// 核对扩展符号映射及选定的否定关系；使用同步断言，任一映射或空格不符即失败。
	it("renders extended symbols and negated relations", () => {
		// 第一条聚合变体希腊字母、圈加/圈乘和因为/所以符号。
		assert.strictEqual(
			// 每个反斜杠命令都由String.raw原样送入解析器，+只负责分开样本。
			renderLatex(String.raw`\epsilon+\varepsilon+\varsigma+\varkappa+\oplus+\otimes+\therefore+\because`),
			// 不同epsilon拼法有不同Unicode输出ϵ/ε，不能把相近字形当成同一字符串。
			"ϵ+ε+ς+ϰ+⊕+⊗+∴+∵",
		);
		// not与subseteq/in组合得到有专用字形的⊈/∉，quad只留下空格。
		assert.strictEqual(renderLatex(String.raw`A\not\subseteq B,\quad x\not\in X`), "A ⊈ B, x ∉ X");
	});

	// 关系代数连接符的固定映射回归：只转换符号文字，不实现数据库的关系运算。
	it("renders relational algebra join operators", () => {
		// bowtie和大写Join两个命令都映射成⋈，保留左右关系名。
		assert.strictEqual(renderLatex(String.raw`R\bowtie S,\quad R\Join S`), "R ⋈ S, R ⋈ S");
		// ltimes/rtimes分别映射左/右半连接符⋉/⋊，次序不能交换。
		assert.strictEqual(renderLatex(String.raw`R\ltimes S,\quad R\rtimes S`), "R ⋉ S, R ⋊ S");
		// 完整比较三种外连接的组合输出，而非只检测支持其中一种命令。
		assert.strictEqual(
			// 三个长命令依次表示左、右、全外连接，显式quad隔开表达式。
			renderLatex(String.raw`R\leftouterjoin S,\quad R\rightouterjoin S,\quad R\fullouterjoin S`),
			// 预期三个不同字形⟕/⟖/⟗与对应输入一一匹配。
			"R ⟕ S, R ⟖ S, R ⟗ S",
		);
	});

	// 检查显式分隔符命令和left/right的不可见点分隔；有限终端输出不做真正自适应TeX括号伸缩。
	it("renders delimiter commands and invisible delimiters", () => {
		// 第一条混合绝对值、范数和导数求值条件，结果必须完整匹配。
		assert.strictEqual(
			// left.中的点不显示；right|输出竖线，随后x=0作为下标解析；分母dx属于复合文字因此加括号。
			renderLatex(String.raw`\lvert{x}\rvert+\lVert{v}\rVert+\left.\frac{dy}{dx}\right|_{x=0}`),
			// 预期|、‖和末尾求值下标ₓ₌₀同时存在，不将不可见分隔点当小数点。
			"|x|+‖v‖+dy/(dx)|ₓ₌₀",
		);
		// left/middle/right不作为正文输出，实际花括号和竖线保留，x>0的关系间距被规范。
		assert.strictEqual(renderLatex(String.raw`\left\lbrace x \middle| x>0 \right\rbrace`), "{ x | x > 0 }");
	});

	// 检查命名、取模、上置和下置算子的文字表示；每条断言单独覆盖一种组合，不评估数学运算。
	it("renders named, modular, overlaid, and underlaid operators", () => {
		// 带星operatorname允许界限，普通模式将下界写成[x∈X]，arg和max间仍留单空格。
		assert.strictEqual(renderLatex(String.raw`\operatorname*{arg\,max}_{x\in X} f(x)`), "arg max[x∈X] f(x)");
		// bmod使用中间mod文字，pmod加括号表示(mod n)，equiv转为≡并留空格。
		assert.strictEqual(renderLatex(String.raw`a\bmod n,\quad a\equiv b\pmod n`), "a mod n, a ≡ b (mod n)");
		// overset/stackrel把上方内容当上标；underset用下标。感叹号无法映射时回退^!，def可映射成ᵈᵉᶠ。
		assert.strictEqual(renderLatex(String.raw`\overset{!}{=}+\underset{n}{x}+\stackrel{def}{=}`), "=^!+xₙ+=ᵈᵉᶠ");
	});

	// 覆盖带根指数、重音回退和字体包装；三个严格断言分别检查根号、重音、包装后的整串。
	it("renders indexed roots and additional accents and wrappers", () => {
		// 开始比较五种根指数，区分专用根号与普通根号前的上标。
		assert.strictEqual(
			// 2/3/4对应平方根/立方根/四次根字形；n/k使用可映射上标，复合被开方项x+1要括号。
			renderLatex(String.raw`\sqrt[2]{x}+\sqrt[3]{x}+\sqrt[4]{x}+\sqrt[n]{x}+\sqrt[k]{x+1}`),
			// 预期正好五项，单项x不加括号，x+1保留分组；不是计算开方结果。
			"√x+∛x+∜x+ⁿ√x+ᵏ√(x+1)",
		);
		// 重音断言同时包含单字母可组合情形和多字母文字回退。
		assert.strictEqual(
			// acute/grave给x/y附重音，widehat/overrightarrow覆盖多个字母，有限渲染器不铺开长重音线。
			renderLatex(String.raw`\acute{x}+\grave{y}+\widehat{xyz}+\overrightarrow{AB}`),
			// 预期x́/ỳ是基础字母与组合重音组成的字符串，另两项保留命令名和正文括号。
			"x́+ỳ+widehat(xyz)+overrightarrow(AB)",
		);
		// 最后比较各种字体包装的去包装结果，不要求终端输出粗体、斜体等样式控制码。
		assert.strictEqual(
			// 本次仍只传source，缺省选项使用普通模式。
			renderLatex(
				// textnormal/mbox/boldsymbol包装和组内旧式rm/bf/it/sf/tt/cal/sl声明均在这条输入中，正文需要保留。
				String.raw`\textnormal{hello}+\mbox{world}+\boldsymbol{x}+{\rm roman}+{\bf bold}+{\it italic}+{\sf sans}+{\tt mono}+{\cal calligraphic}+{\sl slanted}`,
			),
			// 预期只剩普通单词与x，说明这些包装命令在支持子集中主要用于接受/去除样式标记。
			"hello+world+x+roman+bold+italic+sans+mono+calligraphic+slanted",
		);
	});

	// 检查额外环境的拆行规则；环境名包含equation并不自动开启display选项，此处仍是缺省模式。
	it("renders additional display environments", () => {
		// 第一条精确比较外层equation包住split的两行输出。
		assert.strictEqual(
			// split内&是对齐标记、双反斜杠是行边界；没有第二行左操作数时仅保留其等号和c。
			renderLatex(String.raw`\begin{equation}\begin{split}a&=b\\&=c\end{split}\end{equation}`),
			// 输出是a = b与= c两行，\n在JavaScript字符串中实际代表LF。
			"a = b\n= c",
		);
		// 第二条针对alignedat，独立核对列对拼接和行划分。
		assert.strictEqual(
			// 前置{2}列对声明被接受并剥去，&分出的相邻对合并后再以空格连接；quad不保留原始间距长度。
			renderLatex(String.raw`\begin{alignedat}{2}a&=b&\quad c&=d\\e&=f&g&=h\end{alignedat}`),
			// 每条输出行有两个等式，行间LF保留，而原来的&和列对参数不显示。
			"a = b c = d\ne = f g = h",
		);
	});

	// 检查分段条件的自然文字与矩阵列宽补齐；断言仅覆盖这些固定尺寸样本的精确排版。
	it("uses natural case conditions and aligns matrix columns", () => {
		// 第一条同时比较cases括号、条件文字和f(x)基线位置。
		assert.strictEqual(
			// 三个分支分别不给if、已给if、给otherwise；实现会给首种补if，后两种不再重复追加。
			renderLatex(String.raw`f(x)=\begin{cases}a & x<0 \\ b & \text{if }x=0 \\ c & \text{otherwise}\end{cases}`),
			// 三行分支与⎧/⎨/⎩对应，中行接f(x) = ，首尾行加7格缩进；条件中的关系号有规范空格。
			"       ⎧ a if x < 0\nf(x) = ⎨ b if x = 0\n       ⎩ c otherwise",
		);
		// 第二条用长短不同的数值让矩阵每列的补齐行为可见。
		assert.strictEqual(
			// 两行两列的pmatrix，第一列最长3000、第二列最长200，列宽依可见列数计算。
			renderLatex(String.raw`\begin{pmatrix}1&200\\3000&4\end{pmatrix}`),
			// 短项后填空格对齐│与右括号，数字只作单元格正文，不执行矩阵运算。
			"⎛ 1    │ 200 ⎞\n⎝ 3000 │ 4   ⎠",
		);
	});

	// display下检查外层分数、矩阵、相邻矩阵与算子纵向布局的组合基线；所有结果仍是带LF的文字，不操作屏幕。
	it("composes matrices with fractions and adjacent matrices", () => {
		// 第一条将一个外层角度分数与旋转矩阵拼接，比较整段三行排版。
		assert.strictEqual(
			// 传入完整公式与显示选项，得到一个合成文字结果。
			renderLatex(
				// 跨行模板中R的角度是外层frac，等号后是2×2矩阵；矩阵单元中的sqrt(2)/2故意保持线性，末尾句点附在矩阵最后一行。
				String.raw`R\left(\frac{\pi}{4}\right)
=
\begin{pmatrix}
\frac{\sqrt{2}}{2} & -\frac{\sqrt{2}}{2}\\
\frac{\sqrt{2}}{2} & \frac{\sqrt{2}}{2}
\end{pmatrix}.`,
				// 对象字段display:true明确开启外层纵向分数；TypeScript检查字段类型，运行实现使用严格等于true判断。
				{ display: true },
			),
			// π与4分居横线两侧；矩阵首行与R(横线) = 同基线，句点留在矩阵底行，所有前导空格都参与断言。
			"   π\nR( ─ ) = ⎛ (√2)/2 │ -(√2)/2 ⎞\n   4     ⎝ (√2)/2 │ (√2)/2  ⎠.",
		);
		// 第二条在同一公式里串接外层角度分数和两个列向量，验证多个节点的上下位置协调。
		assert.strictEqual(
			// 继续显式启用display，不能根据组名猜测渲染选项。
			renderLatex(
				// 模板用mathbf包装w，后面是R(π/4)、向量(1,0)、等号和结果向量；物理换行被归一，向量环境才提供可见行。
				String.raw`\mathbf w
=
R\left(\frac{\pi}{4}\right)
\begin{pmatrix}1\\0\end{pmatrix}
=
\begin{pmatrix}\frac{\sqrt{2}}{2}\\\frac{\sqrt{2}}{2}\end{pmatrix}.`,
				// display只控制允许堆叠的节点，向量单元中的分数仍是线性分数。
				{ display: true },
			),
			// 三行预期中角度分数上下行、两个两行向量的相对缩进均固定，结果向量句点在底行。
			"       π\nw = R( ─ ) ⎛ 1 ⎞ = ⎛ (√2)/2 ⎞\n       4   ⎝ 0 ⎠   ⎝ (√2)/2 ⎠.",
		);
		// 第三条将两个列向量并排写在普通文字中，避免后来节点破坏先前矩阵的列对齐。
		assert.strictEqual(
			// 一条输入包含两个独立pmatrix节点，渲染器需要在共享行基线上组合。
			renderLatex(
				// Ae₁/Ae₂分别接两行向量，中间逗号和quad分开；第二向量中的frac位于矩阵单元，保持1/π。
				String.raw`A\mathbf e_1=\begin{pmatrix}\pi\\0\end{pmatrix},\qquad A\mathbf e_2=\begin{pmatrix}0\\\frac{1}{\pi}\end{pmatrix}.`,
				// 显示模式在此也不把矩阵单元里的分数拆成三行，因为矩阵单元的子解析关闭了display。
				{ display: true },
			),
			// 预期两个向量首行处于同一输出行，底行在各自位置补空格，末尾句点附在最后向量底部。
			"Ae₁ = ⎛ π ⎞, Ae₂ = ⎛ 0   ⎞\n      ⎝ 0 ⎠        ⎝ 1/π ⎠.",
		);
		// 第四条把上下界求和算子放在矩阵前，专门检查基线不一样的节点共存。
		assert.strictEqual(
			// display让sum的上下界纵排，右侧2×2矩阵本来就多行，xi数字下标仍用Unicode。
			renderLatex(String.raw`\sum_{i=0}^n x_i=\begin{pmatrix}a&b\\c&d\end{pmatrix}.`, { display: true }),
			// 首行只含求和上界n，中行含∑与矩阵首行，底行放下界及矩阵底行；这是节点基线组合的固定结果。
			" n\n ∑  xᵢ = ⎛ a │ b ⎞\ni=0      ⎝ c │ d ⎠.",
		);
	});

	// 比较空白规范化与命名算子分隔；循环覆盖多种输入空白，之后逐条覆盖关系/乘法/函数连接边界。
	it("normalizes relation, multiplication, and named-operator spacing", () => {
		// 四种输入仅等号周围空白不同，包含真实LF；for...of逐个复用同一个预期。
		for (const source of ["x=y", "x =y", "x=\ny", "x\n=\ny"]) {
			// 每种都应归一为x = y，说明普通源码换行不等于强制数学输出换行。
			assert.strictEqual(renderLatex(source), "x = y");
		}
		// 脚标内容中的i=0去掉关系空白后整体映射为ᵢ₌₀，不把主表达式的等号间距规则原封套入脚标。
		assert.strictEqual(renderLatex("x_{i=0}"), "xᵢ₌₀");
		// 命令neq紧跟数字时仍正确识别并在≠两侧插空格。
		assert.strictEqual(renderLatex(String.raw`x\neq0`), "x ≠ 0");
		// to映射箭头并保留左右操作数间距。
		assert.strictEqual(renderLatex(String.raw`A\to B`), "A → B");
		// 显式乘号cdot输出·并加间距，frac保持1/π而不与旁边π合并。
		assert.strictEqual(renderLatex(String.raw`\pi\cdot\frac{1}{\pi}`), "π · 1/π");
		// 命名sin与紧跟theta之间要有分隔空格。
		assert.strictEqual(renderLatex(String.raw`\sin\theta`), "sin θ");
		// sin的平方附在算子名上，随后x仍以空格隔开。
		assert.strictEqual(renderLatex(String.raw`\sin^2 x`), "sin² x");
		// 一元负号保留在sin前，不额外插成- sin。
		assert.strictEqual(renderLatex(String.raw`-\sin\theta`), "-sin θ");
		// 前置普通字母i与命名sin之间需要分隔，避免连成isin。
		assert.strictEqual(renderLatex(String.raw`i\sin\theta`), "i sin θ");
		// det后面是左括号时不加空格，输出det(A)，与后接字母的情形区分。
		assert.strictEqual(renderLatex(String.raw`\det(A)`), "det(A)");
	});

	// 检查反斜杠接物理LF或CRLF的控制空格；这与两个反斜杠表示环境分行不同，断言均为单行文字。
	it("treats a backslash followed by a line ending as control space", () => {
		// 整段原始模板是boxed坐标列表：第三行前的反斜杠接真实换行，其他反斜杠空格也只表示分隔空格；这些源换行都不要求保留为输出行。
		const source = String.raw`\boxed{
(1,1,1),\ (1,1,2),\ (1,2,5),\ (1,5,13),\ (2,5,29),\
(1,13,34),\ (1,34,89)
}.`;
		// 完整比较列表输出，避免把控制空格误解析成未知命令而返回undefined。
		assert.strictEqual(
			// 虽然传display:true，此输入没有需纵排的分数/算子，boxed仍只是方括号文字。
			renderLatex(source, { display: true }),
			// 预期所有坐标位于一行，控制换行只贡献一个空格，末尾框后句点保留。
			"[(1,1,1), (1,1,2), (1,2,5), (1,5,13), (2,5,29), (1,13,34), (1,34,89)].",
		);
		// 普通字符串用转义构造a、单个反斜杠、CRLF、b，明确覆盖Windows式行尾同样转成空格。
		assert.strictEqual(renderLatex("a\\\r\nb"), "a b");
	});

	// 验证显示模式的算子上下界位置及limits/nolimits覆盖规则；回调同步做五条精确输出比较。
	it("stacks operator limits in display mode", () => {
		// sum上下界在∑上/下方，正文xi在算子基线，左侧空格用于居中对齐。
		assert.strictEqual(renderLatex(String.raw`\sum_{i=0}^n x_i`, { display: true }), " n\n ∑  xᵢ\ni=0");
		// min只有下界，主行保留min f(x)，下一行x∈X位于算子下面。
		assert.strictEqual(renderLatex(String.raw`\min_{x\in X} f(x)`, { display: true }), "min f(x)\nx∈X");
		// 完整比较带星命名算子的纵向下界布局。
		assert.strictEqual(
			// operatorname*允许把arg max当有界算子，下界是x属于X，正文f(x)仍跟在算子基线。
			renderLatex(String.raw`\operatorname*{arg\,max}_{x\in X} f(x)`, {
				// 显式display:true允许该有界命名算子生成两行。
				display: true,
			}),
			// 下界比arg max短，左侧补两格居中；空格数是精确输出的一部分。
			"arg max f(x)\n  x∈X",
		);
		// nolimits覆盖显示模式的默认偏好，积分上下界仍写为线性Unicode₀¹。
		assert.strictEqual(renderLatex(String.raw`\int\nolimits_0^1 f(x)\,dx`, { display: true }), "∫₀¹ f(x) dx");
		// limits反向要求纵排，1在积分号上方、0在下方，正文保持在积分基线上。
		assert.strictEqual(renderLatex(String.raw`\int\limits_0^1 f(x)\,dx`, { display: true }), "1\n∫ f(x) dx\n0");
	});

	// 偶数分段行的左大括号在中段⎨处增加一条基线行；用两分支样例固定该布局，两条实际分支分居该行上方和下方。
	it("centers even case rows around a middle brace", () => {
		// 严格比较两分支转成三行后的全部括号、空格和条件文字。
		assert.strictEqual(
			// 平方分支与负x分支分别给出≥0和<0条件，不传display也能由cases产生多行。
			renderLatex(String.raw`f(x) = \begin{cases} x^{2} & x \geq 0 \\ -x & x < 0 \end{cases}`),
			// 中间行只有f(x) = 与⎨，上下各一个实际分支；首尾7格缩进使括号竖向对齐。
			"       ⎧ x² if x ≥ 0\nf(x) = ⎨\n       ⎩ -x if x < 0",
		);
	});

	// 检查显示模式把外层分数排成分子/横线/分母三层，样例还覆盖参数之间的源换行。
	it("stacks fractions in display mode", () => {
		// 第一条使用复合求根式以显露居中补齐及横线长度。
		assert.strictEqual(
			// 渲染源仍是不带外层数学分隔符的公式；传选项而非displaystyle命令来开启外层堆叠。
			renderLatex(String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`, {
				// display:true让这个外层frac生成布局节点，复合根号在分子里保留线性写法。
				display: true,
			}),
			// 分子宽度决定横线长度，分母2a在其下方居中，x = 位于横线基线。
			"    -b±√(b²-4ac)\nx = ────────────\n         2a",
		);
		// 简单独立frac没有左侧正文，x²+1/横线/x-1分成三行，长短项按列居中。
		assert.strictEqual(renderLatex(String.raw`\frac{x^2+1}{x-1}`, { display: true }), "x²+1\n────\nx-1");
		// 普通字符串里\n是真实换行，夹在两个花括号参数之间应作为可跳过空白，仍能识别完整分数。
		assert.strictEqual(renderLatex("\\frac{1}\n{2}", { display: true }), "1\n─\n2");
	});

	// 显示模式只堆叠外层分数，嵌套在其分子/分母里的分数维持线性，避免每层都拉高输出。
	it("keeps nested display fractions linear", () => {
		// Array<[string,string]>是可变元组数组的开发期类型，这里仅读取；每对保存同一显示模式下的输入及完整多行预期。
		const cases: Array<[string, string]> = [
			[
				// 第一个外层分数的分子是两分数相减，分母又有分数；内部命令必须在线性模式解析。
				String.raw`\frac{\frac{x^2+1}{x-1}-\frac{2x}{x+1}}{\frac{x}{x^2-1}}`,
				// 只用一条长横线分隔整个分子/分母，内部仍是斜杠和括号，分母按整条横线居中。
				"(x²+1)/(x-1)-2x/(x+1)\n─────────────────────\n      x/(x²-1)",
			],
			[
				// 第二个输入同时有lim下界和外层分数，二者都可能生成布局节点，内部两分数依旧线性。
				String.raw`\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0`,
				// 预期lim下界独占底部左侧，外层分数三层在其右侧组合，最后等号在横线基线。
				"     (sin x)/x-1\nlim  ─────────── = 0\nx→0  (eˣ-1)/x-1",
			],
			[
				// 第三个输入是更深的嵌套倒数链，最外层以外都保持一行表示。
				String.raw`\frac{1+\frac{1}{1+\frac{1}{x}}}{1-\frac{1}{1-\frac{1}{x}}}`,
				// 分子/分母各一行文字加中间横线，不递归生成更高的分数塔。
				"1+1/(1+1/x)\n───────────\n1-1/(1-1/x)",
			],
		];
		// 解构遍历样例；这些断言在同一个it内执行，不像defineCases那样每条注册独立测试。
		for (const [source, expected] of cases) {
			// 统一显式display:true后严格比较每条多行结果，任一失败会终止本回调余下断言。
			assert.strictEqual(renderLatex(source, { display: true }), expected);
		}
	});

	// 这里的unsupported指缺少Unicode脚标映射而采用二维排版，不代表不支持的LaTeX命令也会成功；同时检查嵌套脚标和脚标内分数。
	it("lays out unsupported and nested scripts while keeping script fractions linear", () => {
		// 第一条比较复杂脚标的完整五行结果，空白负责把不同深度脚标对准各自基字符。
		assert.strictEqual(
			// Aj的星下标、(1-t)的复合负指数，以及n内再含平方、i内再含j，触发多种脚标布局节点。
			renderLatex(String.raw`\partial_tU_2(t,0)=Aj_*(1-t)^{-A-1}.\qquad x^{n^2}+x_{i_j}`, {
				// display:true允许有限的多行脚标布局，不等于支持所有LaTeX排版语法。
				display: true,
			}),
			// 预期脚标分布在主行上下；第一段∂ₜ和U₂可用Unicode直接表示，其余需占不同输出行，标点位置也固定。
			"                            2\n                    -A-1   n\n∂ₜU₂(t,0) = Aj (1-t)    . x  +x\n              *                i\n                                j",
		);
		// 指数中的frac始终线性回退^(1/2)，显式tfrac也保持1/2，即使显示模式开启也不堆叠这两处。
		assert.strictEqual(renderLatex(String.raw`e^{\frac{1}{2}}+\tfrac{1}{2}`, { display: true }), "e^(1/2)+1/2");
	});

	// 验证一个未知命令使整个结果返回undefined，供调用者决定回退；不保证所有运行时异常都被捕获成undefined。
	it("returns undefined for unsupported commands", () => {
		// unknown不在支持命令集合中，不能仅保留x或剥去命令后冒充成功。
		assert.strictEqual(renderLatex(String.raw`x + \unknown{y}`), undefined);
	});

	// 用四个有限畸形样例检查解析失败返回值：缺分组右括号、多余右括号、缺环境结束、末尾孤立反斜杠；不是对任意错误的完备证明。
	it("returns undefined for malformed groups and environments", () => {
		// malformed是字符串数组，分别保存上述四种输入；最后普通字符串的双反斜杠转义实际构造一个尾随反斜杠。
		const malformed = [String.raw`\frac{1}{x`, "x}", String.raw`\begin{matrix}1 & 2`, "x\\"];
		// 按样例顺序在一个测试回调里检查，for...of不改变这些输入字符串。
		for (const source of malformed) {
			// 每种都应为undefined而非部分渲染文本；测试没有断言超深嵌套、内存耗尽等异常也会变成此值。
			assert.strictEqual(renderLatex(source), undefined);
		}
	});
});
