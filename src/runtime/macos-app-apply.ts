import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { probeRuntimeHealth, type RuntimeHealthSnapshot } from "./runtime-apply.js";

// execution-capability: macos-app-apply-fixed-binaries
const execFileAsync = promisify(execFile);

export const MACOS_APP_BUNDLE_ID = "dev.chatgpttocodex.menubar";
export const MACOS_APP_NAME = "ChatGPT To Codex";
export const MACOS_APP_PROCESS = "ChatGPTToCodexStatusBar";
export const MACOS_APP_INSTALL_PATH = "/Applications/ChatGPT To Codex.app";
export const MACOS_APP_BUILD_RELATIVE_PATH = "build/macos/ChatGPT To Codex.app";

const MAIN_EXECUTABLE_RELATIVE_PATH = "Contents/MacOS/ChatGPTToCodexStatusBar";
const MACOS_APP_EXECUTABLE_PATH = path.join(MACOS_APP_INSTALL_PATH, MAIN_EXECUTABLE_RELATIVE_PATH);
const WAIT_STEP_MS = 250;
const WAIT_STEPS = 20;

export interface MacosAppIdentity {
  appPath: string;
  bundleId: string;
  teamIdentifier: string;
  authority: string | null;
  designatedRequirement: string;
  designatedRequirementSha256: string;
  mainExecutableSha256: string;
}

export interface MacosAppApplyPreflight {
  source: MacosAppIdentity;
  installed: MacosAppIdentity | null;
  alreadyApplied: boolean;
}

export interface MacosAppApplyResult {
  status: "APPLIED" | "ALREADY_APPLIED";
  source: MacosAppIdentity;
  installed: MacosAppIdentity;
  relaunched: boolean;
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean | null;
  previousAppPids: number[];
  previousSupervisorPid: number | null;
  previousRuntimePid: number | null;
  previousSupervisorOwnedByApp: boolean;
  previousSupervisorAlive: boolean;
  previousManagedRuntimeRecoveryRequired: boolean;
  currentAppPids: number[];
  currentSupervisorPid: number | null;
  currentRuntimePid: number | null;
}

export function requiresManagedRuntimeRecovery(input: {
  runtimePid: number | null;
  supervisorPid: number | null;
  supervisorAlive: boolean;
  supervisorOwnedByApp: boolean;
}): boolean {
  if (input.supervisorOwnedByApp) return true;
  return input.runtimePid !== null && (input.supervisorPid === null || !input.supervisorAlive);
}

function normalizeOutput(stdout: string | Buffer | undefined, stderr: string | Buffer | undefined): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

async function run(file: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

async function sha256File(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCodesignField(output: string, field: string): string | null {
  const prefix = `${field}=`;
  const line = output.split(/\r?\n/u).find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

export function parseDesignatedRequirement(output: string): string {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("designated =>") || entry.startsWith("# designated =>"));
  if (!line) throw new Error("macOS app has no designated requirement");
  return line.replace(/^#\s*/u, "");
}

export function hasStableTeamIdentifier(teamIdentifier: string): boolean {
  const normalized = teamIdentifier.trim();
  return normalized.length > 0 && normalized.toLowerCase() !== "not set";
}

export async function inspectMacosApp(appPath: string): Promise<MacosAppIdentity> {
  const stat = await fs.stat(appPath).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`macOS app bundle not found: ${appPath}`);

  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);

  const detail = await run("/usr/bin/codesign", ["-d", "--verbose=4", appPath]);
  const detailOutput = normalizeOutput(detail.stdout, detail.stderr);
  const bundleId = parseCodesignField(detailOutput, "Identifier") ?? "";
  const teamIdentifier = parseCodesignField(detailOutput, "TeamIdentifier") ?? "";
  const authority = parseCodesignField(detailOutput, "Authority");

  const plist = await run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(appPath, "Contents", "Info.plist"),
  ]);
  const plistBundleId = plist.stdout.trim();
  if (bundleId !== plistBundleId) {
    throw new Error(`bundle identifier mismatch: codesign=${bundleId || "<empty>"}, plist=${plistBundleId || "<empty>"}`);
  }

  const requirement = await run("/usr/bin/codesign", ["-d", "-r-", appPath]);
  const designatedRequirement = parseDesignatedRequirement(normalizeOutput(requirement.stdout, requirement.stderr));
  const mainExecutable = path.join(appPath, MAIN_EXECUTABLE_RELATIVE_PATH);
  const executableStat = await fs.stat(mainExecutable).catch(() => null);
  if (!executableStat?.isFile()) throw new Error(`menu-bar executable missing: ${mainExecutable}`);

  return {
    appPath,
    bundleId,
    teamIdentifier,
    authority,
    designatedRequirement,
    designatedRequirementSha256: createHash("sha256").update(designatedRequirement).digest("hex"),
    mainExecutableSha256: await sha256File(mainExecutable),
  };
}

