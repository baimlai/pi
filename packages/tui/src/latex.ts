// 将有限LaTeX数学源码转为终端Unicode文字：Markdown先识别并去外层分隔符，再交本模块解析；本模块不计算数学值、不运行TeX或发网络请求。
// 普通公式先生成一维字符串；需二维的分数/上下限/矩阵先放节点表，用私用区标记占位，最后按基线拼成多行。失败多以undefined让Markdown回退原文。
// 列宽使用共享visibleWidth估算；它可更新宽度缓存，不读真实终端。字符串位置按UTF-16，for...of/Array.from遍历码点，三者不要混用。
import { visibleWidth } from "./utils.ts";

// 命令名到实际显示符号的表；Record<string,string>描述字符串映射，Readonly只禁止通过此类型改字段，运行时没有freeze或自动存在性检查。
const SYMBOLS: Readonly<Record<string, string>> = {
	// alpha显示小写阿尔法，命令名不含前导反斜杠。
	alpha: "α",
	// beta显示小写贝塔。
	beta: "β",
	// gamma显示小写伽马。
	gamma: "γ",
	// delta显示小写德尔塔。
	delta: "δ",
	// epsilon采用此表指定的ϵ字形。
	epsilon: "ϵ",
	// varepsilon采用另一个ε字形，与上一项区别保留。
	varepsilon: "ε",
	// zeta显示小写泽塔。
	zeta: "ζ",
	// eta显示小写伊塔。
	eta: "η",
	// theta采用θ字形。
	theta: "θ",
	// vartheta采用ϑ变体字形。
	vartheta: "ϑ",
	// iota显示小写约塔。
	iota: "ι",
	// kappa采用κ字形。
	kappa: "κ",
	// varkappa采用ϰ变体字形。
	varkappa: "ϰ",
	// lambda显示小写兰姆达。
	lambda: "λ",
	// mu显示希腊μ，不是ASCII字母u。
	mu: "μ",
	// nu显示希腊ν，不是ASCII字母v。
	nu: "ν",
	// xi显示小写克西。
	xi: "ξ",
	// pi显示圆周率常用π符号，但这里只替换字形不代入数值。
	pi: "π",
	// varpi显示ϖ变体。
	varpi: "ϖ",
	// rho采用ρ字形。
	rho: "ρ",
	// varrho采用ϱ变体字形。
	varrho: "ϱ",
	// sigma采用普通σ。
	sigma: "σ",
	// varsigma采用词尾形ς。
	varsigma: "ς",
	// tau显示小写陶。
	tau: "τ",
	// upsilon显示小写υ。
	upsilon: "υ",
	// phi采用ϕ字形。
	phi: "ϕ",
	// varphi采用φ变体，按源码表区分而不统一。
	varphi: "φ",
	// chi显示希腊χ，不是ASCII字母x。
	chi: "χ",
	// psi显示小写普西。
	psi: "ψ",
	// omega显示小写欧米伽。
	omega: "ω",
	// 大写命令Gamma显示Γ，命令查表区分大小写。
	Gamma: "Γ",
	// Delta显示大写Δ。
	Delta: "Δ",
	// Theta显示大写Θ。
	Theta: "Θ",
	// Lambda显示大写Λ。
	Lambda: "Λ",
	// Xi显示大写Ξ。
	Xi: "Ξ",
	// Pi显示大写Π。
	Pi: "Π",
	// Sigma显示大写Σ，和后面求和命令sum分开。
	Sigma: "Σ",
	// Upsilon显示大写Υ。
	Upsilon: "Υ",
	// Phi显示大写Φ。
	Phi: "Φ",
	// Psi显示大写Ψ。
	Psi: "Ψ",
	// Omega显示大写Ω。
	Omega: "Ω",
	// pm替成正负号，常见于误差或两解表达式。
	pm: "±",
	// mp替成与pm相反次序的负正号。
	mp: "∓",
	// times替成交叉乘号，parseCommand另给它左右补空格。
	times: "×",
	// div替成除号，不在这里执行除法。
	div: "÷",
	// cdot替成居中乘点，命令分支另补两侧空格。
	cdot: "·",
	// ast显示数学星号∗，不是普通ASCII星号。
	ast: "∗",
	// star显示星形运算符⋆。
	star: "⋆",
	// circ显示复合运算常用的小圆圈。
	circ: "∘",
	// bullet显示实心圆点。
	bullet: "•",
	// oplus显示圈加号。
	oplus: "⊕",
	// ominus显示圈减号。
	ominus: "⊖",
	// otimes显示圈乘号。
	otimes: "⊗",
	// oslash显示圈斜线。
	oslash: "⊘",
	// odot显示圈点号。
	odot: "⊙",
	// bigcirc显示大空心圆，不请求终端放大字形。
	bigcirc: "○",
	// dagger显示单剑号。
	dagger: "†",
	// ddagger显示双剑号。
	ddagger: "‡",
	// amalg显示合并/余积常用符号⨿，语义由公式作者决定。
	amalg: "⨿",
	// uplus显示带加号的并集符号。
	uplus: "⊎",
	// sqcap显示方交符号。
	sqcap: "⊓",
	// sqcup显示方并符号。
	sqcup: "⊔",
	// bowtie显示关系连接常用的蝴蝶结符号。
	bowtie: "⋈",
	// 大小写敏感的Join命令是同一⋈符号别名。
	Join: "⋈",
	// ltimes显示左半连接式符号。
	ltimes: "⋉",
	// rtimes显示右半连接式符号。
	rtimes: "⋊",
	// leftouterjoin显示左外连接符号，不执行数据查询。
	leftouterjoin: "⟕",
	// rightouterjoin显示右外连接符号。
	rightouterjoin: "⟖",
	// fullouterjoin显示全外连接符号。
	fullouterjoin: "⟗",
	// triangleleft显示朝左空心三角运算符。
	triangleleft: "◁",
	// triangleright显示朝右空心三角运算符。
	triangleright: "▷",
	// wr显示花环积常用符号≀。
	wr: "≀",
	// cap显示集合交符号。
	cap: "∩",
	// cup显示集合并符号。
	cup: "∪",
	// bigcap显示大型交符号，后面可解析显示式上下限。
	bigcap: "⋂",
	// bigcup显示大型并符号。
	bigcup: "⋃",
	// bigwedge显示大型逻辑与符号。
	bigwedge: "⋀",
	// bigvee显示大型逻辑或符号。
	bigvee: "⋁",
	// bigsqcup显示大型方并符号。
	bigsqcup: "⨆",
	// biguplus显示大型带加号并符号。
	biguplus: "⨄",
	// bigoplus显示大型圈加符号。
	bigoplus: "⨁",
	// bigotimes显示大型圈乘符号。
	bigotimes: "⨂",
	// bigodot显示大型圈点符号。
	bigodot: "⨀",
	// setminus显示集合差的斜线符号。
	setminus: "∖",
	// in显示“属于”。
	in: "∈",
	// notin直接显示“不属于”，不需先走not组合。
	notin: "∉",
	// ni显示反向属于，即包含元素的符号。
	ni: "∋",
	// subset显示子集关系符号⊂，不在这里决定严格/非严格数学约定。
	subset: "⊂",
	// supset显示反向超集符号⊃。
	supset: "⊃",
	// subseteq显示子集或相等符号。
	subseteq: "⊆",
	// supseteq显示超集或相等符号。
	supseteq: "⊇",
	// sqsubset显示方形子关系。
	sqsubset: "⊏",
	// sqsupset显示反向方形子关系。
	sqsupset: "⊐",
	// sqsubseteq显示带等线的方形子关系。
	sqsubseteq: "⊑",
	// sqsupseteq显示反向带等线方形关系。
	sqsupseteq: "⊒",
	// prec显示先于关系。
	prec: "≺",
	// preceq显示先于或等价关系。
	preceq: "≼",
	// succ显示后于关系。
	succ: "≻",
	// succeq显示后于或等价关系。
	succeq: "≽",
	// ll显示远小于。
	ll: "≪",
	// gg显示远大于。
	gg: "≫",
	// le显示小于等于。
	le: "≤",
	// leq与le同映射，不保留命令名区别。
	leq: "≤",
	// leqslant同样映射≤，未区分斜体等线字体。
	leqslant: "≤",
	// ge显示大于等于。
	ge: "≥",
	// geq与ge同映射。
	geq: "≥",
	// geqslant同样映射≥，不生成另一套字体。
	geqslant: "≥",
	// ne显示不等于。
	ne: "≠",
	// neq与ne同映射。
	neq: "≠",
	// equiv显示恒等/等价符号。
	equiv: "≡",
	// approx显示近似号。
	approx: "≈",
	// sim显示相似/波浪关系符号。
	sim: "∼",
	// simeq显示波浪加等线关系。
	simeq: "≃",
	// cong显示全等式关系符号。
	cong: "≅",
	// asymp显示上下弧形的关系符号≍。
	asymp: "≍",
	// doteq显示顶点等号。
	doteq: "≐",
	// propto显示成比例符号。
	propto: "∝",
	// parallel显示平行符号。
	parallel: "∥",
	// perp显示垂直符号。
	perp: "⊥",
	// mid显示整除/条件分隔常用的竖线关系。
	mid: "∣",
	// vdash显示右向推导符号⊢。
	vdash: "⊢",
	// dashv显示反向推导符号⊣。
	dashv: "⊣",
	// models显示语义蕴涵符号⊨。
	models: "⊨",
	// Vdash显示双竖线推导式符号⊩。
	Vdash: "⊩",
	// Vvdash显示三竖线推导式符号⊪。
	Vvdash: "⊪",
	// nvdash直接显示带否定的⊬。
	nvdash: "⊬",
	// nvDash直接显示带否定的⊭，命令大小写要精确。
	nvDash: "⊭",
	// forall显示全称量词。
	forall: "∀",
	// exists显示存在量词。
	exists: "∃",
	// nexists显示不存在量词。
	nexists: "∄",
	// neg显示逻辑非。
	neg: "¬",
	// land显示逻辑与。
	land: "∧",
	// wedge是同一∧字形别名。
	wedge: "∧",
	// lor显示逻辑或。
	lor: "∨",
	// vee是同一∨字形别名。
	vee: "∨",
	// to显示右箭头。
	to: "→",
	// rightarrow是右箭头别名。
	rightarrow: "→",
	// longrightarrow仍显示单个→，不模拟LaTeX的加长字形。
	longrightarrow: "→",
	// leftarrow显示左箭头。
	leftarrow: "←",
	// longleftarrow同样使用单个←。
	longleftarrow: "←",
	// gets是左箭头别名。
	gets: "←",
	// leftrightarrow显示双向单线箭头。
	leftrightarrow: "↔",
	// longleftrightarrow仍用同一↔，不增加列数。
	longleftrightarrow: "↔",
	// hookleftarrow显示朝左钩箭头。
	hookleftarrow: "↩",
	// hookrightarrow显示朝右钩箭头。
	hookrightarrow: "↪",
	// twoheadleftarrow显示双头左箭头。
	twoheadleftarrow: "↞",
	// twoheadrightarrow显示双头右箭头。
	twoheadrightarrow: "↠",
	// leftharpoonup显示左向上钩半箭头。
	leftharpoonup: "↼",
	// leftharpoondown显示左向下钩半箭头。
	leftharpoondown: "↽",
	// rightharpoonup显示右向上钩半箭头。
	rightharpoonup: "⇀",
	// rightharpoondown显示右向下钩半箭头。
	rightharpoondown: "⇁",
	// rightleftharpoons显示右上左下的一对半箭头。
	rightleftharpoons: "⇌",
	// leftrightharpoons显示左上右下的一对半箭头。
	leftrightharpoons: "⇋",
	// nearrow显示右上斜箭头。
	nearrow: "↗",
	// searrow显示右下斜箭头。
	searrow: "↘",
	// swarrow显示左下斜箭头。
	swarrow: "↙",
	// nwarrow显示左上斜箭头。
	nwarrow: "↖",
	// rightsquigarrow显示右向波浪箭头。
	rightsquigarrow: "⇝",
	// leadsto是同一⇝别名。
	leadsto: "⇝",
	// Rightarrow显示右向双线箭头，与小写rightarrow区分。
	Rightarrow: "⇒",
	// Longrightarrow仍采用⇒，不做字形加长。
	Longrightarrow: "⇒",
	// Leftarrow显示左向双线箭头。
	Leftarrow: "⇐",
	// Longleftarrow采用同一⇐。
	Longleftarrow: "⇐",
	// Leftrightarrow显示双向双线箭头。
	Leftrightarrow: "⇔",
	// Longleftrightarrow采用同一⇔。
	Longleftrightarrow: "⇔",
	// implies是⇒的语义别名。
	implies: "⇒",
	// iff是⇔的语义别名。
	iff: "⇔",
	// mapsto显示映射到箭头。
	mapsto: "↦",
	// longmapsto同样显示单个↦。
	longmapsto: "↦",
	// uparrow显示向上箭头。
	uparrow: "↑",
	// downarrow显示向下箭头。
	downarrow: "↓",
	// partial显示偏导常用符号，不进行求导。
	partial: "∂",
	// nabla显示梯度/散度常用倒三角，不进行向量计算。
	nabla: "∇",
	// int显示单重积分号，后续可读上下限。
	int: "∫",
	// iint显示二重积分号。
	iint: "∬",
	// iiint显示三重积分号。
	iiint: "∭",
	// oint显示闭合曲线积分号。
	oint: "∮",
	// sum显示求和运算符，不计算累加结果。
	sum: "∑",
	// prod显示连乘符号。
	prod: "∏",
	// coprod显示余积运算符。
	coprod: "∐",
	// infty显示无穷符号，不生成JS Infinity数值。
	infty: "∞",
	// emptyset显示空集。
	emptyset: "∅",
	// varnothing也显示∅，此表不保留字体变体。
	varnothing: "∅",
	// angle显示角符号。
	angle: "∠",
	// therefore显示“所以”三点符号。
	therefore: "∴",
	// because显示“因为”三点符号。
	because: "∵",
	// aleph显示基数常用的阿列夫字形。
	aleph: "ℵ",
	// beth显示贝斯字形。
	beth: "ℶ",
	// gimel显示吉梅尔字形。
	gimel: "ℷ",
	// daleth显示达列特字形。
	daleth: "ℸ",
	// top显示顶元素/真常用符号⊤。
	top: "⊤",
	// bot显示底元素/假常用符号⊥，同字形也可在perp中表示垂直。
	bot: "⊥",
	// triangle显示空心三角形。
	triangle: "△",
	// square显示空心方框。
	square: "□",
	// lozenge显示空心菱形。
	lozenge: "◊",
	// checkmark显示勾形数学符号，不表示程序已完成验证。
	checkmark: "✓",
	// complement显示补集常用字形。
	complement: "∁",
	// wp显示魏尔施特拉斯函数常用字形。
	wp: "℘",
	// prime显示撇号形式的数学上撇。
	prime: "′",
	// ldots显示基线省略号。
	ldots: "…",
	// dots也映射同一省略号。
	dots: "…",
	// cdots显示居中三点。
	cdots: "⋯",
	// vdots显示竖向三点。
	vdots: "⋮",
	// ddots显示斜向三点。
	ddots: "⋱",
	// ell显示花体小写l。
	ell: "ℓ",
	// hbar显示约化普朗克常用的带横线h符号，不代入常数。
	hbar: "ℏ",
	// Im显示花体I，常用来标虚部。
	Im: "ℑ",
	// Re显示花体R，常用来标实部。
	Re: "ℜ",
	// langle显示左角括号。
	langle: "⟨",
	// rangle显示右角括号。
	rangle: "⟩",
	// vert显示单竖线。
	vert: "|",
	// lvert左侧形式仍是同一单竖线。
	lvert: "|",
	// rvert右侧形式也不另区别字形。
	rvert: "|",
	// Vert显示双竖线，大小写与vert不同。
	Vert: "‖",
	// lVert左侧双竖线别名。
	lVert: "‖",
	// rVert右侧双竖线别名。
	rVert: "‖",
	// lbrace把命令显示为左花括号，而普通未转义花括号用于分组。
	lbrace: "{",
	// rbrace显示右花括号。
	rbrace: "}",
	// backslash显示一个反斜杠，JS源码中用双反斜杠表达它。
	backslash: "\\",
	// lfloor显示向下取整的左括号。
	lfloor: "⌊",
	// rfloor显示向下取整的右括号。
	rfloor: "⌋",
	// lceil显示向上取整的左括号。
	lceil: "⌈",
	// rceil显示向上取整的右括号。
	rceil: "⌉",
	// colon显示普通冒号，不引入特殊二维布局。
	colon: ":",
};

