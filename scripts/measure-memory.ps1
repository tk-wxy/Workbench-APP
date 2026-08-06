# 增强搜索性能专项：内存分段采样（手动工具，不进 npm test）。
#
# 采样对象：Rust 主进程 + 本应用的 WebView2 子进程（按命令行 --type= 分类）。
# 拆分类的原因（R46 根因）：图片解码位图驻留在 gpu-process / renderer，不在 JS heap，
# 只看单进程总和会掩盖「哪类进程在吃内存」。
#
# 用法（另开一个 PowerShell 窗口，先启动采样再操作应用）：
#   powershell -File scripts/measure-memory.ps1 -DurationSec 180 -OutCsv perf-baseline.csv
# 配合场景脚本：idle 10s → Ctrl+K 打开 → 查询电池 → ArrowDown 滚 200 行 → Esc 关闭 → 静置 10s。
# 阶段切换时在 CSV 里打标记行：另开终端执行
#   Add-Content perf-baseline.csv "# MARK open"   （open/query/scroll/close/settle）

param(
  [string]$ProcessName = "Workbench App",   # tauri.conf.json productName（Rust 主进程）
  [string]$AppIdentifier = "com.workbench.app", # WebView2 user-data-folder 里的应用标识
  [int]$IntervalMs = 500,
  [int]$DurationSec = 120,
  [string]$OutCsv = "perf-memory.csv"
)

$ErrorActionPreference = "Stop"

# 新建文件时写表头；追加模式复用既有文件（多轮测量进同一 CSV）
if (-not (Test-Path $OutCsv)) {
  "timestamp,process,pid,type,working_set_mb,private_mb" | Out-File -Encoding utf8 $OutCsv
}

$deadline = (Get-Date).AddSeconds($DurationSec)
$samples = 0

while ((Get-Date) -lt $deadline) {
  $now = (Get-Date).ToString("HH:mm:ss.fff")

  # Rust 主进程
  Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object {
    "{0},{1},{2},{3},{4:N1},{5:N1}" -f $now, $_.ProcessName, $_.Id, "rust",
      ($_.WorkingSet64 / 1MB), ($_.PrivateMemorySize64 / 1MB) |
      Add-Content -Encoding utf8 $OutCsv
    $script:samples++
  }

  # WebView2 子进程：用 CommandLine 里的 user-data-folder 归属本应用，再按 --type= 分类
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($AppIdentifier) } |
    ForEach-Object {
      $type = "browser" # 无 --type= 的是浏览器主进程
      if ($_.CommandLine -match '--type=([a-z\-]+)') { $type = $Matches[1] }
      $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($p) {
        "{0},{1},{2},{3},{4:N1},{5:N1}" -f $now, "webview2", $p.Id, $type,
          ($p.WorkingSet64 / 1MB), ($p.PrivateMemorySize64 / 1MB) |
          Add-Content -Encoding utf8 $OutCsv
        $script:samples++
      }
    }

  Start-Sleep -Milliseconds $IntervalMs
}

Write-Host "done: $samples samples -> $OutCsv"
