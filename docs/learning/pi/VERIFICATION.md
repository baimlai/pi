# 架构导读验证记录

分析基线：5d74f40de919742b5847eb2da4b023d048987689。前面的架构扫描阶段只新增中文学习文档、图解及其机器清单，没有修改生产源码或仓库依赖。后续调用链注释和图表修复的验证见文末。

## 覆盖范围

- 16 个 root workspace manifests：12 个顶层包和 4 个扩展示例。
- 顶层包的 18 条内部 dependencies，以及单独标记的开发依赖。
- 按公开路径发现的源入口及静态导出声明；JSON、TSV 和正文均说明它不是编译器级的完整 API 审计。
- CLI、全部 33 个 RPC 命令、普通工具工厂、扩展/MCP 边界和 Chord 条件启用的内置 HTTP 路由。
- 核心执行文件包括 main、SDK、Agent、agent-loop、AgentSession、ai Models；支持模块通过公开入口、manifest 和代表实现核对。

## 实际执行的检查

1. Repo Architecture Walkthrough 的 verify_architecture_docs.py：通过，检查必需章节、代码围栏、证据结构及路径提示。
2. Codebase Summary 的 validate-summary.cjs：通过，检查 summary.json 的 schema 和基础语义。
3. 本地学习资料的 Markdown/HTML 文件链接、源码证据行、顶层包覆盖、依赖引用和公开导出记录数量一致性：通过。
4. Visual Explainer 渲染器：HTML、样式和交互资源已内联；Chrome 在桌面与窄屏视口检查图中文字边界，并逐步检查八步请求流程。页面的截图联系表由渲染器生成并人工查看。
5. 独立文档校对：核对 CLI 与 Durable 的边界、SessionManager 内存投影、事务提交边界、新旧 ai API、RPC/工具入口和 Chord HTTP 认证条件。

页面源文件与成品分别是 [pi-architecture.src.html](pi-architecture.src.html) 和 [pi-architecture.html](pi-architecture.html)。重做渲染可执行：

```sh
node ~/.codex/skills/visual-explainer/kit/render.mjs docs/learning/pi/pi-architecture.src.html --root "$PWD" --open
```

从仓库根目录运行文档校验：

```sh
python3 ~/.codex/skills/repo-architecture-walkthrough/scripts/verify_architecture_docs.py
node ~/.codex/skills/codebase-summary/validate-summary.cjs docs/learning/pi/summary.json
```

## 验证边界

没有调用真实模型、读取用户凭据、运行 SSH 部署、生产发布或项目完整测试。图中的流程是依据源码推演的示例。页面检查验证布局与流程控件，不能证明所有浏览器和外部模型服务的行为。

架构扫描阶段没有修改运行代码，因此当时未运行 npm run check、build 或 test.sh。Chord 部分是架构导读，未完整评审其 design、slice 规范与全部实现。

公开接口索引只记录源文件中的导出声明与重导出，不穷尽对象成员、条件类型解析、动态插件、外部库内部符号和运行时生成路由。机器清单的认证字段以接口条件和可见凭据边界解释；库类型声明本身没有登录动作。

## 使用的工作流

- Codebase Summary：并行盘点技术栈、内部模块和外部接口，再生成并校验摘要。
- Repo Architecture Walkthrough：先登记证据与关系，再画图和交叉校对。
- Visual Explainer：生成可独立打开的中文图解，渲染并检查。

三个 Skill 已安装在用户的 Codex skills 目录，后续回合可直接调用。Playwright 仅安装在新获取的 Visual Explainer Skill 目录中，固定版本 1.64.1，安装时禁用了生命周期脚本；Pi 的依赖未改变。

## 调用链学习与 Mermaid 修复验证

学习分支：`learning/full-chain-study-bay`。调用链导读见 [QUERY_CALL_CHAIN.md](QUERY_CALL_CHAIN.md)。

- 7 个源码文件新增中文学习注释；分别去除注释并转换为 JavaScript 后，与基线的可执行输出一致。
- 离线学习测试 `query-call-chain-learning.test.ts` 通过：两次用户提问、三次 faux 模型请求、一次真实文件读取；验证了工具结果进入后续模型上下文以及追问保留历史。
- `npm run build:offline` 与 `npm run check` 通过。没有调用真实聊天模型。
- 时序图参与者原名 `Loop` 会与 Mermaid 关键字冲突，已统一改为 `AgentEngine`，显示名称仍为 `agent-loop`。
- 使用 Mermaid **10.9.3** 和 **11.4.1**，在本地无头 Chrome 中分别复现旧图的解析错误，再对修复后的全部 **13 张图**逐张解析并实际渲染 SVG，共 **26 项检查通过**；并查看了调用链图的渲染截图。
- 检查范围为 `ARCHITECTURE_DIAGRAMS.md`、`SUMMARY.md`、`TOPIC_MEMORY_PROPOSAL.md`、`QUERY_CALL_CHAIN.md` 中的全部 Mermaid 代码块。验证依赖仅安装在临时目录，未改动仓库依赖或锁文件。

不同 Markdown 预览器可能使用其他 Mermaid 版本或布局样式；本次验证覆盖以上两个具体版本。
