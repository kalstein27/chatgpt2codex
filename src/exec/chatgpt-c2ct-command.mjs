import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commandName = process.argv[2] ?? "";
const fixedCommands = new Map([
  ["plugin-refresh", ["plugin", "refresh", "C2CT", "--json"]],
  ["catalog-refresh", ["plugin", "catalog-refresh", "C2CT", "--json"]],
  ["scan-tools", ["plugin", "scan-tools", "C2CT", "--json"]],
]);
const commandArgs = fixedCommands.get(commandName);

function fail(errorCode, message, exitCode = 2) {
  process.stderr.write(`${JSON.stringify({ ok: false, errorCode, message })}\n`);
  process.exit(exitCode);
}

if (process.platform !== "darwin") {
  fail("PLATFORM_UNSUPPORTED", "C2CT ChatGPT catalog commands require macOS.", 3);
}

if (!commandArgs || process.argv.length !== 3) {
  fail(
    "INVALID_FIXED_COMMAND",
    "Use one fixed command with no forwarded arguments: plugin-refresh, catalog-refresh, or scan-tools.",
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(scriptDir, "../../../chatgpt-mac-send/chatgpt-send"),
  join(homedir(), ".local", "bin", "chatgpt-send"),
  "/opt/homebrew/bin/chatgpt-send",
  "/usr/local/bin/chatgpt-send",
];

const executable = candidates.find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

if (!executable) {
  fail(
    "CHATGPT_SEND_NOT_FOUND",
    "Install chatgpt-send or keep chatgpt-mac-send beside ChatGPT2Codex.",
    3,
  );
}

const child = spawn(executable, commandArgs, {
  stdio: "inherit",
  shell: false,
});

child.once("error", () => {
  fail("CHATGPT_SEND_LAUNCH_FAILED", "Could not start the fixed chatgpt-send command.", 3);
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 3);
});
