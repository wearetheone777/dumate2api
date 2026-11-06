# dumate2api 托盘启动器（Windows）
#
# 功能：启动服务 / 关闭服务 / 打开管理端 / 完全退出；前台窗口滚动显示两个进程
# 的实时日志；点关闭按钮隐藏到托盘（服务继续跑）；托盘右键提供同样的功能。
#
# 为什么用 PowerShell + WinForms：本项目对第三方依赖是零容忍（网关只允许 Node
# 内置模块），而 WinForms 是 Windows 自带的，不需要安装任何东西，也不需要
# Electron 那种几百 MB 的运行时。
#
# 为什么日志走「重定向到文件 + 轮询增量」而不是直接抓 stdout：
#   1. 两个进程的输出要合并显示并带前缀，直接抓流要在事件回调里跨线程改 UI，
#      在 PowerShell 里很容易死锁；
#   2. 文件留痕，客户关了窗口也能事后翻；
#   3. 轮询增量只需要记住字节偏移，实现简单、不会丢日志。
#
# 编码：本文件是 UTF-8 **带 BOM**。PowerShell 5.1 读取无 BOM 的 .ps1 会按
# ANSI 解码，中文全部乱码（甚至解析失败）。这与仓库「新建文件用无 BOM」的
# 约定不同，是 PowerShell 5.1 的硬性要求，别「顺手修正」掉。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Win32 互操作：只为了两件事——
#   1) 把 PowerShell 自带的控制台窗口藏起来（VBS 用 SW_HIDE 启动时本来就没有，
#      但从快捷方式直接跑 .ps1 时会有）；保持界面只有我们自己的窗体。
#   2) **强制显示主窗体**。启动器用 `WScript.Shell.Run cmd, 0, False`（窗口样式 0）
#      是为了不闪控制台，但 Windows 会把 STARTUPINFO 的 SW_HIDE 应用到该进程的
#      **第一次 ShowWindow**——而那一次恰好是 WinForms 显示主窗体。实测症状：
#      服务正常启动、进程活着，但窗口永远不出现（MainWindowHandle = 0）。
#      在 Shown 里再调一次 ShowWindow(SW_SHOW) 即可覆盖掉它。
Add-Type -Namespace Dumate -Name Native -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@

try {
    $console = [Dumate.Native]::GetConsoleWindow()
    if ($console -ne [IntPtr]::Zero) { [Dumate.Native]::ShowWindow($console, 0) | Out-Null }
} catch { }

$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- 常量 / 状态

$script:Root        = Split-Path -Parent $PSScriptRoot
$script:GatewayPort = 9082
$script:AdminPort   = 9083
$script:StablePort  = 9080
$script:AdminUrl    = "http://127.0.0.1:$($script:AdminPort)"
$script:DataDir     = Join-Path $script:Root 'data'
$script:LogGateway  = Join-Path $script:DataDir 'launcher-9082.log'
$script:LogAdmin    = Join-Path $script:DataDir 'launcher-9083.log'
$script:LogStable   = Join-Path $script:DataDir 'launcher-9080.log'
$script:IconPath    = Join-Path $script:Root 'assets\dumate2api.ico'

$script:Offsets     = @{}     # 日志文件 -> 已读到的字节偏移
$script:Procs       = @()     # 本应用拉起的 cmd 包装进程（退出时要连子进程一起收）
$script:Exiting     = $false
$script:MaxLogChars = 400000  # 富文本框上限，超了裁掉前半段防止越来越卡

# ---------------------------------------------------------------- 日志输出

