import { validateShippedChatGptWidgets } from "./chatgpt-widget-validation.js";

try {
  const summary = validateShippedChatGptWidgets();
  process.stdout.write(
    `chatgpt-widget-validation=ok widgets=${summary.widgetCount} scripts=${summary.scriptCount}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
