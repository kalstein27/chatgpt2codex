import { Script } from "node:vm";
import {
  CHATGPT_CONSENT_WIDGET_HTML,
  CHATGPT_CONSENT_WIDGET_LOADER_HTML,
  CHATGPT_CONSENT_WIDGET_URI,
  CHATGPT_OPERATION_APPROVAL_WIDGET_HTML,
  CHATGPT_OPERATION_APPROVAL_WIDGET_URI,
} from "../server/chatgpt-consent-widget.js";
import {
  CHATGPT_WIDGET_CAPABILITY_LAB_HTML,
  CHATGPT_WIDGET_CAPABILITY_LAB_URI,
} from "../server/chatgpt-widget-capability-lab.js";
import { E2E_SCREENSHOT_WIDGET_HTML, E2E_SCREENSHOT_WIDGET_URI } from "../server/e2e-screenshot-widget.js";

export interface ChatGptWidgetValidationTarget {
  name: string;
  html: string;
  resourceUri?: string;
}

export interface ChatGptWidgetValidationSummary {
  widgetCount: number;
  scriptCount: number;
}

const HTML_ID_PATTERN = /\bid\s*=\s*["']([^"']+)["']/giu;
const WIDGET_RESOURCE_URI_PATTERN = /^ui:\/\/widget\/[A-Za-z0-9][A-Za-z0-9._-]*\.html$/u;
const LITERAL_DOM_ID_REFERENCE_PATTERNS = [
  /\bdocument\.getElementById\(\s*["']([^"']+)["']\s*\)/gu,
  /\bdocument\.querySelector(?:All)?\(\s*["']#([A-Za-z][A-Za-z0-9_.:-]*)["']\s*\)/gu,
] as const;

export const SHIPPED_CHATGPT_WIDGETS: readonly ChatGptWidgetValidationTarget[] = [
  { name: "consent-loader", html: CHATGPT_CONSENT_WIDGET_LOADER_HTML, resourceUri: CHATGPT_CONSENT_WIDGET_URI },
  { name: "shared-consent-and-shell", html: CHATGPT_CONSENT_WIDGET_HTML, resourceUri: CHATGPT_CONSENT_WIDGET_URI },
  { name: "operation-approval", html: CHATGPT_OPERATION_APPROVAL_WIDGET_HTML, resourceUri: CHATGPT_OPERATION_APPROVAL_WIDGET_URI },
  { name: "capability-lab", html: CHATGPT_WIDGET_CAPABILITY_LAB_HTML, resourceUri: CHATGPT_WIDGET_CAPABILITY_LAB_URI },
  { name: "e2e-screenshot", html: E2E_SCREENSHOT_WIDGET_HTML, resourceUri: E2E_SCREENSHOT_WIDGET_URI },
] as const;

export function extractInlineWidgetScripts(html: string): string[] {
  return Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu),
    (match) => match[1] ?? "",
  );
}

export function validateLiteralDomIdReferences(target: ChatGptWidgetValidationTarget): void {
  const declaredIds = new Set(
    Array.from(target.html.matchAll(HTML_ID_PATTERN), (match) => match[1] ?? "").filter(Boolean),
  );
  const scripts = extractInlineWidgetScripts(target.html);
  for (const script of scripts) {
    for (const pattern of LITERAL_DOM_ID_REFERENCE_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of script.matchAll(pattern)) {
        const referencedId = match[1] ?? "";
        if (referencedId && !declaredIds.has(referencedId)) {
          throw new Error(`ChatGPT widget ${target.name} references missing DOM id: ${referencedId}`);
        }
      }
    }
  }
}

export function validateWidgetResourceUri(target: ChatGptWidgetValidationTarget): void {
  if (target.resourceUri !== undefined && !WIDGET_RESOURCE_URI_PATTERN.test(target.resourceUri)) {
    throw new Error(`ChatGPT widget ${target.name} has malformed resource URI: ${target.resourceUri}`);
  }
}

export function validateChatGptWidgetHtml(target: ChatGptWidgetValidationTarget): number {
  const html = target.html.trim();
  if (!/^<!doctype html>/iu.test(html)) {
    throw new Error(`ChatGPT widget ${target.name} is missing an HTML doctype`);
  }
  if (!html.includes("<html") || !html.includes("</html>")) {
    throw new Error(`ChatGPT widget ${target.name} has an incomplete HTML document`);
  }
  validateWidgetResourceUri(target);

  const scripts = extractInlineWidgetScripts(html);
  if (scripts.length === 0) {
    throw new Error(`ChatGPT widget ${target.name} has no inline script to validate`);
  }

  scripts.forEach((script, index) => {
    try {
      new Script(script, { filename: `${target.name}#inline-script-${index + 1}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ChatGPT widget ${target.name} has invalid inline JavaScript: ${message}`);
    }
  });
  validateLiteralDomIdReferences(target);
  return scripts.length;
}

export function validateShippedChatGptWidgets(): ChatGptWidgetValidationSummary {
  let scriptCount = 0;
  for (const target of SHIPPED_CHATGPT_WIDGETS) {
    scriptCount += validateChatGptWidgetHtml(target);
  }
  return { widgetCount: SHIPPED_CHATGPT_WIDGETS.length, scriptCount };
}
