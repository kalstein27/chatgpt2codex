import { DomainError, ErrorCode } from "../types.js";
import type { SavedImage } from "../assets/images.js";

export const MAX_CHATGPT_VISION_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ChatGptVisionImagePayload {
  model: {
    filePath: string;
    sha256: string;
    bytes: number;
    mime: "image/png" | "image/jpeg" | "image/webp";
    visionBridgeStatus: "awaiting-host-upload";
  };
  widget: {
    version: 1;
    dataUrl: string;
    fileName: string;
    mime: "image/png" | "image/jpeg" | "image/webp";
    sha256: string;
    bytes: number;
    prompt?: string;
  };
}

export function prepareChatGptVisionImagePayload(
  image: SavedImage & { data: string },
  prompt?: string,
): ChatGptVisionImagePayload {
  if (image.mime === "image/gif") {
    throw new DomainError(
      ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      "ChatGPT Vision bridge supports PNG, JPEG, and WebP images",
    );
  }
  if (image.bytes > MAX_CHATGPT_VISION_IMAGE_BYTES) {
    throw new DomainError(
      ErrorCode.FILE_TOO_LARGE,
      "Image exceeds the 4MB ChatGPT Vision bridge limit",
      { bytes: image.bytes },
    );
  }

  const fileName = image.filePath.split(/[\\/]/u).pop() || "c2ct-image";
  const mime = image.mime;
  return {
    model: {
      filePath: image.filePath,
      sha256: image.sha256,
      bytes: image.bytes,
      mime,
      visionBridgeStatus: "awaiting-host-upload",
    },
    widget: {
      version: 1,
      dataUrl: image.data,
      fileName,
      mime,
      sha256: image.sha256,
      bytes: image.bytes,
      ...(prompt ? { prompt } : {}),
    },
  };
}
