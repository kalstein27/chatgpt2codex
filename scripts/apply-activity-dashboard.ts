import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIVITY_DASHBOARD_HTML,
  ACTIVITY_DASHBOARD_OVERRIDE_FILE,
  ACTIVITY_DASHBOARD_REVISION,
} from "../src/server/activity-dashboard.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function stateDir(): string {
  const configured = process.env.CHATGPT2CODEX_STATE_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".local", "share", "chatgpt2codex");
}

const targetDir = stateDir();
const targetPath = path.join(targetDir, ACTIVITY_DASHBOARD_OVERRIDE_FILE);
const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

await fs.mkdir(targetDir, { recursive: true, mode: DIR_MODE });
try {
  await fs.writeFile(temporaryPath, ACTIVITY_DASHBOARD_HTML, { encoding: "utf8", mode: FILE_MODE });
  await fs.chmod(temporaryPath, FILE_MODE).catch(() => undefined);
  await fs.rename(temporaryPath, targetPath);
  await fs.chmod(targetPath, FILE_MODE).catch(() => undefined);
} finally {
  await fs.unlink(temporaryPath).catch(() => undefined);
}

process.stdout.write(
  JSON.stringify({
    ok: true,
    revision: ACTIVITY_DASHBOARD_REVISION,
    target: targetPath,
  }) + "\n",
);