// 具名运算符集合，has只检查命令名；普通分支会加内部首尾标记，让后处理在相邻字母间补空格，不求函数值。
const NAMED_OPERATORS = new Set([
	// 反余弦arccos作为文字运算符。
	"arccos",
	// 反正弦arcsin作为文字运算符。
	"arcsin",
	// 反正切arctan作为文字运算符。
	"arctan",
	// arg保留名称，常用于辐角等记号。
	"arg",
	// cos保留余弦函数名。
	"cos",
	// cosh保留双曲余弦函数名。
	"cosh",
	// cot保留余切函数名。
	"cot",
	// coth保留双曲余切函数名。
	"coth",
	// csc保留余割函数名。
	"csc",
	// deg保留次数/度数运算符名。
	"deg",
	// det保留行列式名，不展开矩阵。
	"det",
	// dim保留维数运算符名。
	"dim",
	// exp保留指数函数名。
	"exp",
	// gcd保留最大公约数运算符名。
	"gcd",
	// hom保留同态集合常用运算符名。
	"hom",
	// inf也在此集合，但parseCommand先匹配LIMIT_OPERATORS，实际通常走下限运算符路径。
	"inf",
	// ker保留核运算符名。
	"ker",
	// lg保留lg名称，不在此决定对数底数。
	"lg",
	// lim也列在此，但会被先匹配的LIMIT_OPERATORS处理。
	"lim",
	// liminf优先走下极限运算符分支。
	"liminf",
	// limsup优先走上极限运算符分支。
	"limsup",
	// ln保留自然对数名称。
	"ln",
	// log保留log名称，不替用户推断底数。
	"log",
	// max优先走LIMIT_OPERATORS，便于紧接下标条件。
	"max",
	// min同样优先由下限运算符路径读取脚标。
	"min",
	// Pr保留大小写，用于概率运算符文字。
	"Pr",
	// sec保留正割函数名。
	"sec",
	// sin保留正弦函数名，后处理可在相邻文字间补空格。
	"sin",
	// sinh保留双曲正弦函数名。
	"sinh",
	// sup优先由LIMIT_OPERATORS处理而非这里普通具名路径。
	"sup",
	// tan保留正切函数名。
	"tan",
	// tanh保留双曲正切函数名。
	"tanh",
]);

// 这些命令先于SYMBOLS/NAMED_OPERATORS匹配，统一读上下标；行内下标用方括号，display模式通常可竖排上下限。
const LIMIT_OPERATORS = new Set([
	// argmax支持最优点条件，下标行内可显示为argmax[x∈X]，而非把整段条件强转成Unicode下标。
	"argmax",
	// argmin使用同样下限运算符流程。
	"argmin",
	// inf作为可附上下限的文字运算符。
	"inf",
	// injlim保留直接极限的命令名文字。
	"injlim",
	// lim读取极限条件脚标。
	"lim",
	// liminf读取下极限条件脚标。
	"liminf",
	// limsup读取上极限条件脚标。
	"limsup",
	// max读取最大值的条件脚标。
	"max",
	// min读取最小值的条件脚标。
	"min",
	// projlim保留逆极限命令名文字并支持脚标。
	"projlim",
	// sup读取上确界条件脚标。
	"sup",
]);

// 已从SYMBOLS取到字形后，这些运算符再走parseOperator读脚标；display可竖排，行内则优先Unicode上下标，limits/nolimits可覆盖偏好。
const DISPLAY_LIMIT_SYMBOLS = new Set([
	// 大型交符号允许显示式上下限。
	"bigcap",
	// 大型并符号允许显示式上下限。
	"bigcup",
	// 大型圈点允许附上下限。
	"bigodot",
	// 大型圈加允许附上下限。
	"bigoplus",
	// 大型圈乘允许附上下限。
	"bigotimes",
	// 大型方并允许附上下限。
	"bigsqcup",
	// 大型带加并允许附上下限。
	"biguplus",
	// 大型逻辑或允许附上下限。
	"bigvee",
	// 大型逻辑与允许附上下限。
	"bigwedge",
	// 余积符号允许附上下限。
	"coprod",
	// 单积分在此实现也默认可在display竖排上下限，并非完整TeX积分排版规则。
	"int",
	// 二重积分同用上下限布局策略。
	"iint",
	// 三重积分同用上下限布局策略。
	"iiint",
	// 闭合积分同用上下限布局策略。
	"oint",
	// 连乘运算符读上下限。
	"prod",
	// 求和运算符读上下限。
	"sum",
]);

// 普通符号中的关系类命令集合：parseCommand在字形两边加空格；这是显示间距策略，不是数学类型检查或实际逻辑推断。
const RELATION_COMMANDS = new Set([
	// 双线左箭头⇐按关系间距处理，在符号两侧加空格。
	"Leftarrow",
	// 双线双向箭头⇔按关系间距处理，在符号两侧加空格。
	"Leftrightarrow",
	// 长左箭头别名⇐按关系间距处理，在符号两侧加空格。
	"Longleftarrow",
	// 长双向箭头别名⇔按关系间距处理，在符号两侧加空格。
	"Longleftrightarrow",
	// 长右箭头别名⇒按关系间距处理，在符号两侧加空格。
	"Longrightarrow",
	// 双线右箭头⇒按关系间距处理，在符号两侧加空格。
	"Rightarrow",
	// 连接别名⋈按关系间距处理，在符号两侧加空格。
	"Join",
	// 双竖推导⊩按关系间距处理，在符号两侧加空格。
	"Vdash",
	// 三竖推导⊪按关系间距处理，在符号两侧加空格。
	"Vvdash",
	// 近似号≈按关系间距处理，在符号两侧加空格。
	"approx",
	// 弧形关系≍按关系间距处理，在符号两侧加空格。
	"asymp",
	// 连接符⋈按关系间距处理，在符号两侧加空格。
	"bowtie",
	// 全等式关系≅按关系间距处理，在符号两侧加空格。
	"cong",
	// 反向推导⊣按关系间距处理，在符号两侧加空格。
	"dashv",
	// 全外连接⟗按关系间距处理，在符号两侧加空格。
	"fullouterjoin",
	// 顶点等号≐按关系间距处理，在符号两侧加空格。
	"doteq",
	// 下箭头↓按关系间距处理，在符号两侧加空格。
	"downarrow",
	// 恒等号≡按关系间距处理，在符号两侧加空格。
	"equiv",
	// 大于等于别名≥按关系间距处理，在符号两侧加空格。
	"ge",
	// 大于等于≥按关系间距处理，在符号两侧加空格。
	"geq",
	// 斜等线别名≥按关系间距处理，在符号两侧加空格。
	"geqslant",
	// 赋值向左别名←按关系间距处理，在符号两侧加空格。
	"gets",
	// 远大于≫按关系间距处理，在符号两侧加空格。
	"gg",
	// 左钩箭头↩按关系间距处理，在符号两侧加空格。
	"hookleftarrow",
	// 右钩箭头↪按关系间距处理，在符号两侧加空格。
	"hookrightarrow",
	// 充要条件别名⇔按关系间距处理，在符号两侧加空格。
	"iff",
	// 蕴含别名⇒按关系间距处理，在符号两侧加空格。
	"implies",
	// 属于∈按关系间距处理，在符号两侧加空格。
	"in",
	// 波浪箭头别名⇝按关系间距处理，在符号两侧加空格。
	"leadsto",
	// 小于等于别名≤按关系间距处理，在符号两侧加空格。
	"le",
	// 左箭头←按关系间距处理，在符号两侧加空格。
	"leftarrow",
	// 左下半箭头↽按关系间距处理，在符号两侧加空格。
	"leftharpoondown",
	// 左上半箭头↼按关系间距处理，在符号两侧加空格。
	"leftharpoonup",
	// 双向箭头↔按关系间距处理，在符号两侧加空格。
	"leftrightarrow",
	// 左上右下半箭头⇋按关系间距处理，在符号两侧加空格。
	"leftrightharpoons",
	// 左外连接⟕按关系间距处理，在符号两侧加空格。
	"leftouterjoin",
	// 小于等于≤按关系间距处理，在符号两侧加空格。
	"leq",
	// 斜等线别名≤按关系间距处理，在符号两侧加空格。
	"leqslant",
	// 远小于≪按关系间距处理，在符号两侧加空格。
	"ll",
	// 长左箭头别名←按关系间距处理，在符号两侧加空格。
	"longleftarrow",
	// 长双向箭头别名↔按关系间距处理，在符号两侧加空格。
	"longleftrightarrow",
	// 长映射别名↦按关系间距处理，在符号两侧加空格。
	"longmapsto",
	// 长右箭头别名→按关系间距处理，在符号两侧加空格。
	"longrightarrow",
	// 左半连接⋉按关系间距处理，在符号两侧加空格。
	"ltimes",
	// 映射到↦按关系间距处理，在符号两侧加空格。
	"mapsto",
	// 整除竖线∣按关系间距处理，在符号两侧加空格。
	"mid",
	// 语义蕴涵⊨按关系间距处理，在符号两侧加空格。
	"models",
	// 不等于别名≠按关系间距处理，在符号两侧加空格。
	"ne",
	// 右上箭头↗按关系间距处理，在符号两侧加空格。
	"nearrow",
	// 不等于≠按关系间距处理，在符号两侧加空格。
	"neq",
	// 反向属于∋按关系间距处理，在符号两侧加空格。
	"ni",
	// 不属于∉按关系间距处理，在符号两侧加空格。
	"notin",
	// 不可推导⊬按关系间距处理，在符号两侧加空格。
	"nvdash",
	// 非语义蕴涵⊭按关系间距处理，在符号两侧加空格。
	"nvDash",
	// 左上箭头↖按关系间距处理，在符号两侧加空格。
	"nwarrow",
	// 平行∥按关系间距处理，在符号两侧加空格。
	"parallel",
	// 垂直⊥按关系间距处理，在符号两侧加空格。
	"perp",
	// 先于≺按关系间距处理，在符号两侧加空格。
	"prec",
	// 先于或等价≼按关系间距处理，在符号两侧加空格。
	"preceq",
	// 成比例∝按关系间距处理，在符号两侧加空格。
	"propto",
	// 右下半箭头⇁按关系间距处理，在符号两侧加空格。
	"rightharpoondown",
	// 右上半箭头⇀按关系间距处理，在符号两侧加空格。
	"rightharpoonup",
	// 右上左下半箭头⇌按关系间距处理，在符号两侧加空格。
	"rightleftharpoons",
	// 右外连接⟖按关系间距处理，在符号两侧加空格。
	"rightouterjoin",
	// 右箭头→按关系间距处理，在符号两侧加空格。
	"rightarrow",
	// 右波浪箭头⇝按关系间距处理，在符号两侧加空格。
	"rightsquigarrow",
	// 右半连接⋊按关系间距处理，在符号两侧加空格。
	"rtimes",
	// 右下箭头↘按关系间距处理，在符号两侧加空格。
	"searrow",
	// 相似波浪∼按关系间距处理，在符号两侧加空格。
	"sim",
	// 波浪等线≃按关系间距处理，在符号两侧加空格。
	"simeq",
	// 方形子关系⊏按关系间距处理，在符号两侧加空格。
	"sqsubset",
	// 带等线方形子关系⊑按关系间距处理，在符号两侧加空格。
	"sqsubseteq",
	// 反向方形子关系⊐按关系间距处理，在符号两侧加空格。
	"sqsupset",
	// 反向带等线方形关系⊒按关系间距处理，在符号两侧加空格。
	"sqsupseteq",
	// 子集形关系⊂按关系间距处理，在符号两侧加空格。
	"subset",
	// 子集或相等⊆按关系间距处理，在符号两侧加空格。
	"subseteq",
	// 后于≻按关系间距处理，在符号两侧加空格。
	"succ",
	// 后于或等价≽按关系间距处理，在符号两侧加空格。
	"succeq",
	// 超集形关系⊃按关系间距处理，在符号两侧加空格。
	"supset",
	// 超集或相等⊇按关系间距处理，在符号两侧加空格。
	"supseteq",
	// 左下箭头↙按关系间距处理，在符号两侧加空格。
	"swarrow",
	// 右箭头别名→按关系间距处理，在符号两侧加空格。
	"to",
	// 左三角关系◁按关系间距处理，在符号两侧加空格。
	"triangleleft",
	// 右三角关系▷按关系间距处理，在符号两侧加空格。
	"triangleright",
	// 左双头箭头↞按关系间距处理，在符号两侧加空格。
	"twoheadleftarrow",
	// 右双头箭头↠按关系间距处理，在符号两侧加空格。
	"twoheadrightarrow",
	// 上箭头↑按关系间距处理，在符号两侧加空格。
	"uparrow",
	// 推导符⊢按关系间距处理，在符号两侧加空格。
	"vdash",
]);