function sameInstalledArtifact(left: MacosAppIdentity, right: MacosAppIdentity): boolean {
  return (
    left.bundleId === right.bundleId &&
    left.teamIdentifier === right.teamIdentifier &&
    left.designatedRequirementSha256 === right.designatedRequirementSha256 &&
    left.mainExecutableSha256 === right.mainExecutableSha256
  );
}

function assertCandidateIdentity(identity: MacosAppIdentity): void {
  if (identity.bundleId !== MACOS_APP_BUNDLE_ID) {
    throw new Error(`unexpected macOS app bundle identifier: ${identity.bundleId || "<empty>"}`);
  }
  if (!hasStableTeamIdentifier(identity.teamIdentifier)) {
    throw new Error("candidate macOS app must use a stable non-ad-hoc TeamIdentifier before installation");
  }
}

export async function preflightMacosAppApply(projectRoot: string): Promise<MacosAppApplyPreflight> {
  const sourcePath = path.resolve(projectRoot, MACOS_APP_BUILD_RELATIVE_PATH);
  const expectedSourcePath = path.join(path.resolve(projectRoot), MACOS_APP_BUILD_RELATIVE_PATH);
  if (sourcePath !== expectedSourcePath) throw new Error("candidate app path escaped project root");

  const source = await inspectMacosApp(sourcePath);
  assertCandidateIdentity(source);

  const installed = await inspectMacosApp(MACOS_APP_INSTALL_PATH).catch(() => null);
  if (installed && installed.bundleId !== MACOS_APP_BUNDLE_ID) {
    throw new Error(`installed app has unexpected bundle identifier: ${installed.bundleId || "<empty>"}`);
  }
  return {
    source,
    installed,
    alreadyApplied: installed ? sameInstalledArtifact(source, installed) : false,
  };
}

export function parseMacosAppProcessPids(output: string): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/u);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (command !== MACOS_APP_EXECUTABLE_PATH && !command.startsWith(`${MACOS_APP_EXECUTABLE_PATH} `)) continue;
    pids.push(pid);
  }
  return pids;
}

async function processPids(): Promise<number[]> {
  try {
    const result = await run("/bin/ps", ["-axo", "pid=,command="]);
    return parseMacosAppProcessPids(result.stdout);
  } catch {
    return [];
  }
}

async function processRunning(): Promise<boolean> {
  return (await processPids()).length > 0;
}

async function waitForProcess(running: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < WAIT_STEPS; attempt += 1) {
    if ((await processRunning()) === running) return true;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  return (await processRunning()) === running;
}