function Add-Log {
    param(
        [string]$Text,
        [ValidateSet('info', 'ok', 'warn', 'err', 'gateway', 'admin', 'stable')]
        [string]$Kind = 'info'
    )
    if ($null -eq $script:LogBox) { return }
    if (-not $Text) { return }
    $Text = $Text.TrimEnd()
    if (-not $Text) { return }

    $color = switch ($Kind) {
        'ok'      { [System.Drawing.Color]::FromArgb( 80, 200, 120) }
        'warn'    { [System.Drawing.Color]::FromArgb(230, 180,  60) }
        'err'     { [System.Drawing.Color]::FromArgb(240, 100, 100) }
        'gateway' { [System.Drawing.Color]::FromArgb(140, 200, 255) }
        'admin'   { [System.Drawing.Color]::FromArgb(200, 170, 255) }
        'stable'  { [System.Drawing.Color]::FromArgb(255, 190, 140) }
        default   { [System.Drawing.Color]::FromArgb(200, 200, 200) }
    }

    $stamp = (Get-Date).ToString('HH:mm:ss')
    $body = if ($Kind -eq 'gateway' -or $Kind -eq 'admin') { $Text } else { "[$stamp] $Text" }

    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.SelectionLength = 0
    $script:LogBox.SelectionColor = $color
    $script:LogBox.AppendText($body + "`r`n")

    if ($script:LogBox.TextLength -gt $script:MaxLogChars) {
        $script:LogBox.Select(0, [int]($script:MaxLogChars / 2))
        $script:LogBox.SelectedText = ''
    }
    $script:LogBox.SelectionStart = $script:LogBox.TextLength
    $script:LogBox.ScrollToCaret()
}

# ---------------------------------------------------------------- 端口 / 进程

function Get-PortOwner {
    param([int]$Port)
    foreach ($line in (& netstat -ano 2>$null)) {
        if ($line -notmatch 'LISTENING') { continue }
        if ($line -notmatch ":$Port\s") { continue }
        $parts = @($line -split '\s+' | Where-Object { $_ })
        if ($parts.Count -ge 5) { return [int]$parts[-1] }
    }
    return 0
}

