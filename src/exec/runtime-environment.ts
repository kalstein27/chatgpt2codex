import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, normalize, sep } from "node:path";

export type ExecutionAlternative = {
  tool: string;
  reason: string;
};

export type CommandNotFoundHint = {
  command: string;
  alternatives: ExecutionAlternative[];
};

export type RuntimeBinaryInventoryEntry = {
  name: string;
  shellVisible: boolean;
  runtimeAvailable: boolean;
  source: "process.execPath" | "npm_execpath" | "bundled-runtime" | "shell-path" | "missing";
  resolvedPath?: string;
  permission: "standard" | "external-search-approval-required";
  recommendedTool?: string;
};

export type RuntimeEnvironmentInventory = {
  platform: NodeJS.Platform;
  pathPolicy: "allowlisted-parent-environment";
  shellPathEntries: string[];
  binaries: RuntimeBinaryInventoryEntry[];
};

type RuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  platform?: NodeJS.Platform;
};

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`)];
}

export function resolveCommandOnPath(name: string, options: RuntimeOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const entries = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of entries) {
    for (const candidateName of executableNames(name, env, platform)) {
      const candidate = join(entry, candidateName);
      if (isExecutableFile(candidate, platform)) return safeRealpath(candidate);
    }
  }
  return undefined;
}

function bundledNpmCandidates(execPath: string): string[] {
  const paths = new Set<string>();
  for (const candidateExec of [execPath, safeRealpath(execPath)]) {
    const binDir = dirname(candidateExec);
    paths.add(join(binDir, "..", "npm", "bin", "npm-cli.js"));
    paths.add(join(binDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    paths.add(join(binDir, "..", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    paths.add(join(binDir, "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return [...paths].map(normalize);
}

function bundledSiblingBinary(
  name: string,
  execPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const candidates = new Set<string>();
  for (const candidateExec of [execPath, safeRealpath(execPath)]) {
    const binDir = dirname(candidateExec);
    for (const executable of executableNames(name, env, platform)) {
      candidates.add(join(binDir, executable));
    }
  }
  for (const candidate of candidates) {
    if (isExecutableFile(candidate, platform)) return safeRealpath(candidate);
  }
  return undefined;
}

export function resolveNpmInvocation(
  options: RuntimeOptions = {},
): { argvPrefix: string[]; source: RuntimeBinaryInventoryEntry["source"]; resolvedPath: string } | undefined {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;

  const npmExecPath = env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      argvPrefix: [execPath, npmExecPath],
      source: "npm_execpath",
      resolvedPath: safeRealpath(npmExecPath),
    };
  }

  for (const candidate of bundledNpmCandidates(execPath)) {
    if (existsSync(candidate)) {
      return {
        argvPrefix: [execPath, candidate],
        source: "bundled-runtime",
        resolvedPath: safeRealpath(candidate),
      };
    }
  }

  const shellNpm = resolveCommandOnPath(platform === "win32" ? "npm.cmd" : "npm", {
    env,
    execPath,
    platform,
  });
  if (shellNpm) {
    return {
      argvPrefix: [shellNpm],
      source: "shell-path",
      resolvedPath: shellNpm,
    };
  }
  return undefined;
}

function displayPath(path: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || env.USERPROFILE;
  if (home) {
    const normalizedHome = normalize(home);
    const normalizedPath = normalize(path);
    if (normalizedPath === normalizedHome) return "~";
    if (normalizedPath.startsWith(`${normalizedHome}${sep}`)) {
      return `~${normalizedPath.slice(normalizedHome.length)}`;
    }
  }
  return path;
}

export function inspectExecutionEnvironment(options: RuntimeOptions = {}): RuntimeEnvironmentInventory {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const npm = resolveNpmInvocation({ env, execPath, platform });
  const bundledRg = bundledSiblingBinary("rg", execPath, env, platform);

  const specs: Array<{
    name: string;
    runtimePath?: string;
    runtimeSource?: RuntimeBinaryInventoryEntry["source"];
    permission?: RuntimeBinaryInventoryEntry["permission"];
    recommendedTool?: string;
  }> = [
    {
      name: "node",
      runtimePath: safeRealpath(execPath),
      runtimeSource: "process.execPath",
      recommendedTool: "command_run",
    },
    {
      name: "npm",
      runtimePath: npm?.resolvedPath,
      runtimeSource: npm?.source,
      recommendedTool: "command_list/command_run",
    },
    { name: "git", recommendedTool: "repo_status and Git tools" },
    {
      name: "rg",
      runtimePath: bundledRg,
      runtimeSource: bundledRg ? "bundled-runtime" : undefined,
      permission: "external-search-approval-required",
      recommendedTool: bundledRg ? "rg_search (approval required)" : "code_search",
    },
    { name: "make", recommendedTool: "command_list/command_run" },
    { name: "flutter", recommendedTool: "command_list/command_run" },
  ];

  const binaries = specs.map((spec): RuntimeBinaryInventoryEntry => {
    const shellPath = resolveCommandOnPath(spec.name, { env, execPath, platform });
    const runtimePath = spec.runtimePath;
    const source = runtimePath
      ? (spec.runtimeSource ?? "bundled-runtime")
      : shellPath
        ? "shell-path"
        : "missing";
    const resolvedPath = runtimePath ?? shellPath;
    return {
      name: spec.name,
      shellVisible: Boolean(shellPath),
      runtimeAvailable: Boolean(runtimePath || shellPath),
      source,
      ...(resolvedPath ? { resolvedPath: displayPath(resolvedPath, env) } : {}),
      permission: spec.permission ?? "standard",
      ...(spec.recommendedTool ? { recommendedTool: spec.recommendedTool } : {}),
    };
  });

  return {
    platform,
    pathPolicy: "allowlisted-parent-environment",
    shellPathEntries: (env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => displayPath(entry, env)),
    binaries,
  };
}

const COMMAND_NOT_FOUND_PATTERNS = [
  /(?:^|\n)(?:[^:\n]+:\s*)?(?:line\s+\d+:\s*)?([A-Za-z0-9_.+\-/]+):\s+(?:command\s+)?not found\b/i,
  /(?:^|\n)[^:\n]+:\s*([A-Za-z0-9_.+\-/]+):\s*not found\b/i,
  /'([^']+)'\s+is not recognized as an internal or external command/i,
];

function alternativesForMissingCommand(command: string): ExecutionAlternative[] {
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? command.toLowerCase();
  if (base === "rg" || base === "rg.exe") {
    return [
      { tool: "code_search", reason: "Project-confined search works without granting external rg permission." },
      { tool: "command_list", reason: "Inspect the current shell PATH and binary inventory." },
    ];
  }
  if (["node", "node.exe", "npm", "npm.cmd", "npx", "npx.cmd", "make", "flutter"].includes(base)) {
    return [
      { tool: "command_list", reason: "Inspect discovered project commands and the runtime binary inventory." },
      { tool: "command_run", reason: "Run an allowlisted manifest command through the verified command runner." },
    ];
  }
  if (["git", "git.exe"].includes(base)) {
    return [
      { tool: "repo_status", reason: "Inspect repository state without relying on a shell Git lookup." },
      { tool: "Git tools", reason: "Use the dedicated project-confined Git operations." },
    ];
  }
  return [
    { tool: "command_list", reason: "Inspect available project commands and the current binary inventory." },
  ];
}

export function detectCommandNotFound(
  exitCode: number,
  stdout: string,
  stderr: string,
): CommandNotFoundHint | undefined {
  if (![1, 127, 9009].includes(exitCode)) return undefined;
  const text = `${stderr}\n${stdout}`;
  for (const pattern of COMMAND_NOT_FOUND_PATTERNS) {
    const match = pattern.exec(text);
    const command = match?.[1]?.trim();
    if (command) {
      return {
        command,
        alternatives: alternativesForMissingCommand(command),
      };
    }
  }
  return undefined;
}