async function waitForPidsToExit(pids: readonly number[]): Promise<boolean> {
  if (pids.length === 0) return true;
  const expected = new Set(pids);
  for (let attempt = 0; attempt < WAIT_STEPS; attempt += 1) {
    const current = new Set(await processPids());
    if ([...expected].every((pid) => !current.has(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  const current = new Set(await processPids());
  return [...expected].every((pid) => !current.has(pid));
}

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExactPidsToExit(pids: readonly number[]): Promise<boolean> {
  for (let attempt = 0; attempt < WAIT_STEPS; attempt += 1) {
    if (pids.every((pid) => !pidRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  return pids.every((pid) => !pidRunning(pid));
}

async function parentPid(pid: number): Promise<number | null> {
  try {
    const result = await run("/bin/ps", ["-o", "ppid=", "-p", String(pid)]);
    const value = Number(result.stdout.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function processCommand(pid: number): Promise<string | null> {
  try {
    const result = await run("/bin/ps", ["-o", "command=", "-p", String(pid)]);
    const command = result.stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

export function managedSupervisorIdentityMatches(input: {
  supervisorPid: number | null;
  runtimePid: number | null;
  runtimeParentPid: number | null;
  supervisorCommand: string | null;
}): boolean {
  return input.supervisorPid !== null &&
    input.runtimePid !== null &&
    input.runtimeParentPid === input.supervisorPid &&
    input.supervisorCommand?.includes("start-chatgpt.sh") === true;
}

async function managedSupervisorRunning(supervisorPid: number | null, runtimePid: number | null): Promise<boolean> {
  if (supervisorPid === null || runtimePid === null || !pidRunning(supervisorPid) || !pidRunning(runtimePid)) return false;
  const [runtimeParentPid, supervisorCommand] = await Promise.all([
    parentPid(runtimePid),
    processCommand(supervisorPid),
  ]);
  return managedSupervisorIdentityMatches({ supervisorPid, runtimePid, runtimeParentPid, supervisorCommand });
}

async function signalExactPids(pids: readonly number[], signal: "TERM" | "KILL"): Promise<void> {
  for (const pid of pids) {
    if (!pidRunning(pid)) continue;
    await run("/bin/kill", [`-${signal}`, String(pid)]).catch(() => undefined);
  }
}

async function stopRuntimeForHandoffRecovery(runtimePid: number): Promise<void> {
  await signalExactPids([runtimePid], "TERM");
  if (!(await waitForExactPidsToExit([runtimePid]))) {
    await signalExactPids([runtimePid], "KILL");
  }
  if (!(await waitForExactPidsToExit([runtimePid]))) {
    throw new Error("runtime without a trusted managed supervisor did not stop during handoff recovery");
  }
}

function appApplyPort(): number {
  const value = Number(process.env.PORT ?? process.env.CHATGPT2CODEX_PORT ?? "7979");
  return Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 7979;
}

async function waitForHealthyRuntime(
  expectedSupervisorPid: number | null,
  requireLiveSupervisor = false,
): Promise<RuntimeHealthSnapshot | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const health = await probeRuntimeHealth(appApplyPort());
    const reportedSupervisorPid = health.externalIdentity?.supervisorPid ?? health.supervisorPid;
    const supervisorReady = !requireLiveSupervisor ||
      await managedSupervisorRunning(reportedSupervisorPid, health.runtimePid);
    if (health.healthy &&
        (expectedSupervisorPid === null || reportedSupervisorPid === expectedSupervisorPid) &&
        supervisorReady) return health;
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
  }
  return null;
}

async function relaunchInstalledApp(forceRuntimeStart = false): Promise<boolean> {
  const args = forceRuntimeStart
    ? [MACOS_APP_INSTALL_PATH, "--args", "--c2ct-recover-runtime"]
    : [MACOS_APP_INSTALL_PATH];
  await run("/usr/bin/open", args);
  return waitForProcess(true);
}

async function stopInstalledAppProcesses(health: RuntimeHealthSnapshot | null): Promise<{
  appPids: number[];
  supervisorPid: number | null;
  runtimePid: number | null;
  supervisorOwnedByApp: boolean;
  supervisorAlive: boolean;
  runtimeRecoveryRequired: boolean;
}> {
  const existingPids = await processPids();
  const supervisorPid = health?.supervisorPid ?? health?.externalIdentity?.supervisorPid ?? null;
  const runtimePid = health?.runtimePid ?? null;
  const supervisorAlive = await managedSupervisorRunning(supervisorPid, runtimePid);
  const supervisorParentPid = supervisorAlive && supervisorPid !== null ? await parentPid(supervisorPid) : null;
  const supervisorOwnedByApp = supervisorAlive && supervisorParentPid !== null && existingPids.includes(supervisorParentPid);
  const runtimeRecoveryRequired = requiresManagedRuntimeRecovery({
    runtimePid,
    supervisorPid,
    supervisorAlive,
    supervisorOwnedByApp,
  });
  if (existingPids.length === 0) {
    if (runtimeRecoveryRequired && runtimePid !== null) {
      await stopRuntimeForHandoffRecovery(runtimePid);
    }
    return {
      appPids: [],
      supervisorPid,
      runtimePid,
      supervisorOwnedByApp: false,
      supervisorAlive,
      runtimeRecoveryRequired,
    };
  }

  // Ask AppKit to terminate normally first. applicationWillTerminate then
  // stops only a supervisor owned by this app; an external runtime remains
  // untouched. Exact-PID TERM/KILL is only a bounded fallback for the app.
  await run("/usr/bin/osascript", ["-e", `tell application id "${MACOS_APP_BUNDLE_ID}" to quit`]).catch(() => undefined);
  if (!(await waitForPidsToExit(existingPids))) {
    await signalExactPids(existingPids, "TERM");
  }
  if (!(await waitForPidsToExit(existingPids))) {
    await signalExactPids(existingPids, "KILL");
  }
  if (!(await waitForPidsToExit(existingPids))) {
    throw new Error("previous menu-bar app processes did not stop after bounded exact-PID fallback");
  }

  if (runtimeRecoveryRequired && !supervisorOwnedByApp && runtimePid !== null) {
    await stopRuntimeForHandoffRecovery(runtimePid);
  }

  if (supervisorOwnedByApp && supervisorPid !== null) {
    if (!(await waitForExactPidsToExit([supervisorPid]))) {
      await signalExactPids([supervisorPid], "TERM");
    }
    if (!(await waitForExactPidsToExit([supervisorPid]))) {
      await signalExactPids([supervisorPid], "KILL");
    }
    if (!(await waitForExactPidsToExit([supervisorPid]))) {
      throw new Error("app-owned runtime supervisor did not stop during handoff");
    }
    if (runtimePid !== null && !(await waitForExactPidsToExit([runtimePid]))) {
      await signalExactPids([runtimePid], "TERM");
      if (!(await waitForExactPidsToExit([runtimePid]))) await signalExactPids([runtimePid], "KILL");
    }
  }
  return {
    appPids: existingPids,
    supervisorPid,
    runtimePid,
    supervisorOwnedByApp,
    supervisorAlive,
    runtimeRecoveryRequired,
  };
}

function assertSameCandidate(expected: MacosAppIdentity, actual: MacosAppIdentity): void {
  if (!sameInstalledArtifact(expected, actual)) {
    throw new Error("candidate macOS app changed after approval; refusing to install stale or different bytes");
  }
}

export async function applyVerifiedMacosApp(
  projectRoot: string,
  expectedSource: MacosAppIdentity,
): Promise<MacosAppApplyResult> {
  const fresh = await preflightMacosAppApply(projectRoot);
  assertSameCandidate(expectedSource, fresh.source);
  if (fresh.alreadyApplied && fresh.installed) {
    const health = await probeRuntimeHealth(appApplyPort()).catch(() => null);
    return {
      status: "ALREADY_APPLIED",
      source: fresh.source,
      installed: fresh.installed,
      relaunched: await processRunning(),
      rollbackAttempted: false,
      rollbackSucceeded: null,
      previousAppPids: await processPids(),
      previousSupervisorPid: health?.supervisorPid ?? null,
      previousRuntimePid: health?.runtimePid ?? null,
      previousSupervisorOwnedByApp: false,
      previousSupervisorAlive: health?.supervisorPid ? pidRunning(health.supervisorPid) : false,
      previousManagedRuntimeRecoveryRequired: false,
      currentAppPids: await processPids(),
      currentSupervisorPid: health?.supervisorPid ?? null,
      currentRuntimePid: health?.runtimePid ?? null,
    };
  }

  const stage = `/Applications/.ChatGPT To Codex.app.staging-${randomUUID()}`;
  const backup = `/Applications/.ChatGPT To Codex.app.backup-${randomUUID()}`;
  let backupCreated = false;
  let replacementInstalled = false;
  let rollbackAttempted = false;
  let rollbackSucceeded: boolean | null = null;
  const beforeHealth = await probeRuntimeHealth(appApplyPort()).catch(() => null);
  let stopped = {
    appPids: [] as number[],
    supervisorPid: beforeHealth?.supervisorPid ?? null,
    runtimePid: beforeHealth?.runtimePid ?? null,
    supervisorOwnedByApp: false,
    supervisorAlive: beforeHealth?.supervisorPid ? pidRunning(beforeHealth.supervisorPid) : false,
    runtimeRecoveryRequired: false,
  };

  await fs.rm(stage, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });

  try {
    await run("/usr/bin/ditto", [fresh.source.appPath, stage]);
    const staged = await inspectMacosApp(stage);
    assertSameCandidate(fresh.source, staged);

    stopped = await stopInstalledAppProcesses(beforeHealth);

    const destinationStat = await fs.stat(MACOS_APP_INSTALL_PATH).catch(() => null);
    if (destinationStat) {
      await fs.rename(MACOS_APP_INSTALL_PATH, backup);
      backupCreated = true;
    }
    await fs.rename(stage, MACOS_APP_INSTALL_PATH);
    replacementInstalled = true;

    const installed = await inspectMacosApp(MACOS_APP_INSTALL_PATH);
    assertSameCandidate(fresh.source, installed);
    const forceRuntimeRecovery = stopped.supervisorOwnedByApp || stopped.runtimeRecoveryRequired;
    const relaunched = await relaunchInstalledApp(forceRuntimeRecovery);
    if (!relaunched) throw new Error("installed menu-bar app did not relaunch");
    const afterHealth = await waitForHealthyRuntime(
      forceRuntimeRecovery ? null : stopped.supervisorPid,
      forceRuntimeRecovery,
    );
    if (!afterHealth) throw new Error("installed menu-bar app relaunched but managed runtime health did not recover");

    if (backupCreated) await fs.rm(backup, { recursive: true, force: true });
    return {
      status: "APPLIED",
      source: fresh.source,
      installed,
      relaunched,
      rollbackAttempted,
      rollbackSucceeded,
      previousAppPids: stopped.appPids,
      previousSupervisorPid: stopped.supervisorPid,
      previousRuntimePid: stopped.runtimePid,
      previousSupervisorOwnedByApp: stopped.supervisorOwnedByApp,
      previousSupervisorAlive: stopped.supervisorAlive,
      previousManagedRuntimeRecoveryRequired: stopped.runtimeRecoveryRequired,
      currentAppPids: await processPids(),
      currentSupervisorPid: afterHealth.supervisorPid,
      currentRuntimePid: afterHealth.runtimePid,
    };
  } catch (error) {
    if (backupCreated || replacementInstalled) {
      rollbackAttempted = true;
      try {
        const rollbackHealth = await probeRuntimeHealth(appApplyPort()).catch(() => null);
        await stopInstalledAppProcesses(rollbackHealth);
        if (replacementInstalled) await fs.rm(MACOS_APP_INSTALL_PATH, { recursive: true, force: true });
        if (backupCreated) await fs.rename(backup, MACOS_APP_INSTALL_PATH);
        await relaunchInstalledApp(stopped.supervisorOwnedByApp || stopped.runtimeRecoveryRequired).catch(() => false);
        rollbackSucceeded = backupCreated ? true : null;
      } catch {
        rollbackSucceeded = false;
      }
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      rollbackAttempted,
      rollbackSucceeded,
    });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (!rollbackAttempted || rollbackSucceeded === true) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