function Get-ProcName {
    param([int]$ProcId)
    try { return (Get-Process -Id $ProcId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Stop-ProcTree {
    param([int]$ProcId)
    if ($ProcId -le 0) { return }
    & taskkill /F /T /PID $ProcId 2>$null | Out-Null
}

function Test-GatewayUp { return (Get-PortOwner $script:GatewayPort) -ne 0 }
function Test-AdminUp   { return (Get-PortOwner $script:AdminPort)   -ne 0 }
function Test-StableUp  { return (Get-PortOwner $script:StablePort)  -ne 0 }

# ---------------------------------------------------------------- 启停服务

function Reset-LogFile {
    param([string]$Path)
    try {
        if (Test-Path $Path) { Remove-Item $Path -Force -ErrorAction Stop }
    } catch { }
    $script:Offsets[$Path] = 0
}

# 用 cmd.exe 的 `>>` 重定向把 node 的输出落到文件；CreateNoWindow 保证不弹窗。
function Start-NodeHidden {
    param(
        [string]$ScriptPath,
        [hashtable]$EnvVars,
        [string]$LogFile
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/c node ' + $ScriptPath + ' >> "' + $LogFile + '" 2>&1'
    $psi.WorkingDirectory = $script:Root
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    if ($EnvVars) {
        foreach ($k in $EnvVars.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvVars[$k] }
    }
    return [System.Diagnostics.Process]::Start($psi)
}

function Start-Services {
    if ($script:StartingServices) { return }
    $script:StartingServices = $true
    try {
        $gwPid = Get-PortOwner $script:GatewayPort
        $adPid = Get-PortOwner $script:AdminPort

        # 预检：端口被**非 node** 进程占着就放弃，绝不去杀别人的进程
        # （与 start-dev.bat 的 preflight 同一纪律）
        foreach ($item in @(@{ Port = $script:GatewayPort; ProcId = $gwPid },
                            @{ Port = $script:AdminPort;   ProcId = $adPid })) {
            if ($item.ProcId -ne 0) {
                $name = Get-ProcName $item.ProcId
                if ($name -ne 'node') {
                    Add-Log ("端口 {0} 被 {1}(PID {2}) 占用，不是 node，已放弃启动。" -f $item.Port, $name, $item.ProcId) 'err'
                    return
                }
            }
        }

        if ($gwPid -ne 0 -and $adPid -ne 0) {
            Add-Log '服务已在运行，无需重复启动。' 'warn'
            return
        }

        # 残留的自家 node 先收掉，保证端口干净（与 start-dev.bat 一致）
        if ($gwPid -ne 0) { Add-Log ("清理网关残留 PID $gwPid") 'warn'; Stop-ProcTree $gwPid; Start-Sleep -Milliseconds 600 }
        if ($adPid -ne 0) { Add-Log ("清理管理端残留 PID $adPid") 'warn'; Stop-ProcTree $adPid; Start-Sleep -Milliseconds 600 }

        Reset-LogFile $script:LogGateway
        Reset-LogFile $script:LogAdmin
        $script:Procs = @()

        # 管理端先起：它的 DUMATE_ADMIN_GATEWAY_PORT 要指向 9082，
        # 否则会去读 9080（稳定版）而显示空数据
        Add-Log '启动管理端 9083 …'
        $admin = Start-NodeHidden 'src\admin\server.js' @{
            DUMATE_ADMIN_PORT         = $script:AdminPort
            DUMATE_ADMIN_GATEWAY_PORT = $script:GatewayPort
        } $script:LogAdmin
        if ($admin) { $script:Procs += $admin }

        Start-Sleep -Milliseconds 900

        Add-Log '启动网关 9082 …'
        # 鉴权已强制开启且无需任何 env（9082 日志：DUMATE_REQUIRE_KEY 已废除）
        $gw = Start-NodeHidden 'src\server.js' @{
            DUMATE2API_PORT = $script:GatewayPort
        } $script:LogGateway
        if ($gw) { $script:Procs += $gw }

        Start-Sleep -Milliseconds 1200

        if (Test-GatewayUp) { Add-Log "网关已监听 $($script:GatewayPort)" 'ok' }
        else { Add-Log '网关未在预期时间内监听，请看上面的日志。' 'warn' }
        if (Test-AdminUp) { Add-Log "管理端已监听 $($script:AdminPort)" 'ok' }
        else { Add-Log '管理端未在预期时间内监听，请看上面的日志。' 'warn' }
    } finally {
        $script:StartingServices = $false
        Update-Status
    }
}

function Stop-Services {
    if ($script:StoppingServices) { return }
    $script:StoppingServices = $true
    try {
        Add-Log '正在停止服务 …'
        $any = $false
        foreach ($port in @($script:GatewayPort, $script:AdminPort)) {
            $procId = Get-PortOwner $port
            if ($procId -eq 0) { continue }
            $name = Get-ProcName $procId
            if ($name -ne 'node') {
                Add-Log ("端口 {0} 被 {1}(PID {2}) 占用，不是我们的进程，未处理。" -f $port, $name, $procId) 'warn'
                continue
            }
            Add-Log ("停止端口 {0} 上的 node PID {1}" -f $port, $procId) 'warn'
            Stop-ProcTree $procId
            $any = $true
        }
        # cmd 包装壳（node 被 /T 连坐杀掉后，壳通常自己就退了；这里兜底）
        foreach ($p in $script:Procs) {
            try { if (-not $p.HasExited) { Stop-ProcTree $p.Id } } catch { }
        }
        $script:Procs = @()

        Start-Sleep -Milliseconds 700
        if (Test-GatewayUp -or (Test-AdminUp)) {
            Add-Log '仍有端口在监听，请检查上面的告警。' 'err'
        } else {
            Add-Log '服务已全部停止。' 'ok'
        }
    } finally {
        $script:StoppingServices = $false
        Update-Status
    }
}

function Open-AdminPage {
    if (-not (Test-AdminUp)) {
        Add-Log "管理端未运行，但仍尝试打开 $($script:AdminUrl)" 'warn'
    }
    try {
        Start-Process $script:AdminUrl | Out-Null
        Add-Log "已在浏览器打开 $($script:AdminUrl)" 'ok'
    } catch {
        Add-Log "打开管理端失败：$($_.Exception.Message)" 'err'
    }
}

# ---------------------------------------------------------------- 9080 稳定版

# 启动 9080 稳定版（对外生产服务）。与 dev 两进程完全独立：
#   - 跑的是 stable\src（发布快照），不是主目录 src
#   - env 与 stable\start-stable.bat 同款（DUMATE_ADMIN_DATA 指向仓库 data，
#     与 dev 共享 keys.json / 账号文件——两个网关看到同一批 key 与账号池）
# 启动前预检：9080 被非 node 进程占着就放弃（同 dev 纪律，绝不杀别人的进程）。
function Start-Stable {
    if ($script:StartingStable) { return }
    $script:StartingStable = $true
    try {
        $pid80 = Get-PortOwner $script:StablePort
        if ($pid80 -ne 0) {
            $name = Get-ProcName $pid80
            if ($name -ne 'node') {
                Add-Log ("端口 {0} 被 {1}(PID {2}) 占用，不是 node，已放弃启动。" -f $script:StablePort, $name, $pid80) 'err'
                return
            }
            Add-Log ("清理 9080 残留 PID {0}" -f $pid80) 'warn'
            Stop-ProcTree $pid80
            Start-Sleep -Milliseconds 600
        }
        if (-not (Test-Path (Join-Path $script:Root 'stable\src\server.js'))) {
            Add-Log 'stable\src\server.js 不存在——先做快照同步再启动 9080。' 'err'
            return
        }
        Reset-LogFile $script:LogStable
        Add-Log '启动稳定版 9080（stable\src，对外服务）…'
        $p = Start-NodeHidden 'stable\src\server.js' @{
            DUMATE2API_PORT   = $script:StablePort
            DUMATE_ADMIN_DATA = $script:DataDir
        } $script:LogStable
        if ($p) { $script:Procs += $p }
        Start-Sleep -Milliseconds 1500
        if (Test-StableUp) { Add-Log "稳定版已监听 $($script:StablePort)" 'ok' }
        else { Add-Log '稳定版未在预期时间内监听，请看上面的日志。' 'warn' }
    } finally {
        $script:StartingStable = $false
        Update-Status
    }
}

# 停止 9080。**独立按钮**的原因：9080 是对外生产服务，「关闭服务」和
# 「完全退出」都绝不顺带杀它——生产服务的停止必须是显式动作。
function Stop-Stable {
    $pid80 = Get-PortOwner $script:StablePort
    if ($pid80 -eq 0) { Add-Log '稳定版 9080 未在运行。' 'warn'; return }
    $name = Get-ProcName $pid80
    if ($name -ne 'node') {
        Add-Log ("端口 {0} 被 {1}(PID {2}) 占用，不是我们的进程，未处理。" -f $script:StablePort, $name, $pid80) 'warn'
        return
    }
    Add-Log ("停止稳定版 9080（node PID {0}）" -f $pid80) 'warn'
    Stop-ProcTree $pid80
    Start-Sleep -Milliseconds 700
    if (Test-StableUp) { Add-Log '9080 仍在监听，请检查日志。' 'err' }
    else { Add-Log '稳定版 9080 已停止。' 'ok' }
    Update-Status
}

function Exit-App {
    if ($script:Exiting) { return }
    # 完全退出 = **全部服务**都停（9082/9083 + 9080 稳定版）——控制台都没了
    # 还留一个对外服务在跑，状态就没人看得见了；9080 的显式启停按钮仍在，
    # 只要不想退它就别点完全退出（关窗口收进托盘不影响任何服务）。
    Add-Log '完全退出：停止全部服务（9082 / 9083 / 9080）…' 'warn'
    Stop-Services
    Stop-Stable
    $script:Exiting = $true
    try { $script:Tray.Visible = $false; $script:Tray.Dispose() } catch { }
    try { $script:Form.Close() } catch { }
    [System.Windows.Forms.Application]::Exit()
}

# ---------------------------------------------------------------- 日志增量读取

function Read-Log-Delta {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return '' }
    try {
        $len = (Get-Item $Path -ErrorAction Stop).Length
    } catch { return '' }

    if (-not $script:Offsets.ContainsKey($Path)) { $script:Offsets[$Path] = 0 }
    $offset = [long]$script:Offsets[$Path]

    # 文件被截断（重新启动时我们会删除它）→ 从头读
    if ($len -lt $offset) { $offset = 0 }

    if ($len -le $offset) { $script:Offsets[$Path] = $len; return '' }

    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                                    [System.IO.FileAccess]::Read,
                                    [System.IO.FileShare]::ReadWrite)
    } catch { return '' }

    try {
        $fs.Position = $offset
        $count = [int]($len - $offset)
        $buf = New-Object byte[] $count
        $read = $fs.Read($buf, 0, $count)
        if ($read -le 0) { return '' }
        $script:Offsets[$Path] = $offset + $read
        return [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
    } catch {
        return ''
    } finally {
        $fs.Close()
    }
}

function Pump-Logs {
    $delta = Read-Log-Delta $script:LogGateway
    if ($delta) { foreach ($line in ($delta -split "`r?`n")) { if ($line.Trim()) { Add-Log $line 'gateway' } } }
    $delta = Read-Log-Delta $script:LogAdmin
    if ($delta) { foreach ($line in ($delta -split "`r?`n")) { if ($line.Trim()) { Add-Log $line 'admin' } } }
    $delta = Read-Log-Delta $script:LogStable
    if ($delta) { foreach ($line in ($delta -split "`r?`n")) { if ($line.Trim()) { Add-Log $line 'stable' } } }
}

# ---------------------------------------------------------------- 界面

$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = 'dumate2api 控制台 · 网关 9082 / 管理端 9083 / 稳定版 9080'
$script:Form.Size = New-Object System.Drawing.Size(940, 600)
$script:Form.MinimumSize = New-Object System.Drawing.Size(720, 420)
$script:Form.StartPosition = 'CenterScreen'
$script:Form.BackColor = [System.Drawing.Color]::FromArgb(24, 26, 30)
$script:Form.ForeColor = [System.Drawing.Color]::FromArgb(225, 228, 232)
$script:Form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
if (Test-Path $script:IconPath) {
    try { $script:Form.Icon = New-Object System.Drawing.Icon($script:IconPath) } catch { }
}

# ---- 顶部按钮条
$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Top'
$panel.Height = 46
$panel.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 6)
$panel.BackColor = [System.Drawing.Color]::FromArgb(32, 35, 40)
$script:Form.Controls.Add($panel)

function New-Button {
    param([string]$Text, [int]$Width, [scriptblock]$OnClick)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.Width = $Width
    $b.Height = 28
    $b.FlatStyle = 'Flat'
    $b.BackColor = [System.Drawing.Color]::FromArgb(52, 57, 65)
    $b.ForeColor = [System.Drawing.Color]::FromArgb(230, 232, 236)
    $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(70, 76, 86)
    $b.Margin = New-Object System.Windows.Forms.Padding(0, 0, 8, 0)
    $b.add_Click($OnClick)
    $panel.Controls.Add($b)
    return $b
}

$script:BtnStart = New-Button '启动服务' 92 { Start-Services }
$script:BtnStop  = New-Button '关闭服务' 92 { Stop-Services }
$script:BtnAdmin = New-Button '打开管理端' 104 { Open-AdminPage }
$script:BtnClear = New-Button '清空日志' 92 { $script:LogBox.Clear() }
$script:BtnExit  = New-Button '完全退出' 92 { Exit-App }
# 9080 稳定版独立成对：它是对外生产服务，启停都显式——「关闭服务」与
# 「完全退出」不碰它（Exit-App 只收 dev 两进程）
$script:BtnStableStart = New-Button '启动 9080' 96 { Start-Stable }
$script:BtnStableStop  = New-Button '停止 9080' 96 { Stop-Stable }

# ---- 状态栏（贴底）
$status = New-Object System.Windows.Forms.Label
$status.Dock = 'Bottom'
$status.Height = 26
$status.TextAlign = 'MiddleLeft'
$status.Padding = New-Object System.Windows.Forms.Padding(12, 0, 0, 0)
$status.BackColor = [System.Drawing.Color]::FromArgb(32, 35, 40)
$status.ForeColor = [System.Drawing.Color]::FromArgb(170, 176, 186)
$script:Form.Controls.Add($status)
$script:StatusLabel = $status

# ---- 日志区
$script:LogBox = New-Object System.Windows.Forms.RichTextBox
$script:LogBox.Dock = 'Fill'
$script:LogBox.ReadOnly = $true
$script:LogBox.BackColor = [System.Drawing.Color]::FromArgb(18, 20, 24)
$script:LogBox.ForeColor = [System.Drawing.Color]::FromArgb(200, 206, 214)
$script:LogBox.BorderStyle = 'None'
$script:LogBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$script:LogBox.WordWrap = $true
$script:LogBox.HideSelection = $false
$script:Form.Controls.Add($script:LogBox)
$script:LogBox.BringToFront()

function Update-Status {
    if ($null -eq $script:StatusLabel) { return }
    $gw = if (Test-GatewayUp) { "网关 $($script:GatewayPort)：运行中" } else { "网关 $($script:GatewayPort)：已停止" }
    $ad = if (Test-AdminUp)   { "管理端 $($script:AdminPort)：运行中" } else { "管理端 $($script:AdminPort)：已停止" }
    $st = if (Test-StableUp)  { "稳定版 $($script:StablePort)：运行中" } else { "稳定版 $($script:StablePort)：已停止" }
    $script:StatusLabel.Text = "$gw　|　$ad　|　$st　|　关闭窗口 = 收进托盘"

    if ($null -ne $script:BtnStart) {
        $script:BtnStart.Enabled = -not (Test-GatewayUp)
        $script:BtnStop.Enabled = (Test-GatewayUp -or (Test-AdminUp))
        $script:BtnStableStart.Enabled = -not (Test-StableUp)
        $script:BtnStableStop.Enabled = (Test-StableUp)
    }
}

# ---------------------------------------------------------------- 托盘

$script:Tray = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $script:IconPath) {
    try { $script:Tray.Icon = New-Object System.Drawing.Icon($script:IconPath) } catch { }
}
if ($null -eq $script:Tray.Icon) { $script:Tray.Icon = [System.Drawing.SystemIcons]::Application }
$script:Tray.Text = 'dumate2api 控制台'
$script:Tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function New-MenuItem {
    param([string]$Text, [scriptblock]$OnClick)
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem
    $mi.Text = $Text
    $mi.add_Click($OnClick)
    $menu.Items.Add($mi) | Out-Null
    return $mi
}
$null = New-MenuItem '显示窗口' { Show-Window }
$null = New-MenuItem '启动服务' { Start-Services }
$null = New-MenuItem '关闭服务' { Stop-Services }
$null = New-MenuItem '打开管理端页面' { Open-AdminPage }
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = New-MenuItem '启动 9080（稳定版）' { Start-Stable }
$null = New-MenuItem '停止 9080（稳定版）' { Stop-Stable }
$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$null = New-MenuItem '完全退出' { Exit-App }
$script:Tray.ContextMenuStrip = $menu