// not命令的预组否定符号表；先查完整参数，存在直接用相应Unicode，不存在才给首码点加组合斜线。
const NEGATED_SYMBOLS: Readonly<Record<string, string>> = {
	// 小于符号的预组否定为不小于。
	"<": "≮",
	// 大于符号的预组否定为不大于。
	">": "≯",
	// 等号否定为不等号。
	"=": "≠",
	// 属于否定为不属于。
	"∈": "∉",
	// 反向属于否定为不包含该元素。
	"∋": "∌",
	// 整除竖线否定为不整除。
	"∣": "∤",
	// 平行否定为不平行。
	"∥": "∦",
	// 波浪关系否定采用≁。
	"∼": "≁",
	// 波浪等线关系否定采用≄。
	"≃": "≄",
	// 全等式关系否定采用≇。
	"≅": "≇",
	// 近似关系否定采用≉。
	"≈": "≉",
	// 恒等关系否定采用≢。
	"≡": "≢",
	// 小于等于否定采用≰。
	"≤": "≰",
	// 大于等于否定采用≱。
	"≥": "≱",
	// 先于关系否定采用⊀。
	"≺": "⊀",
	// 后于关系否定采用⊁。
	"≻": "⊁",
	// 子集形关系否定采用⊄。
	"⊂": "⊄",
	// 超集形关系否定采用⊅。
	"⊃": "⊅",
	// 子集或相等关系否定采用⊈。
	"⊆": "⊈",
	// 超集或相等关系否定采用⊉。
	"⊇": "⊉",
	// 推导关系否定采用⊬。
	"⊢": "⊬",
	// 语义蕴涵关系否定采用⊭。
	"⊨": "⊭",
	// 双向单线箭头否定采用↮。
	"↔": "↮",
	// 左单线箭头否定采用↚。
	"←": "↚",
	// 右单线箭头否定采用↛。
	"→": "↛",
	// 右双线箭头否定采用⇏。
	"⇒": "⇏",
	// 左双线箭头否定采用⇍。
	"⇐": "⇍",
	// 双向双线箭头否定采用⇎。
	"⇔": "⇎",
	// 先于或等价关系否定采用⋠。
	"≼": "⋠",
	// 后于或等价关系否定采用⋡。
	"≽": "⋡",
};

// mathbb只对这几个字母提供双线体字形，其他字符原样保留，不加载字体；Readonly为编译期约束。
const BLACKBOARD: Readonly<Record<string, string>> = {
	// C双线体常表示复数集。
	C: "ℂ",
	// H双线体常表示四元数等集合。
	H: "ℍ",
	// N双线体常表示自然数集。
	N: "ℕ",
	// P双线体常表示射影空间/概率等记号，具体意义由公式决定。
	P: "ℙ",
	// Q双线体常表示有理数集。
	Q: "ℚ",
	// R双线体常表示实数集。
	R: "ℝ",
	// Z双线体常表示整数集。
	Z: "ℤ",
};

// 可直接替成Unicode上标的有限字符表；只有参数每一码点均有映射才整串成功，缺字会回退^等文本/显示布局。
const SUPERSCRIPTS: Readonly<Record<string, string>> = {
	// Unicode上标字形映射：数字0→⁰。
	"0": "⁰",
	// Unicode上标字形映射：数字1→¹。
	"1": "¹",
	// Unicode上标字形映射：数字2→²。
	"2": "²",
	// Unicode上标字形映射：数字3→³。
	"3": "³",
	// Unicode上标字形映射：数字4→⁴。
	"4": "⁴",
	// Unicode上标字形映射：数字5→⁵。
	"5": "⁵",
	// Unicode上标字形映射：数字6→⁶。
	"6": "⁶",
	// Unicode上标字形映射：数字7→⁷。
	"7": "⁷",
	// Unicode上标字形映射：数字8→⁸。
	"8": "⁸",
	// Unicode上标字形映射：数字9→⁹。
	"9": "⁹",
	// Unicode上标字形映射：加号→⁺。
	"+": "⁺",
	// Unicode上标字形映射：减号→⁻。
	"-": "⁻",
	// Unicode上标字形映射：等号→⁼。
	"=": "⁼",
	// Unicode上标字形映射：左括号→⁽。
	"(": "⁽",
	// Unicode上标字形映射：右括号→⁾。
	")": "⁾",
	// Unicode上标字形映射：a→ᵃ。
	a: "ᵃ",
	// Unicode上标字形映射：b→ᵇ。
	b: "ᵇ",
	// Unicode上标字形映射：c→ᶜ。
	c: "ᶜ",
	// Unicode上标字形映射：d→ᵈ。
	d: "ᵈ",
	// Unicode上标字形映射：e→ᵉ。
	e: "ᵉ",
	// Unicode上标字形映射：f→ᶠ。
	f: "ᶠ",
	// Unicode上标字形映射：g→ᵍ。
	g: "ᵍ",
	// Unicode上标字形映射：h→ʰ。
	h: "ʰ",
	// Unicode上标字形映射：i→ⁱ。
	i: "ⁱ",
	// Unicode上标字形映射：j→ʲ。
	j: "ʲ",
	// Unicode上标字形映射：k→ᵏ。
	k: "ᵏ",
	// Unicode上标字形映射：l→ˡ。
	l: "ˡ",
	// Unicode上标字形映射：m→ᵐ。
	m: "ᵐ",
	// Unicode上标字形映射：n→ⁿ。
	n: "ⁿ",
	// Unicode上标字形映射：o→ᵒ。
	o: "ᵒ",
	// Unicode上标字形映射：p→ᵖ。
	p: "ᵖ",
	// Unicode上标字形映射：r→ʳ。
	r: "ʳ",
	// Unicode上标字形映射：s→ˢ。
	s: "ˢ",
	// Unicode上标字形映射：t→ᵗ。
	t: "ᵗ",
	// Unicode上标字形映射：u→ᵘ。
	u: "ᵘ",
	// Unicode上标字形映射：v→ᵛ。
	v: "ᵛ",
	// Unicode上标字形映射：w→ʷ。
	w: "ʷ",
	// Unicode上标字形映射：x→ˣ。
	x: "ˣ",
	// Unicode上标字形映射：y→ʸ。
	y: "ʸ",
	// Unicode上标字形映射：z→ᶻ。
	z: "ᶻ",
};

// 可直接替成Unicode下标的有限字符表，字母覆盖少于上标表；找不到某字符不临时造字体。
const SUBSCRIPTS: Readonly<Record<string, string>> = {
	// Unicode下标字形映射：数字0→₀。
	"0": "₀",
	// Unicode下标字形映射：数字1→₁。
	"1": "₁",
	// Unicode下标字形映射：数字2→₂。
	"2": "₂",
	// Unicode下标字形映射：数字3→₃。
	"3": "₃",
	// Unicode下标字形映射：数字4→₄。
	"4": "₄",
	// Unicode下标字形映射：数字5→₅。
	"5": "₅",
	// Unicode下标字形映射：数字6→₆。
	"6": "₆",
	// Unicode下标字形映射：数字7→₇。
	"7": "₇",
	// Unicode下标字形映射：数字8→₈。
	"8": "₈",
	// Unicode下标字形映射：数字9→₉。
	"9": "₉",
	// Unicode下标字形映射：加号→₊。
	"+": "₊",
	// Unicode下标字形映射：减号→₋。
	"-": "₋",
	// Unicode下标字形映射：等号→₌。
	"=": "₌",
	// Unicode下标字形映射：左括号→₍。
	"(": "₍",
	// Unicode下标字形映射：右括号→₎。
	")": "₎",
	// Unicode下标字形映射：a→ₐ。
	a: "ₐ",
	// Unicode下标字形映射：e→ₑ。
	e: "ₑ",
	// Unicode下标字形映射：h→ₕ。
	h: "ₕ",
	// Unicode下标字形映射：i→ᵢ。
	i: "ᵢ",
	// Unicode下标字形映射：j→ⱼ。
	j: "ⱼ",
	// Unicode下标字形映射：k→ₖ。
	k: "ₖ",
	// Unicode下标字形映射：l→ₗ。
	l: "ₗ",
	// Unicode下标字形映射：m→ₘ。
	m: "ₘ",
	// Unicode下标字形映射：n→ₙ。
	n: "ₙ",
	// Unicode下标字形映射：o→ₒ。
	o: "ₒ",
	// Unicode下标字形映射：p→ₚ。
	p: "ₚ",
	// Unicode下标字形映射：r→ᵣ。
	r: "ᵣ",
	// Unicode下标字形映射：s→ₛ。
	s: "ₛ",
	// Unicode下标字形映射：t→ₜ。
	t: "ₜ",
	// Unicode下标字形映射：u→ᵤ。
	u: "ᵤ",
	// Unicode下标字形映射：v→ᵥ。
	v: "ᵥ",
	// Unicode下标字形映射：x→ₓ。
	x: "ₓ",
};

// 正间距命令统一简化成一个普通空格，quad/qquad不保留TeX实际尺寸；后处理还会合并普通重复空格。
const SPACING_COMMANDS = new Set([
	// 反斜杠逗号原是细空格，这里简化为一空格。
	",",
	// 反斜杠冒号原是中等间距，这里也只给一空格。
	":",
	// 反斜杠分号的较大间距同样简化。
	";",
	// 反斜杠接普通空格作为控制空格。
	" ",
	// 反斜杠大于号也按间距命令处理，不显示大于关系。
	">",
	// enspace简化为一个ASCII空格。
	"enspace",
	// enskip同样不测字体em尺寸。
	"enskip",
	// medspace简化中等数学间距。
	"medspace",
	// quad不生成固定一em，而只给一个普通空格。
	"quad",
	// qquad也不生成双倍em宽度。
	"qquad",
	// thickspace较厚间距简化为一空格。
	"thickspace",
	// thinspace细间距简化为一空格。
	"thinspace",
]);
// 负间距命令!、negmedspace、negthickspace、negthinspace共同返回内部NEGATIVE_SPACE哨兵，不真的把终端光标向左移动。
const NEGATIVE_SPACING_COMMANDS = new Set(["!", "negmedspace", "negthickspace", "negthinspace"]);
// NUL内部哨兵由parseSequence拦截：修剪前结果尾空白及可能的具名运算符结束标记，不直接输出控制码来模拟间距。
const NEGATIVE_SPACE = "\u0000";
// 旧式bf/cal/it/rm/sf/sl/tt字体切换只消费命令并跳后续空白；不生成对应字体/ANSI样式。
const FONT_SWITCH_COMMANDS = new Set(["bf", "cal", "it", "rm", "sf", "sl", "tt"]);
// 这些样式命令在一般命令路径忽略；limits/nolimits若紧接parseOperator则会被其专门读取，不能泛称始终无效。
const IGNORED_COMMANDS = new Set([
	// displaystyle在一般路径不直接切换整个解析器的display选项。
	"displaystyle",
	// limits只在运算符专门读取时能改上下限偏好，落这里就忽略。
	"limits",
	// nolimits同理，运算符读取可禁竖排，而一般路径忽略。
	"nolimits",
	// scriptstyle不加载小号数学字体。
	"scriptstyle",
	// scriptscriptstyle也不缩小终端格。
	"scriptscriptstyle",
	// textstyle不在此切换为另一布局引擎。
	"textstyle",
]);
// 定界符尺寸修饰命令只删命令名，后面括号字形仍按普通文本/符号处理，不实现真实伸缩字体。
const SIZE_COMMANDS = new Set([
	// big的尺寸修饰被忽略。
	"big",
	// Big的不同尺寸也被忽略，命令本身仍区分大小写查表。
	"Big",
	// bigg不生成更大字形。
	"bigg",
	// Bigg不生成更大字形。
	"Bigg",
	// bigl左分隔符尺寸提示被忽略。
	"bigl",
	// Bigl左侧较大尺寸提示被忽略。
	"Bigl",
	// biggl左侧更大尺寸提示被忽略。
	"biggl",
	// Biggl左侧最大尺寸提示被忽略。
	"Biggl",
	// bigr右分隔符尺寸提示被忽略。
	"bigr",
	// Bigr右侧较大尺寸提示被忽略。
	"Bigr",
	// biggr右侧更大尺寸提示被忽略。
	"biggr",
	// Biggr右侧最大尺寸提示被忽略。
	"Biggr",
]);
// 这些包装命令递归读一个必需参数并去掉外壳，不实现字体或上下大括线；text开头/mbox保留参数边缘空白，其他trim。
const PLAIN_WRAPPERS = new Set([
	// emph去强调外壳，保留内部数学解析后的文字。
	"emph",
	// mathcal不加载花体字体，仅返回参数文字。
	"mathcal",
	// mathbf不生成粗体/ANSI，仅保留内容。
	"mathbf",
	// mathfrak不转换哥特字形。
	"mathfrak",
	// mathit不转换斜体字体。
	"mathit",
	// mathrm保留内容，不主动套直立字体。
	"mathrm",
	// mathnormal同样移除外层命令。
	"mathnormal",
	// mathscr不加载书写体。
	"mathscr",
	// mathsf不生成无衬线字体。
	"mathsf",
	// mathtt不另外选择等宽字体。
	"mathtt",
	// mathup不转换为另一套Unicode字母。
	"mathup",
	// mbox保留读到内容的边缘空白，但最终normalize仍可能合并/修剪整段输出。
	"mbox",
	// overbrace只返回参数，不画上方大括弧。
	"overbrace",
	// pmb不模拟重叠加粗。
	"pmb",
	// smash不实现TeX高度/深度压缩。
	"smash",
	// substack不使用专用堆叠引擎，仅解析内部文本，显式换行仍可能存在。
	"substack",
	// text不切换成完整TeX纯文本解析器，内部仍经当前参数解析规则。
	"text",
	// textbf保留文字但不加粗，因text前缀暂保边缘空白。
	"textbf",
	// textit保留文字但不斜体。
	"textit",
	// textmd不设置中等字重。
	"textmd",
	// textnormal不恢复独立字体状态。
	"textnormal",
	// textrm不设置罗马字体。
	"textrm",
	// textsc不做小型大写转换。
	"textsc",
	// textsf不选择无衬线字体。
	"textsf",
	// textsl不生成倾斜字体。
	"textsl",
	// texttt不加载打字机字体。
	"texttt",
	// textup不生成独立直立字体。
	"textup",
	// underbrace不画下方大括弧，只保内部参数。
	"underbrace",
	// bm不生成粗体，只移除包装。
	"bm",
	// boldsymbol不转换粗数学符号。
	"boldsymbol",
]);
// 重音命令到Unicode组合标记的映射；单码点参数才直接附加，多码点回退command(value)，不是对任意文本绘伸缩重音。
const ACCENTS: Readonly<Record<string, string>> = {
	// acute采用组合锐音U+0301。
	acute: "\u0301",
	// bar采用组合上横线U+0305。
	bar: "\u0305",
	// breve采用组合短音U+0306。
	breve: "\u0306",
	// check采用组合抑扬符U+030C。
	check: "\u030c",
	// ddot采用组合双点U+0308。
	ddot: "\u0308",
	// dot采用组合单点U+0307。
	dot: "\u0307",
	// grave采用组合重音U+0300。
	grave: "\u0300",
	// hat采用组合扬抑符U+0302。
	hat: "\u0302",
	// mathring采用组合上圆环U+030A。
	mathring: "\u030a",
	// overleftarrow采用组合上左箭头U+20D6。
	overleftarrow: "\u20d6",
	// overleftrightarrow采用组合上双向箭头U+20E1。
	overleftrightarrow: "\u20e1",
	// overline与bar同采用组合上横线，不画任意长度横线。
	overline: "\u0305",
	// overrightarrow采用组合上右箭头U+20D7。
	overrightarrow: "\u20d7",
	// tilde采用组合波浪符U+0303。
	tilde: "\u0303",
	// underline采用组合下横线U+0332，不发送ANSI下划线开关。
	underline: "\u0332",
	// vec采用组合上右箭头，和overrightarrow同映射。
	vec: "\u20d7",
	// widehat仍采用单个组合扬抑符，不真正拉伸宽度。
	widehat: "\u0302",
	// widetilde同样采用单个组合波浪符。
	widetilde: "\u0303",
};

