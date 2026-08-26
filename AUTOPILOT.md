# Night Autopilot State

This file is the canonical handoff for unattended Codex night work in this repository.
Read `AGENTS.md` first, then this file. Native Codex should use its own local filesystem/search/shell/test/Git tools for ordinary repo work. Use C2CT only for C2CT-specific bridge, runtime, app, approval, or session operations.

## Operating mode

- Worker: GPT-5.6 Luna when available in the Codex automation UI.
- Trial mode is active for the first 3 automation wake-ups.
- `Trial completed runs` starts at 0. Increment it only after a wake-up reaches a terminal result and records that result here.
- For trial run 1, perform `Current step`. For trial run 2, perform the read-only dirty-worktree classification and record the groups here. For trial run 3, do not start a new risky feature: review the previous two run records, record whether the automation behaved correctly, then set `Status` to `TRIAL-PAUSED`.
- Once `Status` is `TRIAL-PAUSED`, later wake-ups must not inspect, edit, test, or advance work. They should return only that the trial is paused for supervised review.

- One automation run = exactly one atomic step.
- Prefer a small diff. If the next step is larger than roughly 80 changed lines or spans multiple concerns, split it and do only the first coherent slice.
- Preserve the existing dirty worktree. Never reset, clean, stash, or rewrite unrelated changes.
- Never commit, push, install/replace the macOS app, replace the runtime, prune snapshots, run destructive fault injection, or consume an approval unless the owner explicitly changed this file to allow that exact action.
- Never interfere with another agent/session's active work. If concurrent work or ownership is ambiguous, stop without mutation.
- Do not broaden scope just because nearby cleanup is visible.

## Quota-saving rules

- Do not rescan the whole repository every run.
- Start from `Current step`, inspect only the files needed for that step, and use narrow search when necessary.
- Prefer the smallest relevant test. Run full `npm:test` only at a milestone or when the step can affect broad behavior.
- Run `npm:typecheck` only when the change can affect TypeScript compilation or at a milestone.
- Do not use web research unless the current step actually depends on changing external facts.
- Do not spend a run producing a long plan. If the next safe action is clear, perform it and record the result here.

## Stop conditions

Stop and report without advancing when any of these is true:

- user/product decision is required;
- a destructive or locally approved operation is required;
- another session is actively working on the same scope;
- the next action would touch unrelated dirty files;
- a test fails for a reason that is not clearly caused by the current step;
- required UI/Screen Recording/Accessibility evidence cannot be collected unattended;
- requirements conflict or the safe next step is ambiguous.

When stopped, set `Status: BLOCKED` and write the exact blocker under `Last result`.

## Current goal

Finish the post-activity-dashboard cleanup and acceptance work without destabilizing the healthy live ChatGPT2Codex runtime.

## Status

ACTIVE

Trial completed runs: 0 / 3

## Completed baseline

- Activity dashboard/title/semantic-status changes are implemented and live.
- macOS app apply completed successfully.
- Runtime apply completed successfully and live runtime identity is complete.
- `npm:test` and `npm:typecheck` passed after the deployment.
- No ChatGPT2Codex lease or active operation was left behind after the last supervised session.

## Current step

Update the stale statement in `docs/CONNECTION-DIAGNOSTICS.ko.md` that says canonical RuntimeManifest identity is the next implementation priority. The canonical RuntimeManifest identity is already implemented and live, so change only that stale documentation claim. Do not perform the destructive watchdog fault-injection TODO in the same run.

## After current step

1. Mark the stale documentation step complete in this file.
2. Record the exact verification performed.
3. Select the next safe unattended step from `Remaining queue`.
4. Do not execute that next step until the next automation run.

## Remaining queue

- Review the accumulated dirty worktree read-only and classify changes into coherent feature groups without resetting, staging, committing, or editing unrelated files.
- UI visual acceptance of the installed activity dashboard. This is human/GUI-evidence dependent and must remain blocked if unattended evidence is unavailable.
- Watchdog hang/zombie destructive live fault-injection acceptance. `BLOCKED-HUMAN`: never run unattended.

## Last result

Prepared for first unattended night step. No night-worker step has run yet.
