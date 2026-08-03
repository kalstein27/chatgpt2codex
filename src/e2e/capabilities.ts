import { DomainError, ErrorCode } from "../types.js";

/**
 * These tools currently depend on macOS-only commands in local-e2e.ts
 * (/usr/bin/open, screencapture, osascript, and /bin/zsh).
 */
export const NATIVE_E2E_TOOL_NAMES: ReadonlySet<string> = new Set([
  "e2e_start_server",
  "e2e_open_target",
  "e2e_run_command",
  "e2e_test_and_show_screenshot",
  "e2e_screenshot",
  "e2e_open_url_screenshot",
]);

export function isNativeE2eSupported(platform = process.platform): boolean {
  return platform === "darwin";
}

export function requireNativeE2eSupport(platform = process.platform): void {
  if (isNativeE2eSupported(platform)) return;
  throw new DomainError(
    ErrorCode.PLATFORM_UNSUPPORTED,
    `Native E2E capture is not available on ${platform}. Use command_run or local_shell_run for verification.`,
    {
      platform,
      supportedPlatforms: ["darwin"],
      alternatives: ["command_run", "local_shell_run"],
    },
  );
}