// 逐码点用字形表替换整串，返回转换串或undefined，不改参数/表；例：上标12两个码点都有映射才返回¹²，一个缺字便整串失败而非混半套字形。
function replaceCharacters(value: string, replacements: Readonly<Record<string, string>>): string | undefined {
	// 创建本次局部结果串。
	let result = "";
	// for...of按Unicode码点遍历，补充平面字符不会被分成两次代理码元。
	for (const character of value) {
		// 查当前码点对应文字；Record类型不等于每个运行时键都存在。
		const replacement = replacements[character];
		// undefined表示缺映射，空串若真实配置则仍视为有效替换。
		if (replacement === undefined) {
			// 任何一字缺失就放弃整串，之前局部结果不返回。
			return undefined;
		}
		// 把字形追加到新串，不更改源字符。
		result += replacement;
	}
	// 全部成功后返回，包括空输入转换出的空串。
	return result;
}

// 规范上下标内容，返回trim后并消掉等/加/减两侧空白的新串，无外部修改；例：i = 0变i=0，其他内部空白未统一删除。
function normalizeScriptValue(value: string): string {
	// 首尾先trim，再用全局捕获组替换保留运算符本身，$1指首组，不是脚标值求和。
	return value.trim().replace(/\s*([=+-])\s*/g, "$1");
}

// 尝试把规范后的上下标整串转Unicode，输入value与sub/sup标签、返回string或undefined；例：下标i=0可得ᵢ₌₀，不做二维布局。
function formatUnicodeScript(value: string, kind: "sub" | "sup"): string | undefined {
	// sub选下标表、sup选上标表；normalize再交逐码点全有才成功的替换器。
	return replaceCharacters(normalizeScriptValue(value), kind === "sub" ? SUBSCRIPTS : SUPERSCRIPTS);
}

// 生成可显示脚标串，输入值与上下类别、返回string不修改外部；先规范/试Unicode，失败用_/^及必要括号，例：下标ABC变_ABC，上标复杂式变^(...)。
function formatScript(value: string, kind: "sub" | "sup"): string {
	// 只重绑局部参数value为规范串，调用方原字符串不变。
	value = normalizeScriptValue(value);
	// Unicode转换可能undefined；内部再次规范不会改变该规则结果。
	const unicode = formatUnicodeScript(value, kind);
	// 显式检查undefined，保留有效空转换串。
	if (unicode !== undefined) {
		// 可完全映射时不加ASCII脚标符号。
		return unicode;
	}

	// 回退前缀由下标_或上标^表示。
	const prefix = kind === "sub" ? "_" : "^";
	// 单码点内容或下标纯ASCII字母串可不包括号；Array.from按码点计，不按字素/终端列。
	if (Array.from(value).length === 1 || (kind === "sub" && /^[A-Za-z]+$/.test(value))) {
		// 前缀后直接接值，例：不存在Unicode下标的大写ABC显示_ABC。
		return `${prefix}${value}`;
	}
	// 其他多码点内容用括号避免范围含糊，例：^(iπ)。
	return `${prefix}(${value})`;
}

// 把分子/分母排成一维a/b，返回新串无求值；trim后按简单字符规则决定括号，例：分母x+1显示(x+1)，不是完整运算优先级解析。
function formatFraction(numerator: string, denominator: string): string {
	// 分子仅局部去首尾空白。
	numerator = numerator.trim();
	// 分母同样trim。
	denominator = denominator.trim();
	// 分子只由Unicode字母/数字/点组成才省括号；.可重复，不是合法小数验证。
	const simpleNumerator = /^[\p{L}\p{N}.]+$/u.test(numerator);
	// 分母纯数字/点或单码点即可省括号；多字母分母要括号，保持一维表示清晰。
	const simpleDenominator = /^[\p{N}.]+$/u.test(denominator) || Array.from(denominator).length === 1;
	// 模板组合可选分子括号、斜杠、可选分母括号，不执行数学除法。
	return `${simpleNumerator ? numerator : `(${numerator})`}/${simpleDenominator ? denominator : `(${denominator})`}`;
}

// 把根号与被开方串组合，返回string无求值；缺省√，简单字母/数字/点直连，否则包括号，例：x+1变√(x+1)。
function formatRoot(value: string, symbol = "√"): string {
	// 去被开方串边缘空白，不修改其内部结构。
	value = value.trim();
	// 按同类简单字串规则选直连或括号；symbol可由调用方提供∛/∜等。
	return /^[\p{L}\p{N}.]+$/u.test(value) ? `${symbol}${value}` : `${symbol}(${value})`;
}

// 具名运算符开启哨兵使用补充私用区码点，后处理认它决定左侧间距，不是终端控制序列。
const NAMED_OPERATOR_START = "\u{f0004}";
// 结束哨兵用于右侧间距；最终normalizeOutput移除它。
const NAMED_OPERATOR_END = "\u{f0005}";
// 后行断言要求前面是字母/数字/右括号或布局结束标记才把开启标记替空格；gu全局Unicode匹配，不消费前一字符。
const NAMED_OPERATOR_LEFT_SPACING_PATTERN = /(?<=[\p{L}\p{N})\]}\u{f0001}])\u{f0004}/gu;
// 前瞻要求后面是字母/数字/根号或布局开始标记时把结束标记替空格，不消费后一字符。
const NAMED_OPERATOR_RIGHT_SPACING_PATTERN = /\u{f0005}(?=[\p{L}\p{N}√\u{f0000}])/gu;

// 清内部具名标记并规范一维输出空白，返回新串无外部修改；例：i加sin标记会得i sin，显式双反斜杠产生的内部换行可保留。
function normalizeOutput(value: string): string {
	// 下面链式处理每一步返回的新串。
	return (
		value
			// 需要左间距的开启哨兵换成一个普通空格。
			.replace(NAMED_OPERATOR_LEFT_SPACING_PATTERN, " ")
			// 其余开启哨兵直接去掉。
			.replaceAll(NAMED_OPERATOR_START, "")
			// 需要右间距的结束哨兵换成空格。
			.replace(NAMED_OPERATOR_RIGHT_SPACING_PATTERN, " ")
			// 去掉其余结束哨兵，避免私用字符直接露到输出。
			.replaceAll(NAMED_OPERATOR_END, "")
			// 按LF拆成逻辑输出行，之后逐行收普通空白。
			.split("\n")
			// 每行把连续ASCII空格/Tab压成一个，再trim边缘；PROTECTED_SPACE私用标记不在普通空格模式内。
			.map((line) => line.replace(/[ \t]+/g, " ").trim())
			// 保留非空行和原数组中非首尾的空行；最末trim还会去掉整体边缘空白，不是逐一删除所有空行。
			.filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
			// 重新用LF连接，显示布局后续还会处理这些行。
			.join("\n")
			// 清最终整体首尾空白，未清布局/保护空格私用标记。
			.trim()
	);
}

// 分数布局节点的编译期结构，实际由解析器push普通对象，不是运行时类。
interface FractionNode {
	// 字面量标签供联合类型收窄。
	type: "fraction";
	// 分子已解析为中间串，其中仍可含其他布局节点标记。
	numerator: string;
	// 分母同样存中间串，绘布局时递归解析占位引用。
	denominator: string;
}

// 运算符上下限节点，条件内容已规范为字符串。
interface OperatorNode {
	// 标签区分它与分数/普通脚标/矩阵。
	type: "operator";
	// 主运算符字形或名称，放在基线行。
	operator: string;
	// 可缺下限，空串与undefined仍有布局区别。
	lower?: string;
	// 可缺上限，存在时主行基线下移一行。
	upper?: string;
}

// 普通上下标的二维节点，不包含原本的主文字；它作为相邻小布局拼在主文字后。
interface ScriptNode {
	// script标签选择上下脚标渲染。
	type: "script";
	// 下标中间串可再含布局标记。
	lower?: string;
	// 上标中间串也可递归布局。
	upper?: string;
}

// 预制多行节点复用matrix标签，cases也用此结构，不仅表示方阵。
interface MatrixNode {
	// matrix标签进入已制行的渲染分支。
	type: "matrix";
	// 已经排好矩阵/分段花括弧的行，最终仍要测宽补白。
	lines: string[];
	// 哪一行与周围表达式基线对齐，零起始行号。
	baseline: number;
}

// 可辨识联合：判断type后TS能推断该节点字段；类型不拦截人为伪造私用标记或校验外部字符串。
type LayoutNode = FractionNode | OperatorNode | ScriptNode | MatrixNode;

// 实际可拼接布局的行数组、占列宽和基线三元信息，不记录字体像素。
interface Layout {
	// 完整二维行文本。
	lines: string[];
	// 布局分配的终端列宽，可能包含行尾隐式空白预算。
	width: number;
	// 零起始基线行号，joinLayouts用它把上下结构对齐。
	baseline: number;
}

// 布局引用开启哨兵，后接节点数组十进制下标。
const LAYOUT_MARKER_START = "\u{f0000}";
// 布局引用结束哨兵，组成“开始+编号+结束”。
const LAYOUT_MARKER_END = "\u{f0001}";
// 全局查找中间串里所有数字节点引用，u支持补充平面私用码点，捕获组是编号。
const LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}/gu;
// 只查结果末尾是否布局引用，供矩阵后的句点归到矩阵末行，不带g不推进lastIndex。
const TRAILING_LAYOUT_MARKER_PATTERN = /\u{f0000}(\d+)\u{f0001}$/u;
// 保护对齐空格用的私用码点，不被一维普通空白合并吞掉，最终renderLatex再换成真实空格。
const PROTECTED_SPACE = "\u{f0002}";

// 补齐一条布局行，输入文字/目标列宽/可选居中、返回新串，无源修改；例：宽5的1居中时左右各补2，不裁剪已经过宽内容。
function padLayoutLine(line: string, width: number, centered = false): string {
	// 用显示列数算需补白，负差按0，不用字符串.length。
	const padding = Math.max(0, width - visibleWidth(line));
	// 居中时左边分一半向下取整；默认左侧0即向右补白。
	const left = centered ? Math.floor(padding / 2) : 0;
	// 左补白+原文字+余下右补白，整数/有限性预期来自内部正常布局数据，不在此全面验证。
	return `${" ".repeat(left)}${line}${" ".repeat(padding - left)}`;
}

// 横向拼接多个二维布局，返回新Layout不改输入；取最大基线上/下高度，按每块基线挑源行，缺行填等宽空格，例：分数与x对齐到分数横线行。
function joinLayouts(layouts: readonly Layout[]): Layout {
	// 没有子布局时仍返回一条空行。
	if (layouts.length === 0) {
		// 空布局宽0、基线0，便于后续统一处理。
		return { lines: [""], width: 0, baseline: 0 };
	}
	// 各块基线前高度取最大值作为合成基线，...展开数值参数。
	const baseline = Math.max(...layouts.map((layout) => layout.baseline));
	// 基线之后行数也取最大，让所有子块下半部分都有空间。
	const below = Math.max(...layouts.map((layout) => layout.lines.length - layout.baseline - 1));
	// 收集合成的实际文字行。
	const lines: string[] = [];
	// 从顶部一直生成到底部，包含基线本身，所以<=。
	for (let row = 0; row <= baseline + below; row++) {
		// 本合成行从空串开始横向累加。
		let line = "";
		// 按表达式原顺序逐块拼。
		for (const layout of layouts) {
			// 总行号减合成基线、加子块基线，得到该子块应取哪行。
			const sourceRow = row - baseline + layout.baseline;
			// 下面三元选择真实源行或等宽占位，并追加到当前行。
			line +=
				// 源行下标必须在该子布局范围内。
				sourceRow >= 0 && sourceRow < layout.lines.length
					? // 有源行则补到它的分配宽度，缺项按空串。
						padLayoutLine(layout.lines[sourceRow] ?? "", layout.width)
					: // 该行不属于这个子布局时填其整块宽度空格。
						" ".repeat(layout.width);
		}
		// 合成行去行尾普通空白后保存，width预算仍单独保留。
		lines.push(line.trimEnd());
	}
	// 返回完整合成布局对象。
	return {
		// 保存生成行数组。
		lines,
		// 总预算宽是所有子块width累加，并非重新测各行最长串。
		width: layouts.reduce((width, layout) => width + layout.width, 0),
		// 基线沿用之前算出的最大值。
		baseline,
	};
}

