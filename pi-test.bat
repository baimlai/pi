@echo off
setlocal

REM 文件导读
REM
REM 所属：仓库根目录的 Windows 批处理启动器，是 pi-test.ps1 的薄包装。
REM 能力：定位 powershell.exe；调用同目录的 pi-test.ps1；原样转发参数并传播退出码。
REM 用法：pi-test.bat [--no-env] [CLI 参数...]
REM 上游：用户在 cmd.exe 中调用；下游：查找 powershell.exe，并用 -NoProfile -ExecutionPolicy
REM Bypass -File 运行同目录的 pi-test.ps1，再把参数原样转发。
REM 退出码：PowerShell 不存在时返回 1；否则返回 pi-test.ps1/node 的退出码（通过 ERRORLEVEL）。
REM 标准输出/错误：透传 PowerShell 与 CLI 的输出；找不到 powershell.exe 时向 stderr 打印提示。
REM 副作用：与 pi-test.ps1 相同，CLI 可能写会话/设置/缓存或调用模型；本批处理不建文件。
REM 幂等性：启动器本身无状态，但 CLI 操作可能有副作用。
REM 注意：%* 是原始参数字符串，转发时会经过一次 cmd/PowerShell 解析；含特殊字符的参数可能
REM 需要调用方自行加引号。
REM
REM 示例：pi-test.bat --no-env --help
REM
REM 建议阅读顺序：先看 where 检测，再看 PowerShell 调用与 ERRORLEVEL 传播。

REM %~dp0 是当前批处理文件所在目录，末尾带反斜杠。
set "SCRIPT_DIR=%~dp0"
REM 固定使用 Windows PowerShell（powershell.exe），而不是 pwsh.exe；两者参数兼容但不是同一程序。
set "POWERSHELL_EXE=powershell.exe"

REM 只用 where 检查可执行文件是否存在：>nul 2>nul 丢弃 stdout 与 stderr；errorlevel 1 表示未找到。
where %POWERSHELL_EXE% >nul 2>nul
REM errorlevel 按“>= 给定值”判断；1 表示 where 失败（找不到命令）。
if errorlevel 1 (
	REM >&2 把提示写到标准错误；exit /b 只结束当前批处理，不关闭调用者的 cmd 窗口。
	>&2 echo powershell.exe not found. Install PowerShell or run pi-test.ps1 directly.
	exit /b 1
)

REM -NoProfile 不加载用户配置，-ExecutionPolicy Bypass 仅对本次进程放宽策略；%* 原样转发参数。
%POWERSHELL_EXE% -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%pi-test.ps1" %*
REM ERRORLEVEL 由上一行 PowerShell 进程设置；exit /b 把它作为批处理退出码返回。
exit /b %ERRORLEVEL%
