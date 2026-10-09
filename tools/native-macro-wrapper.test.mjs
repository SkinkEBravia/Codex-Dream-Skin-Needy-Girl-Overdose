import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wrapperPath = fileURLToPath(new URL("../windows/scripts/run-performance-macro.ps1", import.meta.url));
const wrapper = await fs.readFile(wrapperPath, "utf8");
const theme = await fs.readFile(new URL("../windows/scripts/theme-windows.ps1", import.meta.url), "utf8");
const reparseGuard = theme.slice(theme.indexOf("function Assert-DreamSkinNoReparseComponents {"), theme.indexOf("function Ensure-DreamSkinManagedDirectory {"));
const windowsOnly = { skip: process.platform !== "win32" };

test("macro wrapper bounds paths and child lifetime, validates native identity, and never controls app or skin", () => {
  assert.match(wrapper, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$Plan/);
  assert.match(wrapper, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$Output/);
  assert.doesNotMatch(wrapper, /DurationSeconds|--duration/);
  assert.match(wrapper, /taskPlanSize -gt 16384/);
  assert.match(wrapper, /taskReportSize -gt 2097152/);
  assert.match(wrapper, /GetByteCount\(\$taskReportText\) -gt 2097152/);
  assert.match(wrapper, /WaitForExit\(180000\)/);
  assert.match(wrapper, /benchmark-native-macro\.mjs/);
  assert.match(wrapper, /'--plan', \$Plan, '--output', \$Output/);
  assert.match(wrapper, /Get-DreamSkinCodexInstall/);
  assert.equal((wrapper.match(/Get-DreamSkinVerifiedCdpIdentity[^\r\n]+-ExpectedSessionId \$taskWindowsSession/g) ?? []).length, 2);
  assert.equal((wrapper.match(/Wait-DreamSkinWin32WindowEvidence[^\r\n]+-ExpectedSessionId \$taskWindowsSession/g) ?? []).length, 2);
  assert.match(wrapper, /StartTimeFileTimeUtc -ne \[long\]\$taskState\.codexStartTimeFileTimeUtc/);
  assert.match(wrapper, /taskWindowAfter\.StartTimeFileTimeUtc -eq \[long\]\$taskWindow\.StartTimeFileTimeUtc/);
  assert.match(wrapper, /taskWindowAfter\.Handle\)" -ceq "\$\(\$taskWindow\.Handle/);
  assert.match(wrapper, /Test-Path -LiteralPath \$taskPausePath\) -eq \$taskPaused/);
  assert.match(wrapper, /dream-skin-native-macro\/1/);
  assert.match(wrapper, /RedirectStandardOutput = \$true/);
  assert.match(wrapper, /RedirectStandardError = \$true/);
  assert.match(wrapper, /\$taskChild\.Kill\(\)/);
  assert.doesNotMatch(wrapper, /Stop-Process|taskkill|SendKeys|SendInput|keybd_event|mouse_event|SetForegroundWindow|SetFocus|Start-Process|Stop-DreamSkin|Write-DreamSkinState|start-dream-skin|patch-dream-skin|ExecutionPolicy\s+Bypass/i);
  assert.doesNotMatch(wrapper, /Write-Error|\$_.(?:Exception|ScriptStackTrace)|Write-Output\s+\$task/);
});