// 把含布局引用的中间字符串展开成Layout，输入源码串/共享节点表、返回布局；逐LF分行→切文字与节点→递归渲染→按基线横拼。
// 例：分数引用会展开成分子/横线/分母，矩阵保其已排好的行。不是外部格式校验器，无递归深度/循环引用资源上限，字符宽度可能更新共享缓存。
function renderLayout(source: string, nodes: readonly LayoutNode[]): Layout {
	// 收集全部展开后的实际输出行。
	const renderedLines: string[] = [];
	// 保存第一个中间源码行的基线，后续源码行只纵向追加。
	let firstBaseline = 0;
	// 按显式LF逐个布局行处理，不把整个表达式当单一高度。
	for (const sourceLine of source.split("\n")) {
		// 本源码行依次产生若干文本/二维子布局。
		const layouts: Layout[] = [];
		// 本行尚未消费的码元起点。
		let position = 0;
		// 保存前一个已展开节点，用于矩阵两侧普通空白保留策略。
		let previousNode: LayoutNode | undefined;
		// 按源位置依次匹配数字节点引用。
		for (const match of sourceLine.matchAll(LAYOUT_MARKER_PATTERN)) {
			// 引用开头在本sourceLine里的UTF-16位置。
			const index = match.index;
			// 捕获组转number索引共享节点表。
			const node = nodes[Number(match[1])];
			// 不存在节点时跳过此引用处理，不直接报解析错误。
			if (!node) {
				// position未推进，因此这段未知引用可能随后留在普通切片中，不能承诺任意私用输入全消失。
				continue;
			}
			// 节点前还有普通文字要先变成一行子布局。
			if (index > position) {
				// 切上次已消费位置到本节点开头的原文本。
				const sliced = sourceLine.slice(position, index);
				// 有前节点时去该切片左空白，总去右空白；首切片左边则保留。
				const trimmed = (previousNode ? sliced.trimStart() : sliced).trimEnd();
				// 前节点为矩阵且原切片确以空白开始时，稍后恢复一个左间隔。
				const preserveLeadingSpace = previousNode?.type === "matrix" && /^\s/.test(sliced);
				// 本节点为矩阵且原切片以空白结束时，恢复一个右间隔。
				const preserveTrailingSpace = node.type === "matrix" && /\s$/.test(sliced);
				// 根据trim后是否仍有正文决定下面拼接。
				const text = trimmed
					? // 有正文时按两侧保留标志各至多补一个普通空格。
						`${preserveLeadingSpace ? " " : ""}${trimmed}${preserveTrailingSpace ? " " : ""}`
					: // 只剩空白时，只要矩阵邻接需要间隔就保一空格。
						preserveLeadingSpace || preserveTrailingSpace
						? // 保留这一个矩阵旁间距。
							" "
						: // 没有任何间距需要则空串。
							"";
				// 普通文字作为基线0的单行布局，列宽实测。
				layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
			}
			// fraction标签进入递归分数布局。
			if (node.type === "fraction") {
				// 分子中还可能有节点引用，递归展开。
				const numerator = renderLayout(node.numerator, nodes);
				// 分母也递归展开，不只用一行文字宽度。
				const denominator = renderLayout(node.denominator, nodes);
				// 分数横线宽至少1，覆盖分子/分母较宽者。
				const contentWidth = Math.max(numerator.width, denominator.width, 1);
				// 横线两端各留1空格，整块宽再加2。
				const width = contentWidth + 2;
				// 加入这一个分数子布局。
				layouts.push({
					// 行序为所有分子行、横线、所有分母行。
					lines: [
						// 分子各行居中补到整块width，map不修改原分子行数组。
						...numerator.lines.map((line) => padLayoutLine(line, width, true)),
						// 横线只画contentWidth长，两边空格组成整块预算。
						` ${"─".repeat(contentWidth)} `,
						// 分母行同样居中补齐。
						...denominator.lines.map((line) => padLayoutLine(line, width, true)),
					],
					// 保存整块含左右空白的宽度。
					width,
					// 分子行数正好是横线零起始行号，故横线为基线。
					baseline: numerator.lines.length,
				});
				// operator节点渲染为可选上限、主符号、可选下限。
			} else if (node.type === "operator") {
				// 内容宽取下方三种文字列宽最大值。
				const contentWidth = Math.max(
					// 主运算符显示列数。
					visibleWidth(node.operator),
					// 无下限贡献0，否则按完整下限串测宽。
					node.lower === undefined ? 0 : visibleWidth(node.lower),
					// 无上限贡献0，否则按上限串测宽；这里不递归解析它的布局引用。
					node.upper === undefined ? 0 : visibleWidth(node.upper),
				);
				// 准备该运算符的输出行。
				const lines: string[] = [];
				// 只要upper非undefined就生成上限行，空串也算有行。
				if (node.upper !== undefined) {
					// 上限居中到内容宽，再附一个右空格与周围表达式分隔。
					lines.push(`${padLayoutLine(node.upper, contentWidth, true)} `);
				}
				// 主运算符行同样居中并附一右空格。
				lines.push(`${padLayoutLine(node.operator, contentWidth, true)} `);
				// 下限存在才生成其行。
				if (node.lower !== undefined) {
					// 下限居中并补一右空格。
					lines.push(`${padLayoutLine(node.lower, contentWidth, true)} `);
				}
				// 将主符号/上下限整块加入本行布局。
				layouts.push({
					// 采用刚生成的行数组。
					lines,
					// 分配宽比内容多1，供右侧间隔。
					width: contentWidth + 1,
					// 有上限时主符号在行1，否则行0，作为与旁边表达式对齐的基线。
					baseline: node.upper === undefined ? 0 : 1,
				});
				// 普通脚标节点需要把上/下内容分别递归布局。
			} else if (node.type === "script") {
				// 上标存在才递归，undefined保持没有上半块。
				const upper = node.upper === undefined ? undefined : renderLayout(node.upper, nodes);
				// 下标存在才递归，同一共享节点表可被嵌套使用。
				const lower = node.lower === undefined ? undefined : renderLayout(node.lower, nodes);
				// 脚标块宽取上/下较大值，缺块用0，?.和??处理可缺值。
				const width = Math.max(upper?.width ?? 0, lower?.width ?? 0);
				// 把上下标共同作为一个相邻布局加入。
				layouts.push({
					// 其行序是上标、空基线、下标，不含前面的主字符。
					lines: [
						// 上标各行向右补白到统一width，缺上标展开空数组。
						...(upper?.lines.map((line) => padLayoutLine(line, width)) ?? []),
						// 用全空格基线占位，令上下标分别位于主文字上/下。
						" ".repeat(width),
						// 下标各行同样补白，缺下标没有额外行。
						...(lower?.lines.map((line) => padLayoutLine(line, width)) ?? []),
					],
					// 保存上/下较大宽度。
					width,
					// 上标总行数就是空基线的位置，无上标为0。
					baseline: upper?.lines.length ?? 0,
				});
				// 联合类型剩余matrix节点，直接采用预先排好的行。
			} else {
				// 测各行最大显示宽，0保证空数组也有有限下界。
				const width = Math.max(0, ...node.lines.map((line) => visibleWidth(line)));
				// 加入预制矩阵/分段函数布局。
				layouts.push({
					// 每行补到相同宽度，不改变原node.lines。
					lines: node.lines.map((line) => padLayoutLine(line, width)),
					// 保存整块宽度。
					width,
					// 基线直接采用节点声明，不在此验证是否落行内。
					baseline: node.baseline,
				});
			}
			// 消费到当前有效节点引用末尾，匹配长度按UTF-16计。
			position = index + match[0].length;
			// 保存此节点类型，影响下一个文本切片间距。
			previousNode = node;
		}
		// 最后有效引用后若仍有文字，需要补一个文本子布局。
		if (position < sourceLine.length) {
			// 取本行尚未消费尾串。
			const sliced = sourceLine.slice(position);
			// 有前节点才去尾串起始空白，否则整串保留。
			const trimmed = previousNode ? sliced.trimStart() : sliced;
			// 紧跟矩阵且原串以空白起头时恢复一个间隔。
			const text = previousNode?.type === "matrix" && /^\s/.test(sliced) ? ` ${trimmed}` : trimmed;
			// 尾串按一行、基线0、实测列宽存布局。
			layouts.push({ lines: [text], width: visibleWidth(text), baseline: 0 });
		}
		// 按基线把本源码行全部子布局横向合成。
		const lineLayout = joinLayouts(layouts);
		// 这是第一批实际输出行时保存其基线。
		if (renderedLines.length === 0) {
			// 后续显式LF行不会覆盖整块返回基线。
			firstBaseline = lineLayout.baseline;
		}
		// 展开并纵向追加该行产生的所有二维行。
		renderedLines.push(...lineLayout.lines);
	}
	// 返回本次完整布局。
	return {
		// 行数组供renderLatex最终裁公用缩进。
		lines: renderedLines,
		// 结果宽按真实行最大列宽重新测，不直接用各源码行预算。
		width: Math.max(0, ...renderedLines.map((line) => visibleWidth(line))),
		// 采用首源码行的合成基线。
		baseline: firstBaseline,
	};
}

// 有状态的有限语法递归解析器，position推进UTF-16位置，supported记录无法支持的语法；不执行TeX宏、代码或数学计算。
class LatexParser {
	// readonly禁止重绑source字段，字符串本身不可变；不自动验证语法。
	private readonly source: string;
	// 共享布局节点数组引用不可重绑，但仍可push节点/修改节点内容，readonly不是深冻结。
	private readonly layoutNodes: LayoutNode[];
	// 构造指定是否采用显示式布局，不由普通displaystyle命令动态切换。
	private readonly display: boolean;
	// 当前源码读取码元位置，从0开始。
	private position = 0;
	// 遇不支持/缺闭合时改false，render最后返回undefined，而不是立即抛自定义语法异常。
	private supported = true;
	// 当前参数是否允许堆叠分数的局部状态，读嵌套参数可临时收窄。
	private stackFractions = true;
	// 当前脚标解析嵌套深度，影响display脚标布局选择，不是安全深度限额。
	private scriptDepth = 0;

	// 构造只保存源码、共享节点表和display选项，不开始分词或渲染；例：嵌套解析器和父级共享节点编号，之后render才推进位置。
	constructor(source: string, layoutNodes: LayoutNode[], display: boolean) {
		// 保存这层源码字符串。
		this.source = source;
		// 保存节点表原引用，子解析器push的节点父级后续也可查。
		this.layoutNodes = layoutNodes;
		// 保存本层显示模式，可能由renderNested为矩阵格禁用。
		this.display = display;
	}

	// 从当前位置解析整串并规范输出，返回中间串或undefined；例：未知命令把supported置false，公共入口便可让Markdown回退原公式。
	// 会推进position/追加布局节点，不是可重复无状态解析；没有统一catch将栈溢出/分配等所有异常都转undefined。
	render(): string | undefined {
		// 解析序列到源码末尾，可能已构造二维占位节点。
		const rendered = this.parseSequence();
		// 支持标记为false或没有完整消费源码就拒绝整次结果。
		if (!this.supported || this.position !== this.source.length) {
			// 外层据此保留原始公式，而非展示半串局部结果。
			return undefined;
		}
		// 成功才收具名操作符标记和普通空白，布局引用仍留给后续排版。
		return normalizeOutput(rendered);
	}

	// 解析普通序列，可带预期结束字符，返回局部中间串并推进位置/节点表；依次处理分组、命令、脚标、空白、关系和普通字符。
	// 例：{x^2}进入子序列，匹配}后消费闭括号；缺闭括号或多出}标不支持。不验证完整TeX语法或数学正确性，也无递归深度上限。
	private parseSequence(endCharacter?: string): string {
		// 当前序列结果从空串开始。
		let result = "";
		// 还有码元可读就继续，同一状态字段由各子解析步骤推进。
		while (this.position < this.source.length) {
			// 读当前位置一个UTF-16码元，不是完整字素。
			const character = this.source[this.position];
			// 本层确有预期闭符且当前字符相同，就结束此组。
			if (endCharacter && character === endCharacter) {
				// 先消费闭符，父调用继续读其后内容。
				this.position++;
				// 返回本组结果，不把语法花括号画出来。
				return result;
			}

			// 不匹配预期结束的孤立右花括号属于无法处理结构。
			if (character === "}") {
				// 标整串最终不支持，不把这个右括号当普通正文。
				this.supported = false;
				// 返回已积累局部结果，最外render仍会拒绝。
				return result;
			}

			// 遇左花括号开始分组。
			if (character === "{") {
				// 越过开括号。
				this.position++;
				// 递归读到对应右花括号，内部结果拼到当前序列。
				result += this.parseSequence("}");
				// 递归已推进位置，不再把开括号按普通字符追加。
				continue;
			}

			// 反斜杠进入命令解析。
			if (character === "\\") {
				// parseCommand可能返回可见文本、布局占位或负间距哨兵。
				const command = this.parseCommand();
				// 负间距只在序列层有特别含义。
				if (command === NEGATIVE_SPACE) {
					// 删当前结果尾空白，近似表现紧凑连接，不移动真实终端光标。
					result = result.trimEnd();
					// 若末尾是具名运算符结束标记，它会在normalize阶段补空格，需要同时去掉。
					if (result.endsWith(NAMED_OPERATOR_END)) {
						// 删除这个结束哨兵，避免后续又恢复右间距。
						result = result.slice(0, -NAMED_OPERATOR_END.length);
					}
					// 普通命令返回值直接拼接。
				} else {
					// 追加文字/占位，不在这里展开节点图。
					result += command;
				}
				// 命令已负责消费源码，跳过普通字符推进。
				continue;
			}

			// 上/下标语法由^或_开始，不要求当前已存在一个合法数学底数。
			if (character === "^" || character === "_") {
				// 先消费脚标符号。
				this.position++;
				// 脚标要贴近前面的底数，去结果尾普通空白。
				result = result.trimEnd();
				// 解析必需脚标参数及可能紧接的另一类脚标。
				const script = this.parseScripts(character);
				// 底数若是具名运算符，脚标必须移到其结束标记前。
				if (result.endsWith(NAMED_OPERATOR_END)) {
					// 去旧结束哨兵、插脚标、再补结束哨兵，让后处理间距跟在整个带脚标运算符后。
					result = `${result.slice(0, -NAMED_OPERATOR_END.length)}${script}${NAMED_OPERATOR_END}`;
					// 底数不是具名标记时普通拼接。
				} else {
					// 追加脚标Unicode/ASCII回退/二维引用。
					result += script;
				}
				// 脚标解析已推进位置，继续下一轮。
				continue;
			}

			// 其他Unicode空白交统一消费逻辑。
			if (/\s/.test(character)) {
				// 连续源码空白折为一个普通空格，物理换行通常不直接保留。
				result += this.parseWhitespace();
				// parseWhitespace已消费整段，不再额外position++。
				continue;
			}

			// 普通=、<、>作为关系符号规范间隔。
			if (character === "=" || character === "<" || character === ">") {
				// 先去结果尾空白，再拼空格/关系/空格。
				result = `${result.trimEnd()} ${character} `;
				// 消费本关系符号码元。
				this.position++;
				// 避免落入普通字符再追加一次。
				continue;
			}

			// 普通&作为对齐分隔提示被直接消费，不显示；环境分支另外按&拆格。
			if (character === "&") {
				// 推进一个码元。
				this.position++;
				// 不把&留在可见公式里。
				continue;
			}

			// 普通~在此简化成空格，不保TeX不可断行语义。
			if (character === "~") {
				// 消费波浪号。
				this.position++;
				// 追加普通空格，稍后可能与相邻空白合并。
				result += " ";
				// 继续下一字符。
				continue;
			}

			// 句点若紧接预制矩阵/分段节点，要附在它最后一行。
			if (character === ".") {
				// 仅检查当前结果末尾是否为数字布局引用。
				const marker = TRAILING_LAYOUT_MARKER_PATTERN.exec(result);
				// 有引用才从节点表取目标，否则undefined。
				const node = marker ? this.layoutNodes[Number(marker[1])] : undefined;
				// 只有matrix标签使用句点归末行规则，分数/运算符等仍普通追加。
				if (node?.type === "matrix") {
					// 定位预制行数组末下标。
					const lastLine = node.lines.length - 1;
					// 原地把句点附在该行，缺行值回退空串；改变的是共享节点对象。
					node.lines[lastLine] = `${node.lines[lastLine] ?? ""}${character}`;
					// 消费源码句点。
					this.position++;
					// 不把句点同时追加在中间串的基线旁。
					continue;
				}
			}

			// 其余普通码元直接保留，可包含未做专门排版的Unicode文字。
			result += character;
			// 向前推进一码元；代理对两半通常会按原顺序拼回，参数专门读取仍有独立边界。
			this.position++;
		}

		// 源码耗尽而本层还期待闭符，说明分组未闭合。
		if (endCharacter) {
			// 标记整层不支持，外部render最终undefined。
			this.supported = false;
		}
		// 返回局部串，是否可公开使用由render统一检查。
		return result;
	}

