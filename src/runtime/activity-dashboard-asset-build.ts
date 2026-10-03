import { ACTIVITY_DASHBOARD_HTML } from "../server/activity-dashboard.js";
import { emitCandidateActivityDashboardAsset } from "./activity-dashboard-assets.js";

async function main(): Promise<void> {
  const result = await emitCandidateActivityDashboardAsset({
    projectRoot: process.cwd(),
    html: ACTIVITY_DASHBOARD_HTML,
  });
  process.stdout.write(`activity-dashboard-asset=${result.revision}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
