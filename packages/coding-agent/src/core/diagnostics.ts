// 资源加载器向CLI/TUI报告重名、警告和错误的数据契约；这里只声明类型，不决定赢家或打印提示。
// interface在运行时被擦除，外部JSON不会因为符合这个名字就自动通过校验。
export interface ResourceCollision {
	// 字面量联合限制发生冲突的资源类别；具体同名命令/工具也归扩展资源。
	resourceType: "extension" | "skill" | "prompt" | "theme";
	// 被争用的调用/展示名称，例如两个扩展都提供同名工具。
	name: string; // skill name, command/tool/flag name, prompt name, theme name
	// 最终保留的资源位置，不表示本接口已经执行磁盘存在性检查。
	winnerPath: string;
	// 被遮蔽的位置，加载器提供它供用户定位。
	loserPath: string;
	// ?表示可缺来源，例如npm包、Git来源或local；不等于路径字段可缺。
	winnerSource?: string; // e.g., "npm:foo", "git:...", "local"
	// 失败一方的来源，可与赢家属于不同安装范围。
	loserSource?: string;
}

// 一条资源诊断：例如{type:"warning",message:"缺少描述",path:"..."}，不一定是致命错误。
export interface ResourceDiagnostic {
	// 标签用于显示或分类；当前字段没有与collision组成严格的判别联合。
	type: "warning" | "error" | "collision";
	// 面向用户的说明文字，类型不保证已经脱敏。
	message: string;
	// 可选的关联路径。
	path?: string;
	// 可选冲突详情；仅凭type="collision"，TS仍不能保证这个属性必有值。
	collision?: ResourceCollision;
}