	// 读取普通^/_脚标，返回Unicode/ASCII回退或二维引用，推进position、临时深度并可能追加节点；最多连读紧随的相反脚标，保留输入顺序。
	// 例：x_i^2一般得xᵢ²，display遇不适合直接Unicode的某些上/下标可建script布局；选择基于字符启发式，不是所有display脚标都竖排。
	private parseScripts(initialMarker: "^" | "_"): string {
		// 可选字段分别保存下/上参数，中间串可能含节点引用。
		const scripts: { sub?: string; sup?: string } = {};
		// 保存实际解析顺序，联合字符串数组只在编译期限制标签。
		const order: Array<"sub" | "sup"> = [];
		// 局部解析回调接^/_、返回void；增加深度后读一个禁止堆叠分数的参数，finally恢复深度，成功再记顺序，例：嵌套脚标能观察当前深度。
		const parse = (marker: "^" | "_"): void => {
			// _映射sub，^映射sup，稍后作为对象键。
			const kind = marker === "_" ? "sub" : "sup";
			// 先增加脚标深度，参数内再遇脚标时可知处于嵌套环境。
			this.scriptDepth++;
			// try/finally保证参数读取抛错时深度也减回；不表示错误被catch吞掉。
			try {
				// 解析一个必需参数，false禁止这一参数内部堆叠分数；共享this.display本身未在这里改。
				scripts[kind] = this.parseRequiredArgument(false);
				// 无论成功/抛错都会进入finally。
			} finally {
				// 恢复深度，不留下错误的嵌套计数。
				this.scriptDepth--;
			}
			// 仅在参数读取正常返回后保存该类别的先后顺序。
			order.push(kind);
		};

		// 先消费调用方已经看到的初始脚标类别。
		parse(initialMarker);
		// 用临时位置向前看，不马上吞掉后续普通空白。
		let nextPosition = this.position;
		// 试探跳过全部Unicode空白，包含物理LF。
		while (nextPosition < this.source.length && /\s/.test(this.source[nextPosition] ?? "")) {
			// 只推进探测位置。
			nextPosition++;
		}
		// 取跳空白后的潜在第二脚标符。
		const nextMarker = this.source[nextPosition];
		// 它必须是另一类^/_，同类不会在本次配对里读取；后续主序列仍可能继续解析。
		if ((nextMarker === "^" || nextMarker === "_") && nextMarker !== initialMarker) {
			// 采用探测位置并消费第二符号，之前跳过的空白也一起消费。
			this.position = nextPosition + 1;
			// 用同一回调读取第二脚标参数。
			parse(nextMarker);
		}

		// 下标存在才尝试整串Unicode映射，不存在保持undefined。
		const subUnicode = scripts.sub === undefined ? undefined : formatUnicodeScript(scripts.sub, "sub");
		// 上标也单独尝试映射。
		const supUnicode = scripts.sup === undefined ? undefined : formatUnicodeScript(scripts.sup, "sup");
		// some找任一不适合布局的参数，整体取反得到canUseLayout，不是验证数学有效性。
		const canUseLayout = ![scripts.sub, scripts.sup].some(
			// 回调逐个看sub/sup两个可缺值。
			(value) =>
				// 只对实际存在参数做后续字符判据。
				value !== undefined &&
				// 参数含斜杠时拒绝这套二维脚标路径，通常让脚标分数保持线性。
				(value.includes("/") ||
					// 没有现成布局标记、码点超过1且不含大写/两种星号时也拒绝；/test未锚定，只要含一个允许特征即可改变此启发式。
					(!value.includes(LAYOUT_MARKER_START) && Array.from(value).length > 1 && !/[A-Z*∗]/.test(value))),
		);
		// 下面多条件合起来决定是否建立script节点。
		const needsLayout =
			// 首先必须本层display开启。
			this.display &&
			// 还必须通过刚才的canUseLayout启发式。
			canUseLayout &&
			// 并且处在外层脚标内部，或下面任一现存脚标无法完全Unicode映射。
			(this.scriptDepth > 0 ||
				// 已有下标但映射失败时需要考虑布局。
				(scripts.sub !== undefined && subUnicode === undefined) ||
				// 已有上标但映射失败时也考虑布局。
				(scripts.sup !== undefined && supUnicode === undefined));
		// 不需要/不允许二维时走一维返回。
		if (!needsLayout) {
			// 从实际脚标顺序开始链式生成文字。
			return (
				order
					// map为每个sub/sup项计算一段输出。
					.map((kind) =>
						// 当前类别为sub时选择下标结果。
						kind === "sub"
							? // 优先已算好的Unicode，下标缺字则formatScript决定_或_(...)回退，??保留有效空串。
								(subUnicode ?? formatScript(scripts.sub ?? "", kind))
							: // sup同理，使用上标Unicode或^回退。
								(supUnicode ?? formatScript(scripts.sup ?? "", kind)),
					)
					// 不加分隔空格直接拼所有脚标片段。
					.join("")
			);
		}

		// 二维路径创建节点，后面push返回长度再减1成为编号。
		const index =
			// 追加到共享布局节点数组，父级后续也可访问。
			this.layoutNodes.push({
				// type标签为script，包含上下部分但不包含底数主字。
				type: "script",
				// 下标存在才规范其中具名标记/普通空白，undefined保持缺省。
				lower: scripts.sub === undefined ? undefined : normalizeOutput(scripts.sub),
				// 上标同样规范，可能仍含嵌套布局引用。
				upper: scripts.sup === undefined ? undefined : normalizeOutput(scripts.sup),
				// push结果是新长度，减1得到零起始数组下标。
			}) - 1;
		// 返回私用开启符+十进制编号+闭符，占位串之后才由renderLayout展开。
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	// 消费当前位置起连续Unicode空白，返回一个普通空格并推进位置；例：源码换行缩进通常变一格，显式命令双反斜杠换行另处理。
	private parseWhitespace(): string {
		// 只在源码范围内且当前位置为空白时持续读。
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			// 每轮消费一个UTF-16码元。
			this.position++;
		}
		// 不区分原先空白数量/类别，统一一空格。
		return " ";
	}

	// 从反斜杠处读命令名并分派，返回中间文字/哨兵/节点引用，推进源码且可改supported/节点表；先扫字母名或单字符，再处理符号、运算符、分数根式、包装和环境。
	// 例：frac读两个参数，unknown标不支持让最外层回退；这是固定规则集，没有宏展开、包加载或外部执行，也不是完整TeX语法检查器。
	private parseCommand(): string {
		// 调用方当前指向反斜杠，先消费它。
		this.position++;
		// 反斜杠已是末字符就缺命令体。
		if (this.position >= this.source.length) {
			// 记录不支持/残缺。
			this.supported = false;
			// 本步返回空串，最外render稍后统一undefined。
			return "";
		}

		// 准备命令名局部字符串。
		let command = "";
		// 取反斜杠后首码元，缺值按空串。
		const first = this.source[this.position] ?? "";
		// 反斜杠直接接实际CR/LF是控制空格，不是普通命令名。
		if (first === "\n" || first === "\r") {
			// 消费这一个物理换行码元。
			this.position++;
			// 如果是CRLF二码元组合，还需消费后面的LF。
			if (first === "\r" && this.source[this.position] === "\n") {
				// 推进越过LF避免重复当一次空白。
				this.position++;
			}
			// 整个控制换行简化为空格。
			return " ";
		}
		// ASCII字母开头才扫描连续字母命令名，大小写不折叠。
		if (/[A-Za-z]/.test(first)) {
			// 记命令名首位置，不含反斜杠。
			const start = this.position;
			// 逐码元扫描A..Z/a..z，不把数字/星号自动并进命令名。
			while (this.position < this.source.length && /[A-Za-z]/.test(this.source[this.position] ?? "")) {
				// 继续推进命令名末位置。
				this.position++;
			}
			// 从原串取完整字母命令名，例：operatorname后*留给专门分支。
			command = this.source.slice(start, this.position);
			// 不是ASCII字母开头就按一个码元的控制符命令读。
		} else {
			// 该字符本身作为命令键，例：反斜杠逗号。
			command = first;
			// 消费这个单码元，未扩展为任意Unicode码点命令。
			this.position++;
		}

		// 反斜杠后又是反斜杠，即源码中的显式换行命令。
		if (command === "\\") {
			// 返回真实LF给中间输出，之后可用于多行布局。
			return "\n";
		}
		// 命令属于正间距集合时。
		if (SPACING_COMMANDS.has(command)) {
			// 统一一空格，不保TeX尺寸。
			return " ";
		}
		// 负间距集合另返回内部标记。
		if (NEGATIVE_SPACING_COMMANDS.has(command)) {
			// 主序列会用哨兵修剪结果尾空白，不发送终端退格。
			return NEGATIVE_SPACE;
		}
		// 旧字体切换命令只消费，不改变终端字体/ANSI状态。
		if (FONT_SWITCH_COMMANDS.has(command)) {
			// 还会跳掉紧跟的Unicode空白，包括源码换行。
			while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
				// 持续推进位置到下一非空白。
				this.position++;
			}
			// 字体命令本身不显示文字。
			return "";
		}
		// 一般样式忽略集合命中时。
		if (IGNORED_COMMANDS.has(command)) {
			// 返回空串，未切换display字段；运算符limits专门读取优先路径在parseOperator中。
			return "";
		}
		// 下面七个被反斜杠转义的普通符号可原样显示。
		if (
			// 转义左花括号不开始分组。
			command === "{" ||
			// 转义右花括号不结束分组。
			command === "}" ||
			// 转义美元显示美元，数学外层分隔由Markdown先处理。
			command === "$" ||
			// 转义百分号显示百分号，不开TeX注释。
			command === "%" ||
			// 转义井号显示井号。
			command === "#" ||
			// 转义下划线显示普通下划线，不读下标参数。
			command === "_" ||
			// 转义&显示字符本身，不被普通对齐分隔分支吞掉。
			command === "&"
		) {
			// 直接返回命令字符，前导反斜杠已消费。
			return command;
		}
		// 反斜杠单竖线是双竖线字形命令。
		if (command === "|") {
			// 返回‖，区别普通单竖线字符。
			return "‖";
		}
		// not要把接下来的一个参数否定，不做布尔求值。
		if (command === "not") {
			// 必需参数禁堆叠分数并去首尾空白。
			const value = this.parseRequiredArgument(false).trim();
			// 先查完整已解析参数对应的预组否定符号。
			const negated = NEGATED_SYMBOLS[value];
			// 有现成字形则优先采用，包括假如表值为空串也不会当缺失。
			if (negated !== undefined) {
				// 否定关系左右加空格，后处理再合并。
				return ` ${negated} `;
			}
			// 没有预组字形时按码点拆值，避免截断首代理对。
			const characters = Array.from(value);
			// 完全空参数没有可加否定斜线的字符。
			if (characters.length === 0) {
				// 标记不支持，最外层回退。
				this.supported = false;
				// 本步返回空串，不假造一个独立否定字形。
				return "";
			}
			// 给首码点附U+0338组合斜线，剩下码点原样拼回，再加左右空格；不是整串语义否定验证。
			return ` ${characters[0]}\u0338${characters.slice(1).join("")} `;
		}
		// 下限文字运算符先于普通符号/具名表匹配。
		if (LIMIT_OPERATORS.has(command)) {
			// 传命令原名、行内下限用方括号、默认允许display上下限、两侧普通空格。
			return this.parseOperator(command, "bracket", true, true);
		}

		// 再查固定字形表，Record不保证每个键都有值。
		const symbol = SYMBOLS[command];
		// 映射存在才处理为已知符号。
		if (symbol !== undefined) {
			// 求和/积分等还需读取紧随脚标。
			if (DISPLAY_LIMIT_SYMBOLS.has(command)) {
				// 传具体字形、行内脚标形式、默认允许竖排，spaced未传为false。
				return this.parseOperator(symbol, "script", true);
			}
			// cdot/times/关系集合在字形两侧补空格，其余直接返回；显示式上下限符号已在前面返回，不再经过这行。
			return command === "cdot" || command === "times" || RELATION_COMMANDS.has(command) ? ` ${symbol} ` : symbol;
		}
		// 普通具名运算符名命中时。
		if (NAMED_OPERATORS.has(command)) {
			// 用私用开始/结束哨兵包原命令名，间距稍后normalizeOutput决定。
			return `${NAMED_OPERATOR_START}${command}${NAMED_OPERATOR_END}`;
		}
		// big等尺寸命令不支持伸缩，只消费名字。
		if (SIZE_COMMANDS.has(command)) {
			// 不显示该尺寸命令文字，后面实际括号仍继续解析。
			return "";
		}
		// left/middle/right同样不创建自动伸缩定界符布局。
		if (command === "left" || command === "middle" || command === "right") {
			// 紧邻的.表示不可见定界符，需一起吞掉。
			if (this.source[this.position] === ".") {
				// 只消费这一紧邻句点，不跳空白去找更远的点。
				this.position++;
			}
			// 返回空串，正常的后续括号/命令将在下一轮解析。
			return "";
		}
		// 三个分数命令共用两参数读取策略。
		if (command === "frac" || command === "dfrac" || command === "tfrac") {
			// display且当前上下文允许堆叠且不是tfrac才竖排，dfrac在inline也不会强制改display。
			const shouldStack = this.display && this.stackFractions && command !== "tfrac";
			// 本层若要堆叠，分子内部传false保持嵌套分数线性；否则传true但仍受已有stackFractions状态限制。
			const numerator = this.parseRequiredArgument(!shouldStack);
			// 分母同样读取一个必需参数并采用嵌套策略。
			const denominator = this.parseRequiredArgument(!shouldStack);
			// 需要二维分数时存节点，不当场生成多行。
			if (shouldStack) {
				// 将push返回长度转换为节点下标。
				const index =
					// 加入共享布局表。
					this.layoutNodes.push({
						// fraction标签决定后面横线/分子/分母排法。
						type: "fraction",
						// 分子先清具名标记和普通空白，可能保留其他布局引用。
						numerator: normalizeOutput(numerator),
						// 分母同样规范。
						denominator: normalizeOutput(denominator),
						// 数组新长度减1得到引用ID。
					}) - 1;
				// 返回中间占位，最终布局按ID展开。
				return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
			}
			// 无需二维时生成a/b文本及必要括号。
			return formatFraction(numerator, denominator);
		}
		// sqrt根式支持可选方括号次数与一个必需参数。
		if (command === "sqrt") {
			// 方括号可缺，存在时先嵌套解析再trim；不是任意嵌套[]配对解析。
			const degree = this.parseOptionalArgument()?.trim();
			// 读被开方参数，不能缺省。
			const value = this.parseRequiredArgument();
			// 没有次数或次数恰为2使用普通根号。
			if (degree === undefined || degree === "2") {
				// 根据被开方串简单程度选择√x或√(...)。
				return formatRoot(value);
			}
			// 次数恰为3用现成三次根字形。
			if (degree === "3") {
				// 仍按同一被开方括号规则生成∛表达式。
				return formatRoot(value, "∛");
			}
			// 次数恰为4用现成四次根字形。
			if (degree === "4") {
				// 返回∜表达式，不求四次方根数值。
				return formatRoot(value, "∜");
			}
			// 其他次数用上标格式接普通根号，不建立真正可伸缩根号布局。
			return `${formatScript(degree, "sup")}${formatRoot(value)}`;
		}
		// boxed/fbox简化成文本方括号。
		if (command === "boxed" || command === "fbox") {
			// 读一个参数trim后包[]，不画二维矩形边框。
			return `[${this.parseRequiredArgument().trim()}]`;
		}
		// 三种二项式命令都简化成choose文字。
		if (command === "binom" || command === "dbinom" || command === "tbinom") {
			// 按从左到右求值读两个必需参数，拼(a choose b)，不计算组合数或竖排无横线分数。
			return `(${this.parseRequiredArgument()} choose ${this.parseRequiredArgument()})`;
		}
		// 从组合重音表查对应码点。
		const accent = ACCENTS[command];
		// 找到重音映射才读参数。
		if (accent !== undefined) {
			// 读一个必需参数，仍走有限数学解析，不直接读取任意原始TeX文本。
			const value = this.parseRequiredArgument();
			// 一个码点才附组合重音，多码点用command(value)回退；码点数不同于用户看到的字素数。
			return Array.from(value).length === 1 ? `${value}${accent}` : `${command}(${value})`;
		}
		// mathbb提供少量双线体映射，与普通移除字体包装路径不同。
		if (command === "mathbb") {
			// 读取参数已解析的内容。
			const value = this.parseRequiredArgument();
			// Array.from按码点映射，表缺项就保留原字符，最后连接，不要求整串均在黑板粗体表内。
			return Array.from(value, (character) => BLACKBOARD[character] ?? character).join("");
		}
		// 自定义具名运算符支持紧邻*后附上下限。
		if (command === "operatorname") {
			// 只看当前紧邻一字符是否*，不跳空白找星号。
			const starred = this.source[this.position] === "*";
			// 有星号才消费。
			if (starred) {
				// 前进一位置，参数读取从其后开始。
				this.position++;
			}
			// 读运算符名参数、规范标记/空白并trim。
			const operator = normalizeOutput(this.parseRequiredArgument()).trim();
			// 行内下限用方括号，starred决定默认display上下限，spaced=true加左右空白；后续limits也可覆盖偏好。
			return this.parseOperator(operator, "bracket", starred, true);
		}
		// mod和bmod都用同一可读文字，不执行取模。
		if (command === "mod" || command === "bmod") {
			// 返回两边带空格的mod。
			return " mod ";
		}
		// pmod/pod还要读取一个模数/说明参数。
		if (command === "pmod" || command === "pod") {
			// 读参数并trim。
			const value = this.parseRequiredArgument().trim();
			// pmod包成(mod value)，pod只包(value)，前面都补一个空格。
			return command === "pmod" ? ` (mod ${value})` : ` (${value})`;
		}
		// overset/stackrel此处用上标文字近似，不创建真正覆盖主符号的特殊二维节点。
		if (command === "overset" || command === "stackrel") {
			// 第一参数是放在上方的文字。
			const upper = this.parseRequiredArgument();
			// 第二参数是主体，去边缘空白。
			const value = this.parseRequiredArgument().trim();
			// 主体后接formatScript上标结果，不改变display状态。
			return `${value}${formatScript(upper, "sup")}`;
		}
		// underset用下标文字近似。
		if (command === "underset") {
			// 先读下方说明。
			const lower = this.parseRequiredArgument();
			// 再读并trim主体。
			const value = this.parseRequiredArgument().trim();
			// 主体后接下标Unicode/ASCII回退。
			return `${value}${formatScript(lower, "sub")}`;
		}
		// 普通包装集合移除外壳，不实现其字体/伸缩含义。
		if (PLAIN_WRAPPERS.has(command)) {
			// 读取必需参数，内部命令仍会被解析。
			const value = this.parseRequiredArgument();
			// text前缀或mbox暂保参数边缘空白，其他包装trim，最外normalize仍会做整体空白规范。
			return command.startsWith("text") || command === "mbox" ? value : value.trim();
		}
		// begin标志进入环境解析。
		if (command === "begin") {
			// 读环境名/找到同名end并根据支持类型处理正文。
			return this.parseEnvironment();
		}
		// 独立end不应在普通命令层出现，环境闭符由parseEnvironment统一消费。
		if (command === "end") {
			// 因此标记整串不支持。
			this.supported = false;
			// 本局部命令不输出文字。
			return "";
		}

