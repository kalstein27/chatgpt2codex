import { Script } from "node:vm";
import ts from "typescript";
import {
  CHATGPT_CONSENT_WIDGET_DIRECT_URI,
  CHATGPT_CONSENT_WIDGET_HTML,
  CHATGPT_CONSENT_WIDGET_LEGACY_URI,
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
import {
  CHATGPT_VISION_IMAGE_WIDGET_HTML,
  CHATGPT_VISION_IMAGE_WIDGET_URI,
} from "../server/chatgpt-vision-image-widget.js";

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

const UNRESOLVED_IDENTIFIER_DIAGNOSTIC_CODES = new Set([2304, 2552]);
const BINDING_COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  noImplicitAny: false,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.None,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
};
const BINDING_BASE_HOST = ts.createCompilerHost(BINDING_COMPILER_OPTIONS, true);
const BINDING_LIB_SOURCE_CACHE = new Map<string, ts.SourceFile | undefined>();
const VALIDATED_INLINE_SCRIPT_BINDINGS = new Set<string>();

function bindingLibrarySourceFile(
  name: string,
  languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
  onError?: (message: string) => void,
  shouldCreateNewSourceFile?: boolean,
): ts.SourceFile | undefined {
  if (!BINDING_LIB_SOURCE_CACHE.has(name)) {
    BINDING_LIB_SOURCE_CACHE.set(
      name,
      BINDING_BASE_HOST.getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile),
    );
  }
  return BINDING_LIB_SOURCE_CACHE.get(name);
}

export function validateInlineScriptBindings(target: ChatGptWidgetValidationTarget): void {
  const scripts = extractInlineWidgetScripts(target.html);
  scripts.forEach((script, index) => {
    if (VALIDATED_INLINE_SCRIPT_BINDINGS.has(script)) return;
    const fileName = `/__c2ct_widget_${target.name}_${index + 1}.js`;
    const sourceFile = ts.createSourceFile(fileName, script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    const host: ts.CompilerHost = {
      ...BINDING_BASE_HOST,
      fileExists: (name) => name === fileName || BINDING_BASE_HOST.fileExists(name),
      readFile: (name) => name === fileName ? script : BINDING_BASE_HOST.readFile(name),
      getSourceFile: (name, languageVersion, onError, shouldCreateNewSourceFile) =>
        name === fileName
          ? sourceFile
          : bindingLibrarySourceFile(name, languageVersion, onError, shouldCreateNewSourceFile),
    };
    const program = ts.createProgram([fileName], BINDING_COMPILER_OPTIONS, host);
    const unresolved = program.getSemanticDiagnostics(sourceFile).filter((diagnostic) =>
      UNRESOLVED_IDENTIFIER_DIAGNOSTIC_CODES.has(diagnostic.code)
    );
    if (unresolved.length > 0) {
      const diagnostic = unresolved[0]!;
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
      const location = position ? `:${position.line + 1}:${position.character + 1}` : "";
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      throw new Error(`ChatGPT widget ${target.name} has an unresolved inline JavaScript binding${location}: ${message}`);
    }
    VALIDATED_INLINE_SCRIPT_BINDINGS.add(script);
  });
}

export const SHIPPED_CHATGPT_WIDGETS: readonly ChatGptWidgetValidationTarget[] = [
  { name: "legacy-consent-loader", html: CHATGPT_CONSENT_WIDGET_LOADER_HTML, resourceUri: CHATGPT_CONSENT_WIDGET_LEGACY_URI },
  { name: "shared-consent-and-shell-loader", html: CHATGPT_CONSENT_WIDGET_LOADER_HTML, resourceUri: CHATGPT_CONSENT_WIDGET_URI },
  { name: "shared-consent-direct", html: CHATGPT_CONSENT_WIDGET_HTML, resourceUri: CHATGPT_CONSENT_WIDGET_DIRECT_URI },
  { name: "operation-approval", html: CHATGPT_OPERATION_APPROVAL_WIDGET_HTML, resourceUri: CHATGPT_OPERATION_APPROVAL_WIDGET_URI },
  { name: "capability-lab", html: CHATGPT_WIDGET_CAPABILITY_LAB_HTML, resourceUri: CHATGPT_WIDGET_CAPABILITY_LAB_URI },
  { name: "e2e-screenshot", html: E2E_SCREENSHOT_WIDGET_HTML, resourceUri: E2E_SCREENSHOT_WIDGET_URI },
  { name: "vision-image", html: CHATGPT_VISION_IMAGE_WIDGET_HTML, resourceUri: CHATGPT_VISION_IMAGE_WIDGET_URI },
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
  if (html.includes("[REDACTED]")) {
    throw new Error(`ChatGPT widget ${target.name} contains a literal redaction placeholder`);
  }
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
  validateInlineScriptBindings(target);
  validateLiteralDomIdReferences(target);
  return scripts.length;
}

export function validateShippedChatGptWidgets(): ChatGptWidgetValidationSummary {
  if (
    CHATGPT_OPERATION_APPROVAL_WIDGET_HTML === CHATGPT_CONSENT_WIDGET_LOADER_HTML
    || CHATGPT_OPERATION_APPROVAL_WIDGET_HTML.includes("chatgpt_widget_asset_get")
  ) {
    throw new Error("ChatGPT operation approval must remain a self-contained widget without loader asset fetches");
  }
  let scriptCount = 0;
  for (const target of SHIPPED_CHATGPT_WIDGETS) {
    scriptCount += validateChatGptWidgetHtml(target);
  }
  return { widgetCount: SHIPPED_CHATGPT_WIDGETS.length, scriptCount };
}
