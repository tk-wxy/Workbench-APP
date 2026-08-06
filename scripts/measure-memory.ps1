# 增强搜索性能专项：进程分段内存采样（手动工具，不进 npm test）。
#
# 默认输出到系统 TEMP，绝不写进仓库触发 Vite HMR。每个采样点把 Rust + 本应用 WebView2
# 子进程按 --type= 分列，并额外输出 private/working-set 总和。Private 是进程归属指标，
# 不是应用“独占物理内存”；Working Set 含共享页，禁止简单称为实际独占。
#
# 用法：
#   powershell -File scripts/measure-memory.ps1 -DurationSec 180 -Variant baseline -Stage idle
# 场景阶段可分次启动（同一 RunId / OutCsv）：idle/open/query/scroll/close/settle。

param(
  [string]$ProcessName = "workbench-app",
  [string]$AppIdentifier = "com.workbench.app",
  [int]$IntervalMs = 500,
  [int]$DurationSec = 120,
  [string]$Variant = "baseline",
  [string]$Stage = "unspecified",
  [string]$RunId = (Get-Date -Format "yyyyMMdd-HHmmss"),
  [string]$Commit = "",
  [string]$OutCsv = ""
)

$ErrorActionPreference = "Stop"
if (-not $OutCsv) { $OutCsv = Join-Path $env:TEMP "workbench-perf-$RunId.csv" }
if (-not $Commit) {
  try { $Commit = (git rev-parse --short HEAD 2>$null).Trim() } catch { $Commit = "unknown" }
  if (-not $Commit) { $Commit = "unknown" }
}

if (-not (Test-Path $OutCsv)) {
  "run_id,variant,commit,stage,timestamp,process,pid,type,working_set_mb,private_mb,total_working_set_mb,total_private_mb" |
    Out-File -Encoding utf8 $OutCsv
}

$deadline = (Get-Date).AddSeconds($DurationSec)
$samples = 0
$lastRustPid = 0

while ((Get-Date) -lt $deadline) {
  $now = (Get-Date).ToString("HH:mm:ss.fff")
  $rows = [System.Collections.Generic.List[object]]::new()

  Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object {
    if ($lastRustPid -ne 0 -and $lastRustPid -ne $_.Id) {
      Write-Host "PID changed: $lastRustPid -> $($_.Id)"
    }
    $lastRustPid = $_.Id
    $rows.Add([pscustomobject]@{ Process=$_.ProcessName; Pid=$_.Id; Type="rust"; Ws=$_.WorkingSet64; Private=$_.PrivateMemorySize64 })
  }

  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($AppIdentifier) } |
    ForEach-Object {
      $type = "browser"
      if ($_.CommandLine -match '--type=([a-z\-]+)') { $type = $Matches[1] }
      $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
      if ($p) {
        $rows.Add([pscustomobject]@{ Process="webview2"; Pid=$p.Id; Type=$type; Ws=$p.WorkingSet64; Private=$p.PrivateMemorySize64 })
      }
    }

  $totalWs = ($rows | Measure-Object -Property Ws -Sum).Sum
  $totalPrivate = ($rows | Measure-Object -Property Private -Sum).Sum
  foreach ($row in $rows) {
    "{0},{1},{2},{3},{4},{5},{6},{7},{8:N1},{9:N1},{10:N1},{11:N1}" -f
      $RunId,$Variant,$Commit,$Stage,$now,$row.Process,$row.Pid,$row.Type,
      ($row.Ws/1MB),($row.Private/1MB),($totalWs/1MB),($totalPrivate/1MB) |
      Add-Content -Encoding utf8 $OutCsv
    $samples++
  }

  Start-Sleep -Milliseconds $IntervalMs
}

Write-Host "done: $samples rows -> $OutCsv (run=$RunId variant=$Variant stage=$Stage commit=$Commit)"
