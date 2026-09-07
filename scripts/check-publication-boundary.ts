import { gitPublicationAudit } from "../src/git/git.js";

const root = process.cwd();
const audit = await gitPublicationAudit(root);

const result = {
  ok: audit.safeForCommit && audit.safeForPush,
  safeForCommit: audit.safeForCommit,
  safeForPush: audit.safeForPush,
  upstream: audit.upstream,
  pushCandidateCount: audit.pushCandidateCount,
  workingBlockedPaths: audit.workingBlockedPaths,
  stagedBlockedPaths: audit.stagedBlockedPaths,
  pushBlockedPaths: audit.pushBlockedPaths,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
