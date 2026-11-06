---
name: verify-wave-integration
description: "Exhaustively model-check Pi Orchestrator's wave integration, crash reconciliation, retry, and rollback state machine (WaveIntegrationSafety). Use whenever modifying integration-state.ts, index.ts (orch_integrate, orch_retry_integration, orch_rollback_integration, reconcileIntegrationState, markWaveMerged, finalizeWaveAfterPassingTests), or layerfs-engine.ts (mergeAndPublishWave, importHostAsLayer, rollbackPublishedLayer)."
---

# Verify Wave Integration (`WaveIntegrationSafety`)

This skill runs an exhaustive bounded breadth-first state-space check directly against the real functions in `integration-state.ts` across every reachable interleaving of the persistence steps in `index.ts` and `layerfs-engine.ts`.

## Property & Harm

- **Property (`WaveIntegrationSafety`):** Across every sequence of `orch_integrate`, post-test host-sync layer imports, process crashes and `reconcileIntegrationRecord` restarts, `orch_retry_integration`, and `orch_rollback_integration`, a wave merges at most once from its base layer, never wedges in an unrecoverable `INTEGRATION_FAILED` state, and always restores every task's pre-merge status (`approved` vs `escalated`) and base layer on rollback.
- **Harm if broken:** Re-merging a wave against an already-published head layer overwrites or deletes files on the host working tree; a mismatched `publishedLayerId` after crash recovery permanently blocks `orch_integrate`, `orch_retry_integration`, and `orch_rollback_integration`; or rolling back after a crash turns an `escalated` task into `approved` so the next `orch_integrate` sets `includeHostEdits: false` and discards the Lead Agent's manual host edits.

The verifier checks three named clauses:
1. **`NoDoubleMerge`**: Once `PublishWaveLayerToStore` advances `headLayerId` past the wave's `parentLayerId`, `decideIntegrationAction(plan, headLayerId).action` is never `"merge"` unless `RollbackIntegration` has first reset `headLayerId` and `plan.baseLayerId` back to `parentLayerId`.
2. **`NoRecoveryDeadlock`**: In every reachable idle state where `plan.phase === "INTEGRATION_FAILED"`, at least one recovery tool (`decideRetryIntegrationAction` or `decideRollbackIntegrationAction`) is allowed.
3. **`RollbackPreservesTaskStatuses`**: Whenever `RollbackIntegration` returns a wave to `READY_TO_INTEGRATE`, every task in the wave has the exact `TaskStatus` (`"approved"` or `"escalated"`) it had before the integration attempt began, and `headLayerId === plan.baseLayerId === parentLayerId`.

## Coverage & Sync Record

- **Last verified sync commit:** `d4ce230a56c1475dd3d647cb518d09bb5abfb0ce`
- **Covered files and functions:**
  - `integration-state.ts`:
    - `decideIntegrationAction`
    - `reconcileIntegrationRecord`
    - `decideRetryIntegrationAction`
    - `decideRollbackIntegrationAction`
  - `index.ts`:
    - `reconcileIntegrationState` (session startup crash recovery)
    - `markWaveMerged`
    - `finalizeWaveAfterPassingTests`
    - `orch_integrate` (`execute` handler)
    - `orch_retry_integration` (`execute` handler)
    - `orch_rollback_integration` (`execute` handler)
  - `layerfs-engine.ts`:
    - `LayerFSEngine.mergeAndPublishWave` (head advancement & `expectedBaseLayerId` check)
    - `LayerFSEngine.importHostAsLayer` (post-test host sync layer `headLayerId` advancement)
    - `LayerFSEngine.rollbackPublishedLayer` (single- and multi-layer rollback to `targetParentLayerId`)
  - `types.ts`:
    - `OrchestrationPlan`, `WaveIntegrationRecord`, `OrchestratorPhase`, `TaskStatus`

Check whether any covered file changed since the sync commit before trusting a pass:

```sh
git diff d4ce230a56c1475dd3d647cb518d09bb5abfb0ce -- integration-state.ts index.ts layerfs-engine.ts types.ts
```

Move the sync commit forward in this `SKILL.md` **only** after you have inspected every diff in those covered files and confirmed that `scripts/verify-wave-integration.ts` accurately models all atomic persistence steps at the new commit.

## Run the Check

From the repository root (`/var/home/lynimbus/workspace/pi-orchestrator`), run:

```sh
node .agents/skills/verify-wave-integration/scripts/verify-wave-integration.ts
```

