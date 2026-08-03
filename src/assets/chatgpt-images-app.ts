import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DomainError, ErrorCode } from "../types.js";

// execution-capability: macos-open-chatgpt-images
const promisifiedExecFile = promisify(execFile);

const execFileAsync: ExecFileLike = async (file, args, options) => {
  const result = await promisifiedExecFile(file, [...args], options);
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
};

export const CHATGPT_IMAGES_APP_URL = "https://chatgpt.com/images/";

export type ImagesAppBrowser = "default" | "chrome";

export interface PrepareChatGptImagesAppInput {
  prompt?: string;
  browser?: ImagesAppBrowser;
  pastePrompt?: boolean;
  submitPrompt?: boolean;
  confirmSubmit?: boolean;
}

export interface PrepareChatGptImagesAppResult {
  openedUrl: string;
  browser: ImagesAppBrowser;
  promptCopied: boolean;
  pasteAttempted: boolean;
  submitAttempted: boolean;
  next: string;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface PrepareChatGptImagesAppOptions {
  execFileImpl?: ExecFileLike;
  sleepMs?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openImagesApp(execFileImpl: ExecFileLike, browser: ImagesAppBrowser): Promise<void> {
  const args = browser === "chrome" ? ["-a", "Google Chrome", CHATGPT_IMAGES_APP_URL] : [CHATGPT_IMAGES_APP_URL];
  await execFileImpl("/usr/bin/open", args, { timeout: 10_000 });
}

export async function prepareChatGptImagesApp(
  input: PrepareChatGptImagesAppInput,
  opts: PrepareChatGptImagesAppOptions = {},
): Promise<PrepareChatGptImagesAppResult> {
  const execFileImpl = opts.execFileImpl ?? execFileAsync;
  const sleepMs = opts.sleepMs ?? defaultSleep;
  const browser = input.browser ?? "chrome";
  const prompt = input.prompt?.trim();
  const pastePrompt = Boolean(input.pastePrompt || input.submitPrompt);
  const submitPrompt = Boolean(input.submitPrompt);

  if (submitPrompt && input.confirmSubmit !== true) {
    throw new DomainError(
      ErrorCode.APPROVAL_REQUIRED,
      "submitPrompt requires confirmSubmit=true because it sends the prompt to ChatGPT Images.",
    );
  }
  if (pastePrompt || submitPrompt) {
    throw new DomainError(
      ErrorCode.INVALID_IMAGE_DATA,
      "Prompt paste/submit automation was removed. Open ChatGPT Images and paste the prompt manually.",
    );
  }
  if (pastePrompt && !prompt) {
    throw new DomainError(ErrorCode.INVALID_IMAGE_DATA, "pastePrompt requires a non-empty prompt.");
  }

  await openImagesApp(execFileImpl, browser);
  await sleepMs(200);

  const next = submitPrompt
    ? "Wait for ChatGPT Images to finish, then use Share/Copy Link, Copy Image, Save/Download, or save_chatgpt_image."
    : prompt
      ? "ChatGPT Images is open. Paste the prompt manually there, then call save_chatgpt_image."
      : "ChatGPT Images is open. Generate an image there, then call save_chatgpt_image.";

  return {
    openedUrl: CHATGPT_IMAGES_APP_URL,
    browser,
    promptCopied: false,
    pasteAttempted: false,
    submitAttempted: false,
    next,
  };
}