test("macro wrapper parses under Windows PowerShell 5.1", windowsOnly, () => {
  const script = '$taskErrors=$null;$taskTokens=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($env:DREAM_SKIN_TEST_WRAPPER,[ref]$taskTokens,[ref]$taskErrors);if($taskErrors.Count){[Console]::Error.WriteLine("Wrapper parser rejected source");exit 1}';
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, DREAM_SKIN_TEST_WRAPPER: wrapperPath }, encoding: "utf8", timeout: 10000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

async function makeFixture(t) {
  const evidenceRoot = fileURLToPath(new URL("../.local-evidence/", import.meta.url));
  await fs.mkdir(evidenceRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidenceRoot, "macro-wrapper-test-"));
  t.after(async () => {
    const relative = path.relative(path.resolve(evidenceRoot), path.resolve(root));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "cleanup stays inside test evidence root");
    await fs.rm(root, { recursive: true, force: true });
  });
  await Promise.all(["windows/scripts", "tools", "evidence", "state/CodexDreamSkin"].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
  await fs.writeFile(path.join(root, "windows/scripts/run-performance-macro.ps1"), wrapper);
  // These fixtures only return process/window metadata; no native app APIs are called.
  const mocks = `
function Read-DreamSkinState { param([string]$Path)
  return [pscustomobject]@{port=9333;browserId='verified-browser';codexPid=100;codexStartTimeFileTimeUtc=1234}
}
function Get-DreamSkinCodexInstall { return [pscustomobject]@{Version='26.1007.11041.0'} }
$global:taskIdentityCalls=0
function Get-DreamSkinVerifiedCdpIdentity {
  param([int]$Port,[object]$Codex,[int]$ExpectedSessionId)
  if(-not $PSBoundParameters.ContainsKey('ExpectedSessionId') -or $ExpectedSessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $Port -ne 9333){throw 'Mock expected bounded session'}
  $global:taskIdentityCalls++
  $taskId='verified-browser'
  if($env:DREAM_SKIN_MOCK_MODE -eq 'before-identity' -or ($global:taskIdentityCalls -gt 1 -and $env:DREAM_SKIN_MOCK_MODE -eq 'identity-change')){$taskId='changed-browser'}
  return [pscustomobject]@{BrowserId=$taskId}
}
$global:taskWindowCalls=0
function Wait-DreamSkinWin32WindowEvidence {
  param([object]$Codex,[int]$ExpectedSessionId,[int]$TimeoutMilliseconds)
  if(-not $PSBoundParameters.ContainsKey('ExpectedSessionId') -or $ExpectedSessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $TimeoutMilliseconds -ne 5000){throw 'Mock expected bounded native probe'}
  $global:taskWindowCalls++
  $taskEvidence=[pscustomobject]@{ProcessId=100;StartTimeFileTimeUtc=1234;SessionId=$ExpectedSessionId;Handle='1000'}
  if($env:DREAM_SKIN_MOCK_MODE -eq 'before-start'){$taskEvidence.StartTimeFileTimeUtc=5678}
  if($global:taskWindowCalls -gt 1){
    if($env:DREAM_SKIN_MOCK_MODE -eq 'window-change'){$taskEvidence.Handle='2000'}
    if($env:DREAM_SKIN_MOCK_MODE -eq 'start-change'){$taskEvidence.StartTimeFileTimeUtc=5678}
    if($env:DREAM_SKIN_MOCK_MODE -eq 'session-change'){$taskEvidence.SessionId=$ExpectedSessionId+1}
    if($env:DREAM_SKIN_MOCK_MODE -eq 'pid-change'){$taskEvidence.ProcessId=200}
  }
  return $taskEvidence
}
function Get-DreamSkinNodeRuntime { return [pscustomobject]@{Path=$env:DREAM_SKIN_TEST_NODE} }
function ConvertTo-DreamSkinProcessArgument { param([string]$Value) return ('"'+$Value+'"') }
function Get-Item {
  [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
  if((Split-Path -Leaf $LiteralPath) -eq 'linked'){return [pscustomobject]@{Attributes=[IO.FileAttributes]::ReparsePoint}}
  return Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force
}
`;
  await fs.writeFile(path.join(root, "windows/scripts/common-windows.ps1"), mocks);
  await fs.writeFile(path.join(root, "windows/scripts/theme-windows.ps1"), reparseGuard);
  await fs.writeFile(path.join(root, "tools/benchmark-native-macro.mjs"), `
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--port'||args[1]!=='9333'||args[2]!=='--browser-id'||args[3]!=='verified-browser'||args[4]!=='--plan'||args[6]!=='--output')process.exit(9);
fs.writeFileSync('tools/controller-started','mock child only');
const plan=JSON.parse(fs.readFileSync(args[5],'utf8'));
process.stdout.write('PRIVATE-CONTROLLER-OUTPUT');process.stderr.write('PRIVATE-CONTROLLER-ERROR');
if(process.env.DREAM_SKIN_MOCK_MODE==='pause-change')fs.writeFileSync(path.join(process.env.LOCALAPPDATA,'CodexDreamSkin','paused'),'');
if(plan.mode==='no-report')process.exit(1);
if(plan.mode==='oversize'){fs.writeFileSync(args[7],' '.repeat(2097153));process.exit(0)}
if(plan.mode==='malformed'){fs.writeFileSync(args[7],'{');process.exit(0)}
if(plan.mode==='empty'){fs.writeFileSync(args[7],'');process.exit(0)}
fs.writeFileSync(args[7],JSON.stringify({schema:plan.mode==='bad-schema'?'wrong/1':'dream-skin-native-macro/1',status:'completed',reason:null}),{flag:'wx'});
if(plan.mode==='child-failure')process.exit(7);
`);
  await fs.writeFile(path.join(root, "evidence/plan.json"), "{}");
  const run = (plan = "evidence/plan.json", output = "evidence/report.json", mode = "normal") => spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File", path.join(root, "windows/scripts/run-performance-macro.ps1"), "-Plan", plan, "-Output", output
  ], { cwd: root, encoding: "utf8", timeout: 15000,
    env: { ...process.env, LOCALAPPDATA: path.join(root, "state"), DREAM_SKIN_TEST_NODE: process.execPath, DREAM_SKIN_MOCK_MODE: mode }
  });
  return { root, run };
}

