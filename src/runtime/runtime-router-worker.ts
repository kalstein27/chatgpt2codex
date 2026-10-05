import { appendRuntimeRouterDispatchLog, createRuntimeGenerationRouterServer } from "./runtime-generation-router.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const stateDir = flag("--state-dir");
const rawPort = flag("--port");
const host = flag("--host") ?? "127.0.0.1";
const logFile = flag("--dispatch-log");
const port = Number(rawPort);

if (!stateDir || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("runtime-router-worker requires --state-dir <path> --port <1-65535>");
}

const server = createRuntimeGenerationRouterServer({
  stateDir,
  host,
  port,
  onDispatch: logFile
    ? (dispatch, request) => {
        void appendRuntimeRouterDispatchLog(logFile, dispatch, request).catch(() => undefined);
      }
    : undefined,
});

const close = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
};
process.once("SIGTERM", close);
process.once("SIGINT", close);

server.listen(port, host);