function Show-Window {
    $script:Form.Show()
    $script:Form.WindowState = 'Normal'
    $script:Form.Activate()
    $script:Form.BringToFront()
}

$script:Tray.add_MouseDoubleClick({ Show-Window })

# 点关闭按钮 = 收进托盘（服务继续跑），退出只能走「完全退出」
$script:Form.add_FormClosing({
    param($sender, $e)
    if (-not $script:Exiting) {
        $e.Cancel = $true
        $script:Form.Hide()
        $script:Tray.ShowBalloonTip(2000, 'dumate2api 仍在后台运行',
            '服务未停止。右键托盘图标可重新打开或退出。',
            [System.Windows.Forms.ToolTipIcon]::Info)
    }
})

# 覆盖 STARTUPINFO 的 SW_HIDE（见文件顶部 Native 注释）
$script:Form.add_Shown({
    try {
        [Dumate.Native]::ShowWindow($script:Form.Handle, 5) | Out-Null   # SW_SHOW = 5
        [Dumate.Native]::SetForegroundWindow($script:Form.Handle) | Out-Null
    } catch { }
})

# ---------------------------------------------------------------- 定时器

$script:PumpTimer = New-Object System.Windows.Forms.Timer
$script:PumpTimer.Interval = 700
$script:PumpTimer.add_Tick({
    Pump-Logs
    Update-Status
})
$script:PumpTimer.Start()

# ---------------------------------------------------------------- 启动

Add-Log '＝ dumate2api 控制台 ＝' 'ok'
Add-Log '关闭窗口只是收进托盘，服务继续运行；要停服务请点「关闭服务」或「完全退出」。' 'info'

if ((Test-GatewayUp) -or (Test-AdminUp)) {
    Add-Log '检测到服务已在运行，直接接管控制（本次启动之前的日志不会被显示）。' 'warn'
} else {
    Add-Log '开始启动服务 …'
    Start-Services
}

Update-Status
[System.Windows.Forms.Application]::Run($script:Form)
$script:PumpTimer.Stop()
try { $script:Tray.Visible = $false; $script:Tray.Dispose() } catch { }