		// 所有已知分支都未命中即为未知命令。
		this.supported = false;
		// 局部保留反斜杠命令名，但render因supported=false最终返回undefined，不把它当成功解析返回用户。
		return `\\${command}`;
	}

	// 读取运算符紧随的limits/nolimits及上下标，返回行内文字或二维operator引用，推进源码并可能标不支持/追加节点。
	// 例：display的sum可上下排i=0和n，nolimits使其回到旁置脚标；重复下/上标标不支持，显示策略只近似固定规则，不求运算结果。
	private parseOperator(
		// 已解析主符号/运算符名。
		operator: string,
		// 行内下标用bracket方括号还是script形式的字面量联合。
		inlineLowerStyle: "bracket" | "script",
		// 本命令默认是否允许display上下限。
		displayLimits: boolean,
		// 默认不在整段两侧加空格，文字极限类调用者会传true。
		spaced = false,
		// 返回中间串，可含新operator节点引用。
	): string {
		// 局部偏好可被后续limits/nolimits覆盖，不改this.display本身。
		let useDisplayLimits = displayLimits;
		// 用临时位置向前探测修饰命令。
		let modifierPosition = this.position;
		// 只越过ASCII空格/Tab，不跨LF找limits。
		while (modifierPosition < this.source.length && /[ \t]/.test(this.source[modifierPosition] ?? "")) {
			// 移动探测指针，不立刻消费实际源码位置。
			modifierPosition++;
		}
		// 当前位置必须以limits/nolimits命令开头且后不接字母，避免误吃较长命令前缀。
		const modifier = /^\\(limits|nolimits)(?![A-Za-z])/.exec(this.source.slice(modifierPosition));
		// 确实命中才采用修饰。
		if (modifier) {
			// limits设true，nolimits设false。
			useDisplayLimits = modifier[1] === "limits";
			// 实际位置移到整个修饰命令末尾，前面探测越过的空白一并消费。
			this.position = modifierPosition + modifier[0].length;
		}

		// 可选下限值，undefined与空串区分有没有脚标。
		let lower: string | undefined;
		// 可选上限值。
		let upper: string | undefined;
		// 循环读取紧接脚标，遇非脚标停止，不无限扫描无关正文。
		while (true) {
			// 以临时指针探下一脚标位置。
			let scriptPosition = this.position;
			// 仅跳空格/Tab，不跨物理换行。
			while (scriptPosition < this.source.length && /[ \t]/.test(this.source[scriptPosition] ?? "")) {
				// 继续探测，不立即改this.position。
				scriptPosition++;
			}
			// 读潜在_或^码元。
			const kind = this.source[scriptPosition];
			// 两个符号都不是时，本运算符脚标完成。
			if (kind !== "_" && kind !== "^") {
				// 跳出循环，未采纳的探测空白留给主序列处理。
				break;
			}
			// 采纳探测位置并消费脚标符号。
			this.position = scriptPosition + 1;
			// 读禁堆叠分数的参数，normalize后删掉全部普通空格使条件紧凑；不是数学等价化简。
			const value = normalizeOutput(this.parseRequiredArgument(false)).replaceAll(" ", "");
			// _对应下限。
			if (kind === "_") {
				// 如果已经读过下限，重复声明不被支持。
				if (lower !== undefined) {
					// 标最终拒绝，但仍继续记录/推进以完成局部流程。
					this.supported = false;
				}
				// 保存本次下限，重复时覆盖局部值不代表整串成功。
				lower = value;
				// 其余已知脚标符只能为^。
			} else {
				// 同理检查重复上限。
				if (upper !== undefined) {
					// 有重复上限就标不支持。
					this.supported = false;
				}
				// 保存本次上限文本。
				upper = value;
			}
		}

		// 仅display开启、当前偏好允许且至少一个上下限存在时建立二维节点。
		if (this.display && useDisplayLimits && (lower !== undefined || upper !== undefined)) {
			// 共享节点表存operator标签/主符号/上下限，push新长度减1为ID。
			const index = this.layoutNodes.push({ type: "operator", operator, lower, upper }) - 1;
			// 返回节点占位，不在这一步纵向拼实际行。
			return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
		}

		// 否则行内结果从主运算符开始。
		let rendered = operator;
		// 下限存在则添加，即使内容为空串。
		if (lower !== undefined) {
			// bracket路径包[lower]，script路径采用Unicode下标或_回退。
			rendered += inlineLowerStyle === "bracket" ? `[${lower}]` : formatScript(lower, "sub");
		}
		// 上限存在则接上标。
		if (upper !== undefined) {
			// Unicode或^形式由formatScript决定。
			rendered += formatScript(upper, "sup");
		}
		// spaced=true包两侧空格，否则原样返回；此开关仅影响一维返回路径，二维节点有自己的间距。
		return spaced ? ` ${rendered} ` : rendered;
	}

	// 读取一个必需参数并临时限制堆叠分数，返回中间串、推进源码/节点；例：外层二维frac的参数传false使内部frac保持a/b。
	// 先保存旧策略，采用“旧允许且本次允许”，成功后恢复；这里没有finally，意外抛错时不保证策略恢复，不把正常语法不支持与异常混为一谈。
	private parseRequiredArgument(stackFractions = true): string {
		// 保存进入参数前的堆叠策略。
		const previousStackFractions = this.stackFractions;
		// 本次false能关闭，true不能把外层已经关闭的策略重新打开。
		this.stackFractions = previousStackFractions && stackFractions;
		// 实际读组/命令/单码元参数，可能标supported=false但正常返回字符串。
		const value = this.parseRequiredArgumentValue();
		// 正常返回后恢复旧策略，接下来其他参数不永久受这次限制。
		this.stackFractions = previousStackFractions;
		// 返回读到的中间文字，不在此做normalizeOutput。
		return value;
	}

	// 从当前位置读一项必需参数，返回string并推进位置；跳空白后，花括号递归读组、反斜杠读一命令、其他仅读一个UTF-16码元。
	// 例：frac12依次读1与2，frac{ab}{c}可读多字母；未包组的补充平面字符可能只取一半代理码元，不能称为完整任意Unicode字素参数解析。
	private parseRequiredArgumentValue(): string {
		// 先消费所有Unicode空白，包括LF，因此参数可在下一物理行。
		while (this.position < this.source.length && /\s/.test(this.source[this.position] ?? "")) {
			// 推进到首非空白码元。
			this.position++;
		}
		// 到源码末尾仍没参数即残缺。
		if (this.position >= this.source.length) {
			// 标整次不支持。
			this.supported = false;
			// 本步返回空串，最外render回退undefined。
			return "";
		}
		// 花括号允许包住多字符/嵌套命令参数。
		if (this.source[this.position] === "{") {
			// 先消费开花括号。
			this.position++;
			// 子序列读到并消费右花括号，返回内部中间串。
			return this.parseSequence("}");
		}
		// 反斜杠开头参数作为一个命令及其专属参数读取。
		if (this.source[this.position] === "\\") {
			// 命令本身负责推进位置，不在此再额外加一。
			return this.parseCommand();
		}
		// 普通参数仅当前一个码元，未按码点/字素分段。
		const value = this.source[this.position] ?? "";
		// 消费这一码元。
		this.position++;
		// 直接返回该字符串。
		return value;
	}

	// 读取可选[...]参数，返回嵌套解析串或undefined并推进位置；例：sqrt[3]读次数3，未出现[只表示没次数，出现[却无]则标不支持。
	// 仅寻找后面第一个]，不处理任意嵌套方括号或转义闭符配对；前面的空格/Tab会被消费，LF不会在此跳过。
	private parseOptionalArgument(): string | undefined {
		// 仅跳普通空格/Tab。
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			// 真实position随之推进，即便稍后没有[也保留该消费。
			this.position++;
		}
		// 当前位置不是[就没有这个可选参数。
		if (this.source[this.position] !== "[") {
			// 返回undefined不标错误，调用方用默认次数。
			return undefined;
		}
		// indexOf找首次右方括号，不递归匹配嵌套层数。
		const end = this.source.indexOf("]", this.position + 1);
		// 找不到闭符才是残缺参数。
		if (end < 0) {
			// 标最外层最终不能成功。
			this.supported = false;
			// 仍返回undefined，但与缺省区别由supported字段保存。
			return undefined;
		}
		// 取不含方括号的原参数内容。
		const value = this.source.slice(this.position + 1, end);
		// 消费到闭括号之后。
		this.position = end + 1;
		// 用子解析器处理内容，共享节点表/支持状态传播规则。
		return this.renderNested(value);
	}

	// 读取原始花括号组（用于环境名），返回内部原串或undefined并推进位置；计数嵌套{}/跳过反斜杠及后一字符，不执行内部数学命令。
	// 例：begin{matrix}得到matrix；缺开/闭括号会标不支持，空组返回空串本身不在此另标错误，调用方随后用真值处理。
	private readRawGroup(): string | undefined {
		// 只跳前导ASCII空格/Tab，不跨LF寻找开括号。
		while (this.position < this.source.length && /[ \t]/.test(this.source[this.position] ?? "")) {
			// 消费这些普通空白。
			this.position++;
		}
		// 当前位置必须是左花括号。
		if (this.source[this.position] !== "{") {
			// 不满足必需组结构就标不支持。
			this.supported = false;
			// 返回undefined，不继续乱找后面的别组。
			return undefined;
		}

		// 前置++先跳开括号，再保存内容起点。
		const start = ++this.position;
		// 当前尚有一层未闭花括号。
		let depth = 1;
		// 逐码元扫描直到配平或源码末尾。
		while (this.position < this.source.length) {
			// 读当前位置字符。
			const character = this.source[this.position];
			// 反斜杠表示跳过它和后一字符，防止转义括号改变depth。
			if (character === "\\") {
				// 一次加2，未在此区分多字母命令/码点结构。
				this.position += 2;
				// 跳过这一对后重看循环，不做括号计数。
				continue;
			}
			// 普通左括号使未闭深度加1。
			if (character === "{") depth++;
			// 普通右括号使深度减1。
			if (character === "}") depth--;
			// 回到0说明当前组的闭括号找到了。
			if (depth === 0) {
				// 取内容起点至闭符前，保留内部原拼写，不调用normalize。
				const value = this.source.slice(start, this.position);
				// 消费闭括号。
				this.position++;
				// 返回原组内容，包括其中反斜杠文字。
				return value;
			}
			// 不是结束就继续扫下一码元。
			this.position++;
		}
		// 源码耗尽仍未配平则标残缺。
		this.supported = false;
		// 返回undefined表示无法读完整组。
		return undefined;
	}

	// 按双反斜杠分环境行，返回数组无状态修改；例：后跟[4pt]行距会一起去掉，不执行真实排版尺寸计算。
	private splitEnvironmentRows(body: string): string[] {
		// 正则还可消费一个不含LF/闭方括号的[...]，未按嵌套组或转义语法保护行分隔，因此不是完整环境词法器。
		return body.split(/\\\\(?:\[[^\]\n]*\])?/);
	}

	// 读取begin后的环境名及其正文，推进到同名end之后，再按支持的equation/aligned/cases/matrix规则返回中间串。
	// 例：matrix用双反斜杠分行、&分列；结束查找是首次字面同名end，不计同名环境嵌套/转义，未知环境标不支持，布局可能修改共享节点表。
	private parseEnvironment(): string {
		// 从必需原花括号组读环境名，不trim名字。
		const environment = this.readRawGroup();
		// undefined或空串环境名均在此提前结束。
		if (!environment) {
			// 返回空串；空组本身没在readRawGroup标不支持，不把所有空名情形说成必然undefined。
			return "";
		}
		// 构造精确反斜杠end加同名花括号闭标记，大小写/空白须原样一致。
		const endMarker = `\\end{${environment}}`;
		// 从当前位置找首次字面结束标记，不维护同名环境栈。
		const end = this.source.indexOf(endMarker, this.position);
		// 找不到则环境残缺。
		if (end < 0) {
			// 标整体不支持。
			this.supported = false;
			// 本步返回空串。
			return "";
		}
		// 取begin名之后到end之前的正文原串。
		const body = this.source.slice(this.position, end);
		// 父解析位置直接移到end标记之后，正文稍后由子解析器独立读。
		this.position = end + endMarker.length;

		// 这三种显示公式外壳只递归处理正文，不因名称就强制this.display=true。
		if (environment === "equation" || environment === "equation*" || environment === "displaymath") {
			// 嵌套解析后去正文边缘空白。
			return this.renderNested(body).trim();
		}

		// 下列对齐/多行环境共同采用文本行展开近似，不生成完整TeX对齐表。
		if (
			// aligned接受为多行公式环境。
			environment === "aligned" ||
			// align同样受支持。
			environment === "align" ||
			// align*同样处理，星号不额外关闭本模块不存在的编号系统。
			environment === "align*" ||
			// alignedat稍后额外读取/去掉列对数参数外壳。
			environment === "alignedat" ||
			// alignat也按列对合并。
			environment === "alignat" ||
			// alignat*使用同一策略。
			environment === "alignat*" ||
			// gather接受为多行文本近似。
			environment === "gather" ||
			// gathered使用同一行展开流程。
			environment === "gathered" ||
			// multline不在此实现专门首左末右对齐。
			environment === "multline" ||
			// multline*也不生成完整多行对齐布局。
			environment === "multline*" ||
			// split同样拆行后递归解析。
			environment === "split"
		) {
			// 这三个at环境需要按相邻两格归一对处理。
			const alignedAt = ["alignedat", "alignat", "alignat*"].includes(environment);
			// at类型去开头首个花括号列对数说明，简单正则读到首个}，不验证数值/嵌套；其他环境保原正文。
			const alignedBody = alignedAt ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			// 先按双反斜杠行分隔拆正文，后面链式转换。
			return (
				this.splitEnvironmentRows(alignedBody)
					// 每行回调返回该行已解析/trim后的文字。
					.map((row) => {
						// 直接按&分格，未绕开转义&或嵌套环境中的&。
						const cells = row.split("&");
						// at类型要成对合并，普通对齐类型直接合全部格。
						const source = alignedAt
							? // 对格数除2向上取整，Array.from为每一对索引执行回调，不读取/验证源码声明的列对数。
								Array.from(
									{ length: Math.ceil(cells.length / 2) },
									(_, index) =>
										// 把相邻两格无分隔连接成一对，最后不足两格也按已有部分连接。
										cells
											.slice(index * 2, index * 2 + 2)
											.join(""),
									// 各对之间保一个普通空格。
								).join(" ")
							: // 非at环境删所有&分隔，直接接各格文字。
								cells.join("");
						// 对合成行递归有限语法并trim，不画对齐竖线。
						return this.renderNested(source).trim();
					})
					// 去掉渲染后空行，Boolean作为真值过滤函数。
					.filter(Boolean)
					// 剩余行用真实LF连接。
					.join("\n")
			);
		}

		// cases及cases*交分段函数专门排版。
		if (environment === "cases" || environment === "cases*") {
			// 从正文首两格读值与条件，可能创建复用matrix标签的布局节点。
			return this.renderCases(body);
		}

		// 下面一组环境当作矩阵/数组表格处理。
		if (
			// 包括无外括号的array/matrix/smallmatrix，以及圆/方/花/单竖/双竖括号五种类型。
			["array", "matrix", "smallmatrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix"].includes(environment)
		) {
			// array简单去掉开头花括号列说明，如{cc}；不执行l/c/r对齐或竖线语法，其余正文原样。
			const matrixBody = environment === "array" ? body.replace(/^\s*\{[^}]*\}/, "") : body;
			// 根据环境名选择矩阵定界符并排宽。
			return this.renderMatrix(environment, matrixBody);
		}

		// 以上都不识别的环境标不支持。
		this.supported = false;
		// 局部返回原正文供流程继续，但外层render看到false仍undefined。
		return body;
	}

	// 排cases正文，返回单行文字或多行节点引用，修改共享节点表；拆行/列并以首格为值、第二格为条件，按值最大宽补齐后加左大括弧。
	// 例：两条分支会额外插一条中间括弧行与主表达式对齐；不是实际判断条件/执行分支，第三格及以后不作为可见条件输出。
	private renderCases(body: string): string {
		// 先拆环境物理公式行。
		const rows = this.splitEnvironmentRows(body)
			// 每行直接按&拆格，每格用renderNested(false)关显示布局后trim，分数在格内线性化。
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			// 只保至少一个非空格内容的行，原空行不保。
			.filter((row) => row.some(Boolean));
		// 首格去末逗号及其后空白后测最大值宽，0使空表也可算宽度。
		const valueWidth = Math.max(0, ...rows.map((row) => visibleWidth((row[0] ?? "").replace(/,\s*$/, ""))));
		// map把每个原格数组变成对齐后的可见分支内容。
		const contents = rows.map((row) => {
			// 值只取第0格并去末逗号，避免值和自动if间多一个标点。
			const value = (row[0] ?? "").replace(/,\s*$/, "");
			// 条件只取第1格，缺省空串。
			const condition = row[1] ?? "";
			// 无条件文本就只显示值。
			if (!condition) {
				// 直接返回值，不画占位if。
				return value;
			}
			// 条件若已以if/when/for/otherwise词边界开头（不分大小写），只加空格；否则补" if "，不分析条件语义。
			const conditionPrefix = /^(?:if|when|for|otherwise)\b/i.test(condition) ? " " : " if ";
			// 值后用保护空格补到统一列宽，再接条件前缀/条件，后续normalize不会吞这些对齐位。
			return `${value}${PROTECTED_SPACE.repeat(valueWidth - visibleWidth(value))}${conditionPrefix}${condition}`;
		});
		// 0/1条分支不需要建多行节点。
		if (contents.length <= 1) {
			// 空分支返回空串，一条只加左上花括弧字形和空格，不画完整单行大括号对。
			return contents.length === 0 ? "" : `⎧ ${contents[0]}`;
		}

		// 取分支条数一半向下取整作基线中心行号。
		const middle = Math.floor(contents.length / 2);
		// 复制内容数组，元素联合undefined便于插“仅括弧的中间行”，不是丢失分支。
		const visualRows: Array<string | undefined> = [...contents];
		// 偶数分支需要额外中线才能让上下内容围着基线对称。
		if (contents.length % 2 === 0) {
			// 在中间插undefined表示这一行只画中括弧，不含公式分支。
			visualRows.splice(middle, 0, undefined);
		}
		// 逐行创建带大括弧的预制文字行。
		const lines = visualRows.map((content, index) => {
			// 首行用上花括弧、末行用下花括弧，其余都用中花括弧字形。
			const delimiter = index === 0 ? "⎧" : index === visualRows.length - 1 ? "⎩" : "⎨";
			// undefined占位只返回括弧，其余括弧+空格+分支正文。
			return content === undefined ? delimiter : `${delimiter} ${content}`;
		});
		// 复用matrix节点形状存预制行，baseline=middle与旁边主式对齐。
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: middle }) - 1;
		// 返回该节点的数字私用占位。
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	// 排矩阵/array正文，输入环境名/正文、返回单行串或多行引用；拆行列、测各列最大宽、左对齐补保护空格、按环境加定界符。
	// 例：pmatrix两行用上/下圆括弧字形；多行基线固定首行，不是居中矩阵基线。列分隔统一" │ "，不执行array列说明或任意嵌套TeX表格规则。
	private renderMatrix(environment: string, body: string): string {
		// 先按环境换行分割。
		const matrix = this.splitEnvironmentRows(body)
			// 每行按&分列、每格用禁display子解析并trim，格内分数保持线性，不创建独立格宽约束。
			.map((row) => row.split("&").map((cell) => this.renderNested(cell, false).trim()))
			// 去掉整行所有格都空的行。
			.filter((row) => row.some(Boolean));
		// 列数取最长行格数，0用于空矩阵；缺格后面按空串补。
		const columnCount = Math.max(0, ...matrix.map((row) => row.length));
		// Array.from为每个列下标计算宽度。
		const columnWidths = Array.from({ length: columnCount }, (_, column) =>
			// 该列跨全部行的visibleWidth最大值，缺格/空矩阵回退0。
			Math.max(0, ...matrix.map((row) => visibleWidth(row[column] ?? ""))),
		);
		// 对每个矩阵行生成一条列已补齐的内容串。
		const rows = matrix.map((row) =>
			// 遍历统一列数而非本行已有格数，短行会补空格。
			Array.from({ length: columnCount }, (_, column) => {
				// 缺格用空串。
				const cell = row[column] ?? "";
				// 格文本后按本列最大宽的差额补保护码点，负差按0；这里先存占位符，最终还原为同数普通空格。
				return `${cell}${PROTECTED_SPACE.repeat(Math.max(0, (columnWidths[column] ?? 0) - visibleWidth(cell)))}`;
				// 列与列之间固定用空格竖线空格连接，即使matrix也会显示这些列分隔。
			}).join(" │ "),
		);

		// 准备按环境分配最终预制行数组。
		let lines: string[];
		// 三种无外括号环境直接采用列拼接结果。
		if (environment === "array" || environment === "matrix" || environment === "smallmatrix") {
			// 不加额外外侧圆/方括弧。
			lines = rows;
			// 其余环境需要外围定界符。
		} else {
			// 只读字典值是恰好六项的只读元组：左上/右上/左中/右中/左下/右下；TS检查长度，运行时不冻结或自动按名称验证。
			const delimiters: Readonly<Record<string, readonly [string, string, string, string, string, string]>> = {
				// pmatrix使用三段式圆括号字形。
				pmatrix: ["⎛", "⎞", "⎜", "⎟", "⎝", "⎠"],
				// bmatrix使用三段式方括号字形。
				bmatrix: ["⎡", "⎤", "⎢", "⎥", "⎣", "⎦"],
				// 大写Bmatrix使用花括弧字形，查表大小写敏感。
				Bmatrix: ["⎧", "⎫", "⎨", "⎬", "⎩", "⎭"],
				// vmatrix各高度都使用单竖线。
				vmatrix: ["│", "│", "│", "│", "│", "│"],
				// 大写Vmatrix各高度都使用双竖线。
				Vmatrix: ["║", "║", "║", "║", "║", "║"],
			};
			// 按环境名取六段定界符元组，未知键可能undefined。
			const delimiter = delimiters[environment];
			// 无对应元组不能继续加边框。
			if (!delimiter) {
				// 标整体不支持。
				this.supported = false;
				// 局部返回未加括弧的行串，但最终render不会当成功公开。
				return rows.join("\n");
			}
			// 每条内容行按所在高度选择外侧字形。
			lines = rows.map((row, index) => {
				// 首行优先左上，最后行左下，其余左中；单行同时为首末但首分支先取左上。
				const left = index === 0 ? delimiter[0] : index === rows.length - 1 ? delimiter[4] : delimiter[2];
				// 右侧对应同样首/末/中选择顺序。
				const right = index === 0 ? delimiter[1] : index === rows.length - 1 ? delimiter[5] : delimiter[3];
				// 左括弧、空格、列内容、空格、右括弧组成该行。
				return `${left} ${row} ${right}`;
			});
		}

		// 0/1行无需存共享多行节点。
		if (lines.length <= 1) {
			// 单行直接返回（含若有的上段括弧），空矩阵为空串。
			return lines[0] ?? "";
		}
		// 多行存matrix节点，基线0即首行与周围主式对齐。
		const index = this.layoutNodes.push({ type: "matrix", lines, baseline: 0 }) - 1;
		// 返回节点引用等待公共入口统一布局。
		return `${LAYOUT_MARKER_START}${index}${LAYOUT_MARKER_END}`;
	}

	// 用子解析器处理一段嵌套原文，返回中间串并共享节点表；参数stackFractions=false实际让子解析器display关闭，不只关闭分数一种结构。
	// 例：矩阵格/分段条件里的分数不再堆叠，但矩阵环境本身仍可能多行。子解析不支持会把父supported也置false并局部返原文，最外公共render最终undefined，无统一异常catch。
	private renderNested(source: string, stackFractions = true): string {
		// 创建新position从0的子解析器，共享layoutNodes；子display为父display且本次开关真。
		const rendered = new LatexParser(source, this.layoutNodes, this.display && stackFractions).render();
		// 子解析返回undefined表示有限语法未支持/残缺。
		if (rendered === undefined) {
			// 将失败传播到父级支持标记，不静默把局部原文当整体成功。
			this.supported = false;
			// 本层局部先返原source，供当前父流程继续消费结构。
			return source;
		}
		// 成功则返回子中间串，仍可包含共享布局引用。
		return rendered;
	}
}

