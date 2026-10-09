param(
  [ValidateRange(30, 120)][int]$DurationSeconds = 60,
  [ValidateSet('first-key','typing','ime','switch','scroll-dock','scroll-transcript','appearance','theme','startup','idle')][string]$Scenario = 'typing',
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $PSScriptRoot 'common-windows.ps1')
. (Join-Path $PSScriptRoot 'theme-windows.ps1')
$taskChild = $null
try {
  # Reports must be new ordinary files under the repository, never a user-state path.
  if ([IO.Path]::IsPathRooted($Output) -or $Output -notmatch '^[A-Za-z0-9_./-]+\.json$' -or
      @($Output.Split('/') | Where-Object { $_ -in @('','..','.') }).Count -gt 0) { throw 'Invalid report path.' }
  $taskOutputPath = [IO.Path]::GetFullPath((Join-Path $taskRepoRoot $Output))
  $taskPrefix = [IO.Path]::GetFullPath($taskRepoRoot).TrimEnd('\') + '\'
  if (-not $taskOutputPath.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      (Test-Path -LiteralPath $taskOutputPath)) { throw 'Report path is unavailable.' }
  $taskOutputDirectory = Split-Path -Parent $taskOutputPath
  if (-not (Test-Path -LiteralPath $taskOutputDirectory -PathType Container)) { throw 'Report directory is unavailable.' }
  Assert-DreamSkinNoReparseComponents -Path $taskOutputDirectory
  $taskStateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
  Assert-DreamSkinNoReparseComponents -Path $taskStateRoot
  $taskState = Read-DreamSkinState -Path (Join-Path $taskStateRoot 'state.json')
  if ($null -eq $taskState) { throw 'Managed session unavailable.' }
  $taskCodex = Get-DreamSkinCodexInstall
  $taskWindowsSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $taskIdentity = Get-DreamSkinVerifiedCdpIdentity -Port ([int]$taskState.port) -Codex $taskCodex -ExpectedSessionId $taskWindowsSession
  if ($null -eq $taskIdentity -or $taskIdentity.BrowserId -cne $taskState.browserId) { throw 'Managed endpoint identity changed.' }
  $taskWindow = Wait-DreamSkinWin32WindowEvidence -Codex $taskCodex -TimeoutMilliseconds 5000
  if ($null -eq $taskWindow -or [int]$taskWindow.ProcessId -ne [int]$taskState.codexPid -or
      [long]$taskWindow.StartTimeFileTimeUtc -ne [long]$taskState.codexStartTimeFileTimeUtc) { throw 'Managed window identity changed.' }
  $taskPausePath = Join-Path $taskStateRoot 'paused'
  $taskPaused = Test-Path -LiteralPath $taskPausePath
  $taskNode = Get-DreamSkinNodeRuntime
  $taskCollector = Join-Path $taskRepoRoot 'tools\record-native-interactions.mjs'
  $taskArguments = @($taskCollector, '--port', "$($taskState.port)", '--browser-id', $taskIdentity.BrowserId,
    '--duration', "$DurationSeconds", '--scenario', $Scenario, '--output', $Output)
  $taskStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $taskStartInfo.FileName = $taskNode.Path
  $taskStartInfo.Arguments = ($taskArguments | ForEach-Object { ConvertTo-DreamSkinProcessArgument -Value $_ }) -join ' '
  $taskStartInfo.WorkingDirectory = $taskRepoRoot
  $taskStartInfo.UseShellExecute = $false
  $taskStartInfo.CreateNoWindow = $true
  $taskStartInfo.RedirectStandardOutput = $false
  $taskStartInfo.RedirectStandardError = $true
  $taskChild = [Diagnostics.Process]::new()
  $taskChild.StartInfo = $taskStartInfo
  if (-not $taskChild.Start()) { throw 'Collector failed to start.' }
  # Discard private CDP exceptions; public recorder output consists of fixed strings.
  $taskDiscardErrors = $taskChild.StandardError.ReadToEndAsync()
  if (-not $taskChild.WaitForExit(($DurationSeconds + 60) * 1000)) {
    $taskChild.Kill()
    [void]$taskChild.WaitForExit(5000)
    throw 'Bounded collector timed out.'
  }
  $taskExitCode = $taskChild.ExitCode
  $taskIdentityAfter = Get-DreamSkinVerifiedCdpIdentity -Port ([int]$taskState.port) -Codex $taskCodex -ExpectedSessionId $taskWindowsSession
  $taskWindowAfter = Wait-DreamSkinWin32WindowEvidence -Codex $taskCodex -TimeoutMilliseconds 5000
  $taskIdentityPreserved = $null -ne $taskIdentityAfter -and $taskIdentityAfter.BrowserId -ceq $taskIdentity.BrowserId -and
    $null -ne $taskWindowAfter -and [int]$taskWindowAfter.ProcessId -eq [int]$taskWindow.ProcessId -and
    [long]$taskWindowAfter.StartTimeFileTimeUtc -eq [long]$taskWindow.StartTimeFileTimeUtc -and
    (Test-Path -LiteralPath $taskPausePath) -eq $taskPaused
  if (-not (Test-Path -LiteralPath $taskOutputPath -PathType Leaf)) { throw 'Collector did not write a report.' }
  Assert-DreamSkinNoReparseComponents -Path $taskOutputPath
  if ((Get-Item -LiteralPath $taskOutputPath).Length -gt 2097152) { throw 'Report exceeded its bound.' }
  $taskReport = [IO.File]::ReadAllText($taskOutputPath) | ConvertFrom-Json
  if ($taskReport.schema -cne 'dream-skin-native-interactions/1') { throw 'Report schema mismatch.' }
  $taskReport | Add-Member -NotePropertyName windowsValidation -NotePropertyValue ([pscustomobject]@{
    storePackageValidated = $true; endpointOwnerSessionValidated = $true; rootWindowValidated = $true
    identityAndPausePreserved = [bool]$taskIdentityPreserved; appVersion = "$($taskCodex.Version)"; paused = [bool]$taskPaused
  })
  if (-not $taskIdentityPreserved) { $taskReport.status = 'invalid'; $taskReport.reason = 'windows-session-identity-changed' }
  [IO.File]::WriteAllText($taskOutputPath, ($taskReport | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  if (-not $taskIdentityPreserved -or $taskExitCode -ne 0 -or $taskReport.status -cne 'completed') { throw 'Native trial invalid; report retains a sanitized reason.' }
  Write-Output 'Verified native trial completed; managed app and skin processes were preserved.'
} catch {
  # Never print exception details containing an endpoint, process identifier, or private path.
  Write-Error 'Native baseline recording failed or was invalid. See the bounded report when present.'
  exit 1
} finally {
  if ($null -ne $taskChild) {
    try { if (-not $taskChild.HasExited) { $taskChild.Kill(); [void]$taskChild.WaitForExit(5000) } } catch {}
    $taskChild.Dispose()
  }
}
