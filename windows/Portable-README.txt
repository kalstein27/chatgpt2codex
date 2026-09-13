ChatGPT To Codex portable Windows bundle

1. Use the ZIP that matches this PC's CPU architecture (x64 or arm64), then extract the whole folder before running it. Do not run the EXE from inside the ZIP preview.
2. Launch "ChatGPT To Codex.exe" from the extracted folder. The first cold-boot window is intentionally a read-only log console; normal daily controls live in the shared desktop shell (Activity, Approvals, MCP / Connection, Settings, Diagnostics). The tray is a secondary reopen/quit/lifecycle/recovery surface.
3. The bundle includes its own Node runtime under runtime\node.exe and its own npm CLI under npm\bin\npm-cli.js.
4. System Node/npm are not required for normal portable runtime use or in-app package-script verification. A reboot or broken machine-wide npm install should not break the portable runtime.
5. Keep the folder structure intact. The launcher expects start-chatgpt.ps1, dist, node_modules, npm, and runtime beside the EXE. Copy or move the whole extracted folder, not individual files.
6. Loopback mode needs no public tunnel. ChatGPT web needs an externally reachable HTTPS connector.
7. A Tailscale Serve URL is tailnet-private. ChatGPT web requires Tailscale Funnel or another public HTTPS endpoint.
8. Treat Owner Token values like passwords and never include them in screenshots, logs, bug reports, or public issues.
9. If you are rebuilding from source, use windows\Build-And-Verify-Portable.cmd. Ordinary portable users do not need the source Node/npm toolchain or the repair helper.
