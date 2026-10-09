param(
  [Parameter(Mandatory = $true)][string]$Plan,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskChild = $null

function Resolve-DreamSkinMacroPath {
  param([string]$RelativePath, [switch]$Existing)
  if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -cnotmatch '^[A-Za-z0-9_./-]+\.json$' -or
      @($RelativePath.Split('/') | Where-Object { $_ -in @('', '..', '.') -or
        $_ -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' -or $_.EndsWith('.') }).Count -gt 0) {
    throw 'Invalid macro path.'
  }
  $taskPath = [IO.Path]::GetFullPath((Join-Path $taskRepoRoot $RelativePath))
  $taskPrefix = [IO.Path]::GetFullPath($taskRepoRoot).TrimEnd('\') + '\'
  if (-not $taskPath.StartsWith($taskPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Macro path escaped the workspace.' }
  Assert-DreamSkinNoReparseComponents -Path $taskPath
  if ($Existing) {
    if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw 'Macro plan is unavailable.' }
    $taskPlanSize = (Get-Item -LiteralPath $taskPath -Force).Length
    if ($taskPlanSize -le 0 -or $taskPlanSize -gt 16384) { throw 'Macro plan exceeded its bound.' }
  } else {
    if (Test-Path -LiteralPath $taskPath) { throw 'Macro report path is unavailable.' }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $taskPath) -PathType Container)) { throw 'Macro report directory is unavailable.' }
  }
  return $taskPath
}

try {
  . (Join-Path $PSScriptRoot 'common-windows.ps1')
  . (Join-Path $PSScriptRoot 'theme-windows.ps1')
  $taskPlanPath = Resolve-DreamSkinMacroPath -RelativePath $Plan -Existing
  $taskOutputPath = Resolve-DreamSkinMacroPath -RelativePath $Output
  $taskStateRoot = Join-Path $env:LOCALAPPDATA 'CodexDreamSkin'
  Assert-DreamSkinNoReparseComponents -Path $taskStateRoot
  $taskState = Read-DreamSkinState -Path (Join-Path $taskStateRoot 'state.json')
  if ($null -eq $taskState) { throw 'Managed session unavailable.' }
  $taskCodex = Get-DreamSkinCodexInstall
  $taskWindowsSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $taskIdentity = Get-DreamSkinVerifiedCdpIdentity -Port ([int]$taskState.port) -Codex $taskCodex -ExpectedSessionId $taskWindowsSession
  if ($null -eq $taskIdentity -or $taskIdentity.BrowserId -cne $taskState.browserId) { throw 'Managed endpoint identity changed.' }
  $taskWindow = Wait-DreamSkinWin32WindowEvidence -Codex $taskCodex -ExpectedSessionId $taskWindowsSession -TimeoutMilliseconds 5000
  if ($null -eq $taskWindow -or [int]$taskWindow.ProcessId -ne [int]$taskState.codexPid -or
      [long]$taskWindow.StartTimeFileTimeUtc -ne [long]$taskState.codexStartTimeFileTimeUtc -or
      [int]$taskWindow.SessionId -ne $taskWindowsSession -or -not $taskWindow.Handle) { throw 'Managed window identity changed.' }
  $taskPausePath = Join-Path $taskStateRoot 'paused'
  Assert-DreamSkinNoReparseComponents -Path $taskPausePath
  $taskPaused = Test-Path -LiteralPath $taskPausePath
  $taskNode = Get-DreamSkinNodeRuntime
  $taskController = Join-Path $taskRepoRoot 'tools\benchmark-native-macro.mjs'
  Assert-DreamSkinNoReparseComponents -Path $taskController
  if (-not (Test-Path -LiteralPath $taskController -PathType Leaf)) { throw 'Macro controller is unavailable.' }
  $taskArguments = @($taskController, '--port', "$($taskState.port)", '--browser-id', $taskIdentity.BrowserId,
    '--plan', $Plan, '--output', $Output)
  $taskStartInfo = [Diagnostics.ProcessStartInfo]::new()
  $taskStartInfo.FileName = $taskNode.Path
  $taskStartInfo.Arguments = ($taskArguments | ForEach-Object { ConvertTo-DreamSkinProcessArgument -Value $_ }) -join ' '
  $taskStartInfo.WorkingDirectory = $taskRepoRoot
  $taskStartInfo.UseShellExecute = $false
  $taskStartInfo.CreateNoWindow = $true
  $taskStartInfo.RedirectStandardOutput = $true
  $taskStartInfo.RedirectStandardError = $true
  $taskChild = [Diagnostics.Process]::new()
  $taskChild.StartInfo = $taskStartInfo
  if (-not $taskChild.Start()) { throw 'Macro controller failed to start.' }
  # Only this Node child may be terminated. Never print private controller exceptions or output.
  $taskDiscardOutput = $taskChild.StandardOutput.ReadToEndAsync()
  $taskDiscardErrors = $taskChild.StandardError.ReadToEndAsync()
  if (-not $taskChild.WaitForExit(180000)) {
    $taskChild.Kill()
    [void]$taskChild.WaitForExit(5000)
    throw 'Bounded macro controller timed out.'
  }
  $taskExitCode = $taskChild.ExitCode
  $taskIdentityAfter = Get-DreamSkinVerifiedCdpIdentity -Port ([int]$taskState.port) -Codex $taskCodex -ExpectedSessionId $taskWindowsSession
  $taskWindowAfter = Wait-DreamSkinWin32WindowEvidence -Codex $taskCodex -ExpectedSessionId $taskWindowsSession -TimeoutMilliseconds 5000
  Assert-DreamSkinNoReparseComponents -Path $taskPausePath
  $taskIdentityPreserved = $null -ne $taskIdentityAfter -and $taskIdentityAfter.BrowserId -ceq $taskIdentity.BrowserId -and
    $null -ne $taskWindowAfter -and [int]$taskWindowAfter.ProcessId -eq [int]$taskWindow.ProcessId -and
    [long]$taskWindowAfter.StartTimeFileTimeUtc -eq [long]$taskWindow.StartTimeFileTimeUtc -and
    [int]$taskWindowAfter.SessionId -eq $taskWindowsSession -and "$($taskWindowAfter.Handle)" -ceq "$($taskWindow.Handle)" -and
    (Test-Path -LiteralPath $taskPausePath) -eq $taskPaused
  if (-not (Test-Path -LiteralPath $taskOutputPath -PathType Leaf)) { throw 'Macro controller did not write a report.' }
  Assert-DreamSkinNoReparseComponents -Path $taskOutputPath
  $taskReportSize = (Get-Item -LiteralPath $taskOutputPath -Force).Length
  if ($taskReportSize -le 0 -or $taskReportSize -gt 2097152) { throw 'Macro report exceeded its bound.' }
  $taskReport = [IO.File]::ReadAllText($taskOutputPath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
  if ($null -eq $taskReport -or $taskReport -is [array] -or $taskReport -is [string] -or
      $taskReport.schema -cne 'dream-skin-native-macro/1' -or
      $taskReport.status -cnotin @('completed', 'invalid') -or
      @($taskReport.PSObject.Properties.Name) -contains 'windowsValidation') { throw 'Macro report schema mismatch.' }
  $taskReport | Add-Member -NotePropertyName windowsValidation -NotePropertyValue ([pscustomobject]@{
    storePackageValidated = $true; endpointOwnerSessionValidated = $true; rootWindowValidated = $true
    identityAndPausePreserved = [bool]$taskIdentityPreserved; appVersion = "$($taskCodex.Version)"; paused = [bool]$taskPaused
  })
  if (-not $taskIdentityPreserved) {
    $taskReport.status = 'invalid'
    $taskReport | Add-Member -NotePropertyName reason -NotePropertyValue 'windows-session-identity-changed' -Force
  } elseif ($taskExitCode -ne 0 -and $taskReport.status -ceq 'completed') {
    $taskReport.status = 'invalid'
    $taskReport | Add-Member -NotePropertyName reason -NotePropertyValue 'macro-controller-failed' -Force
  }
  $taskReportText = $taskReport | ConvertTo-Json -Depth 16
  $taskReportEncoding = [Text.UTF8Encoding]::new($false)
  if ($taskReportEncoding.GetByteCount($taskReportText) -gt 2097152) { throw 'Validated macro report exceeded its bound.' }
  Assert-DreamSkinNoReparseComponents -Path $taskOutputPath
  [IO.File]::WriteAllText($taskOutputPath, $taskReportText, $taskReportEncoding)
  if (-not $taskIdentityPreserved -or $taskExitCode -ne 0 -or $taskReport.status -cne 'completed') { throw 'Native macro invalid; report retains a sanitized reason.' }
  Write-Output 'Verified native macro completed; managed app and skin processes were preserved.'
} catch {
  # Fixed public strings never expose endpoints, process identifiers, plan text, or private paths.
  [Console]::Error.WriteLine('Native macro failed or was invalid. See the bounded report when present.')
  exit 1
} finally {
  if ($null -ne $taskChild) {
    try { if (-not $taskChild.HasExited) { $taskChild.Kill(); [void]$taskChild.WaitForExit(5000) } } catch {}
    $taskChild.Dispose()
  }
}