function assertFixedFailure(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "Native macro failed or was invalid. See the bounded report when present.");
}

test("mock controller receives only verified identity and relative paths; validated report and paused state are preserved", windowsOnly, async t => {
  const { root, run } = await makeFixture(t);
  await fs.writeFile(path.join(root, "evidence/plan.json"), "{}" + " ".repeat(16382));
  await fs.writeFile(path.join(root, "state/CodexDreamSkin/paused"), "unchanged");
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Verified native macro completed; managed app and skin processes were preserved.");
  assert.equal(result.stderr, "");
  const report = JSON.parse(await fs.readFile(path.join(root, "evidence/report.json"), "utf8"));
  assert.deepEqual(report.windowsValidation, {
    storePackageValidated: true, endpointOwnerSessionValidated: true, rootWindowValidated: true,
    identityAndPausePreserved: true, appVersion: "26.1007.11041.0", paused: true
  });
  assert.equal(await fs.readFile(path.join(root, "state/CodexDreamSkin/paused"), "utf8"), "unchanged");
});

test("plan and output paths fail before starting a child, preserving existing files and rejecting reparse ancestors", windowsOnly, async t => {
  const { root, run } = await makeFixture(t);
  await fs.writeFile(path.join(root, "evidence/existing.json"), "preserve");
  await fs.mkdir(path.join(root, "evidence/directory.json"));
  await fs.writeFile(path.join(root, "evidence/empty.json"), "");
  await fs.writeFile(path.join(root, "evidence/large.json"), " ".repeat(16385));
  // Sandbox denies creating junctions; execute the real ancestor guard against mocked reparse metadata.
  await fs.mkdir(path.join(root, "linked"));
  await fs.writeFile(path.join(root, "linked/plan.json"), "{}");
  const invalid = [
    ["../plan.json"], ["/private/plan.json"], ["C:/private/plan.json"], ["evidence\\plan.json"],
    ["evidence//plan.json"], ["evidence/./plan.json"], ["evidence/plan.json:stream"],
    ["evidence/CON.json"], ["missing.json"], ["evidence/directory.json"], ["evidence/empty.json"],
    ["evidence/large.json"], ["linked/plan.json"], ["evidence/plan.json", "../outside.json"],
    ["evidence/plan.json", "missing/report.json"], ["evidence/plan.json", "evidence/existing.json"],
    ["evidence/plan.json", "evidence/directory.json"], ["evidence/plan.json", "linked/report.json"]
  ];
  for (const args of invalid) assertFixedFailure(run(...args));
  await assert.rejects(fs.access(path.join(root, "tools/controller-started")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "evidence/existing.json"), "utf8"), "preserve");
});

test("endpoint or PID start mismatch prevents any macro child launch", windowsOnly, async t => {
  const { root, run } = await makeFixture(t);
  for (const mode of ["before-identity", "before-start"]) assertFixedFailure(run("evidence/plan.json", "evidence/report.json", mode));
  await assert.rejects(fs.access(path.join(root, "tools/controller-started")), { code: "ENOENT" });
});

test("changed endpoint, HWND, PID, start time, session, or pause invalidates reports without leaking identity", windowsOnly, async t => {
  const { root, run } = await makeFixture(t);
  for (const mode of ["identity-change", "window-change", "pid-change", "start-change", "session-change", "pause-change"]) {
    const output = `evidence/${mode}.json`;
    assertFixedFailure(run("evidence/plan.json", output, mode));
    const report = JSON.parse(await fs.readFile(path.join(root, output), "utf8"));
    assert.equal(report.status, "invalid");
    assert.equal(report.reason, "windows-session-identity-changed");
    assert.equal(report.windowsValidation.identityAndPausePreserved, false);
    assert.doesNotMatch(JSON.stringify(report), /verified-browser|changed-browser|PRIVATE-CONTROLLER/);
  }
});

test("bounded report validation rejects schema, missing and oversized output, and child failures", windowsOnly, async t => {
  const { root, run } = await makeFixture(t);
  for (const mode of ["bad-schema", "no-report", "oversize", "malformed", "empty", "child-failure"]) {
    const plan = `evidence/${mode}-plan.json`;
    const output = `evidence/${mode}-report.json`;
    await fs.writeFile(path.join(root, plan), JSON.stringify({ mode }));
    assertFixedFailure(run(plan, output));
    if (mode === "child-failure") {
      const report = JSON.parse(await fs.readFile(path.join(root, output), "utf8"));
      assert.equal(report.status, "invalid");
      assert.equal(report.reason, "macro-controller-failed");
      assert.equal(report.windowsValidation.identityAndPausePreserved, true);
    }
  }
});
