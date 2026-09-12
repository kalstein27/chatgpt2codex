import { promises as fs } from "node:fs";
import path from "node:path";

export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";
export const DESKTOP_SETTINGS_SCHEMA_VERSION = 1;

export interface DesktopSettings {
  schemaVersion: 1;
  language: string;
  projectFolder: string | null;
  launchAtStartup: boolean;
  startMcpOnOpen: boolean;
  autoCheckUpdates: boolean;
  multiProjectLanesEnabled: boolean;
  enablePublicTunnel: boolean;
  publicHostname: string | null;
  port: number;
  controlAllowlist: string[];
}

export type DesktopSettingsPatch = Partial<Omit<DesktopSettings, "schemaVersion">>;

const DEFAULT_SETTINGS: DesktopSettings = {
  schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
  language: "auto",
  projectFolder: null,
  launchAtStartup: false,
  startMcpOnOpen: false,
  autoCheckUpdates: false,
  multiProjectLanesEnabled: true,
  enablePublicTunnel: false,
  publicHostname: null,
  port: 7979,
  controlAllowlist: ["Finder"],
};

function boundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function language(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  return /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/u.test(normalized)
    ? normalized
    : undefined;
}

function allowlist(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value.slice(0, 64)) {
    if (typeof item !== "string") continue;
    const normalized = item.normalize("NFKC").trim().slice(0, 120);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function desktopSettingsPath(stateDir: string): string {
  return path.join(stateDir, DESKTOP_SETTINGS_FILE);
}

export function normalizeDesktopSettings(
  value: unknown,
  fallback: DesktopSettings = DEFAULT_SETTINGS,
): DesktopSettings {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalizedLanguage = language(input.language);
  const projectFolder = boundedString(input.projectFolder, 4096);
  const publicHostname = boundedString(input.publicHostname, 512);
  const parsedPort = Number(input.port);
  const normalizedAllowlist = allowlist(input.controlAllowlist);
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    language: normalizedLanguage ?? fallback.language,
    projectFolder: projectFolder === undefined ? fallback.projectFolder : projectFolder,
    launchAtStartup: typeof input.launchAtStartup === "boolean" ? input.launchAtStartup : fallback.launchAtStartup,
    startMcpOnOpen: typeof input.startMcpOnOpen === "boolean" ? input.startMcpOnOpen : fallback.startMcpOnOpen,
    autoCheckUpdates: typeof input.autoCheckUpdates === "boolean" ? input.autoCheckUpdates : fallback.autoCheckUpdates,
    multiProjectLanesEnabled: typeof input.multiProjectLanesEnabled === "boolean"
      ? input.multiProjectLanesEnabled
      : fallback.multiProjectLanesEnabled,
    enablePublicTunnel: typeof input.enablePublicTunnel === "boolean"
      ? input.enablePublicTunnel
      : fallback.enablePublicTunnel,
    publicHostname: publicHostname === undefined ? fallback.publicHostname : publicHostname,
    port: Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : fallback.port,
    controlAllowlist: normalizedAllowlist ?? fallback.controlAllowlist,
  };
}

export async function readDesktopSettings(stateDir: string): Promise<DesktopSettings> {
  try {
    const raw = await fs.readFile(desktopSettingsPath(stateDir), "utf8");
    return normalizeDesktopSettings(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS, controlAllowlist: [...DEFAULT_SETTINGS.controlAllowlist] };
    throw error;
  }
}

export async function writeDesktopSettings(stateDir: string, value: unknown): Promise<DesktopSettings> {
  const settings = normalizeDesktopSettings(value);
  const target = desktopSettingsPath(stateDir);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
  return settings;
}

export async function patchDesktopSettings(stateDir: string, patch: unknown): Promise<DesktopSettings> {
  const current = await readDesktopSettings(stateDir);
  const input = patch && typeof patch === "object" && !Array.isArray(patch)
    ? patch as Record<string, unknown>
    : {};
  return writeDesktopSettings(stateDir, { ...current, ...input });
}