// 公开渲染选项接口，开发期约束字段，运行时只对display严格比较true。
export interface RenderLatexOptions {
	/** Stack fractions and operator limits vertically for display math (default: false). */
	// 缺省false；true允许分数/上下限/某些脚标二维，矩阵/分段函数多行还可在普通模式生成，不等于只在display才有任何多行。
	display?: boolean;
}

/**
 * Render a basic LaTeX math expression as terminal-friendly Unicode text.
 * Returns undefined when the expression contains unsupported or malformed syntax.
 */
// 公共入口：输入已去外层数学分隔符的有限LaTeX源码及可选display，返回Unicode文字/多行或undefined；先解析，若有布局节点再展开、去公共左缩进及尾空白、还原保护空格。
// 例：frac{1}{2}普通模式得1/2，display可得1、横线、2三行；不支持命令让Markdown回退raw。无终端/网络/TeX执行，但列宽工具可更新缓存，异常未统一捕获为undefined。
// 内部使用私用区标记而未对外来同形字符做隔离/循环图验证，且没有表达式深度/输出大小上限；这是有限渲染器的当前边界。
export function renderLatex(source: string, options: RenderLatexOptions = {}): string | undefined {
	// 每次调用新建独立节点表，嵌套解析器共享本次表，不跨公式累计。
	const layoutNodes: LayoutNode[] = [];
	// 构造后立即render，只有options.display===true开启显示式，不把其他真值当true。
	const rendered = new LatexParser(source, layoutNodes, options.display === true).render();
	// 解析标不支持或未消费完整时公共结果失败。
	if (rendered === undefined) {
		// 直接undefined，外层自行决定显示原公式/其他回退。
		return undefined;
	}
	// 未生成布局节点就不需要二维展开。
	if (layoutNodes.length === 0) {
		// 只将保护空格替回普通空格后返回一维结果，普通空白已在解析render中规范。
		return rendered.replaceAll(PROTECTED_SPACE, " ");
	}
	// 有节点时展开整段中间串，取其完整行数组，不限制最大终端宽度。
	const lines = renderLayout(rendered, layoutNodes).lines;
	// 计算所有非空白行共同可去掉的最小左缩进。
	const indentation = Math.min(
		// filter忽略trim后空行，每条用码元长度差算前导空白；...传给Math.min，若全无有效行会得Infinity，未单独设特殊分支。
		...lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length),
	);
	// 开始对排好布局的各行做最终文字收尾。
	return (
		lines
			// 每行去相同最小左缩进，并去行尾普通空白；保护标记尚未还原以保留内部对齐。
			.map((line) => line.slice(indentation).trimEnd())
			// 按LF连成多行输出字符串。
			.join("\n")
			// 只trimEnd整体末尾，不统一trimStart以免丢相对左缩进。
			.trimEnd()
			// 最后把保护占位符全部换成普通ASCII空格，完成真正可显示文本。
			.replaceAll(PROTECTED_SPACE, " ")
	);
}