- **Runtime:** ~40–60 ms (Node.js native TypeScript execution, zero external dependencies).
- **Bounds:** `waves <= 2`, `tasks per wave <= 2` (`approved` and `escalated` combinations), `crashes <= 2`, `rollbacks <= 2`, `layerSequence <= 6` (1,821 reachable states, 2,414 transitions).

## Current Baseline & Open Findings at Sync Commit

At commit `d4ce230a56c1475dd3d647cb518d09bb5abfb0ce`:
- **`NoDoubleMerge`:** **PASS** across all 1,821 reachable states.
- **`NoRecoveryDeadlock`:** **FAIL (Open Finding 1)** — In `index.ts:1251-1255`, `orch_integrate` persists `rec.publishedLayerId = "L2"`. If the integration test modifies tracked host files (`!verifyAfterTest.matches` at `index.ts:1299`), `engine.importHostAsLayer` (`index.ts:1301`) advances the LayerFS store `headLayerId` to `"L3"` before `index.ts:1305` persists `rec.publishedLayerId = "L3"`. If the process crashes in that window and `reconcileIntegrationRecord(plan, "L3")` (`integration-state.ts:64-101`) runs on restart, line 70 sets `published = rec.publishedLayerId ?? ...` (`"L2"`), misses the `headLayerId === published` branch, and line 96 runs `rec.publishedLayerId = rec.publishedLayerId ?? headLayerId` which keeps `"L2"` instead of updating to `"L3"`. With `headLayerId = "L3"` and `rec.publishedLayerId = "L2"`, `decideRetryIntegrationAction`, `decideRollbackIntegrationAction`, and `decideIntegrationAction` all refuse to run.
- **`RollbackPreservesTaskStatuses`:** **FAIL (Open Finding 2)** — If the process crashes after `mergeAndPublishWave` updates `headLayerId = "L2"` (`layerfs-engine.ts:1166`) before `markWaveMerged` (`index.ts:1030-1039`) persists `rec.taskStatusesBeforeMerge`, `reconcileIntegrationRecord(plan, "L2")` (`integration-state.ts:74-77`) overwrites every wave task's `state.status` to `"merged"` without recording `rec.taskStatusesBeforeMerge`. When `orch_rollback_integration` (`index.ts:1475-1481`) subsequently rolls back the wave, `before[id] ?? "approved"` turns any `"escalated"` task into `"approved"`.

## Interpreting Results: Real Bug vs. Modeling Error

1. **Read the shortest counterexample trace printed by the script.** Every step names the transition (`[ActionName]`), the exact file and line range (`(index.ts:...)`), and the resulting state.
2. **Verify each step against the code:**
   - Open the cited lines in `integration-state.ts`, `index.ts`, or `layerfs-engine.ts`.
   - If every step in the trace corresponds to a real state transition between two disk writes (`saveMeta` in `layerfs-engine.ts` or `persistState` in `index.ts`) and the final state violates the property, **it is a real bug in the product code**.
   - If the code was intentionally refactored so that two steps in `scripts/verify-wave-integration.ts` are now persisted atomically, or a new phase/guard was added that prevents a transition the script still takes, **the model has drifted**.

## Updating the Verification After an Intentional Code Change

When a change to `integration-state.ts`, `index.ts`, or `layerfs-engine.ts` alters the state transitions:
1. Keep the direct imports from `../../../../integration-state.ts` so the verifier always executes the real guard and reconciliation functions.
2. Update `nextStates()` in `.agents/skills/verify-wave-integration/scripts/verify-wave-integration.ts` so each step matches one indivisible persistence step (`saveMeta` or `persistState`) in `index.ts` and `layerfs-engine.ts`.
3. Never weaken `NoDoubleMerge`, `NoRecoveryDeadlock`, or `RollbackPreservesTaskStatuses` to hide a failure.
4. Test that the verifier can still fail by temporarily removing a guard in `integration-state.ts`, confirming the script catches it, and reverting the temporary break.
5. Update the **Last verified sync commit** hash in this `SKILL.md`.

## Scope & What Is Not Covered

- **Covered:** The control-plane protocol between `OrchestrationPlan` persistence (`index.ts`), pure decision/reconciliation logic (`integration-state.ts`), and LayerFS `headLayerId` advancement/rollback (`layerfs-engine.ts`) up to 2 waves, 2 tasks per wave, 2 crashes, and 2 rollbacks.
- **Not covered:**
  - Multi-branch 3-way text merge line-hunk computation (`threeWayMergeText` and `mergeAndPublishWave` in `layerfs-engine.ts`).
  - Filesystem inode/stat-cache fingerprinting (`statCacheHit` in `layerfs-engine.ts`) and OS-level `fs.renameSync` crash atomicity.
