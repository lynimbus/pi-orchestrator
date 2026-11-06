#!/usr/bin/env node
/**
 * Exhaustive bounded state-space verifier for Pi Orchestrator's wave integration,
 * crash reconciliation, retry, and rollback protocol (`WaveIntegrationSafety`).
 *
 * Imports and executes the real decision/reconciliation functions from
 * `../../../../integration-state.ts` across every reachable interleaving of the
 * atomic persistence steps in `../../../../index.ts` and `../../../../layerfs-engine.ts`.
 *
 * Run from the repo root:
 *   node .agents/skills/verify-wave-integration/scripts/verify-wave-integration.ts
 */

import {
	decideIntegrationAction,
	decideRetryIntegrationAction,
	decideRollbackIntegrationAction,
	reconcileIntegrationRecord,
} from "../../../../integration-state.ts";
import type {
	OrchestrationPlan,
	OrchestratorPhase,
	TaskRecord,
	TaskStatus,
	WaveIntegrationRecord,
} from "../../../../types.ts";

type PreMergeTaskStatus = "approved" | "escalated";

interface ModelState {
	/** Persisted OrchestrationPlan state on disk (`persistState()` in index.ts) */
	plan: OrchestrationPlan;
	/** Persisted LayerFS store metadata head (`meta.headLayerId` in layerfs-engine.ts) */
	headLayerId: string;
	/** Monotonic layer counter (`meta.layerSequence` in layerfs-engine.ts) */
	layerSequence: number;
	/** True while an `orch_integrate` or `orch_retry_integration` call is mid-flight in memory */
	inFlightCall: "none" | "integrate_started" | "integrate_layer_published" | "integrate_plan_merged" | "integrate_post_test_imported";
	/** In-memory local variable `parentLayerId` inside `orch_integrate` (index.ts:1178) */
	inFlightParentLayerId?: string;
	/** In-memory local variable `mergeResult.publishedLayerId` inside `orch_integrate` (index.ts:1251) */
	inFlightPublishedLayerId?: string;
	/** Ground-truth wave base layer before the current wave integration attempt began */
	waveStartLayerId: string;
	/** Ground-truth task statuses for the current wave before the current integration attempt began */
	waveStartTaskStatuses: Record<string, PreMergeTaskStatus>;
	/** Number of waves merged so far + rollback cycles used (for bounding) */
	rollbackCount: number;
	crashCount: number;
	/** True once the current wave attempt has published a layer into LayerFS (until rolled back) */
	waveHasPublishedLayer: boolean;
}

interface TraceStep {
	action: string;
	codeRef: string;
	summary: string;
}

interface Violation {
	clause: "NoDoubleMerge" | "NoRecoveryDeadlock" | "RollbackPreservesTaskStatuses";
	headline: string;
	harm: string;
	stateSummary: string;
	trace: TraceStep[];
}

const MAX_ROLLBACKS = 2;
const MAX_CRASHES = 2;
const MAX_LAYER_SEQ = 6;

function cloneState(s: ModelState): ModelState {
	return structuredClone(s);
}

function makeInitialState(
	waves: string[][],
	initialTaskStatuses: Record<string, PreMergeTaskStatus>,
): ModelState {
	const tasks: Record<string, TaskRecord> = {};
	for (let w = 0; w < waves.length; w++) {
		for (const id of waves[w]) {
			const status: TaskStatus = w === 0 ? initialTaskStatuses[id] : "pending";
			tasks[id] = {
				spec: {
					id,
					title: `Task ${id}`,
					description: "",
					dependsOn: [],
					allowedFiles: [`${id}.ts`],
					testFiles: [`${id}.test.ts`],
					testCommand: "true",
					interfaceContract: "",
					acceptanceCriteria: [],
					requiredTestCases: [],
				},
				state: {
					id,
					wave: w + 1,
					status,
					attempts: 1,
					branchName: `task-${id.toLowerCase()}`,
					baseLayerId: "L1",
					reviewHistory: [],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						cost: 0,
						contextTokens: 0,
						turns: 0,
					},
				},
			};
		}
	}

	const wave0Statuses: Record<string, PreMergeTaskStatus> = {};
	for (const id of waves[0]) {
		wave0Statuses[id] = initialTaskStatuses[id];
	}

	return {
		plan: {
			planId: "plan-verify",
			goal: "Verify WaveIntegrationSafety",
			createdAt: 0,
			phase: "READY_TO_INTEGRATE",
			wave0Files: [],
			wave0Completed: true,
			integrationTestCommand: "npm test",
			waves,
			currentWaveIndex: 0,
			baseLayerId: "L1",
			projectId: "proj-verify",
			tasks,
			integration: undefined,
		},
		headLayerId: "L1",
		layerSequence: 1,
		inFlightCall: "none",
		waveStartLayerId: "L1",
		waveStartTaskStatuses: wave0Statuses,
		rollbackCount: 0,
		crashCount: 0,
		waveHasPublishedLayer: false,
	};
}

function canonicalKey(s: ModelState): string {
	const waveIds = s.plan.waves[s.plan.currentWaveIndex] ?? [];
	const taskSnapshot = waveIds.map((id) => `${id}:${s.plan.tasks[id]?.state.status}:${s.plan.tasks[id]?.state.baseLayerId}`);
	const rec: Partial<WaveIntegrationRecord> | undefined = s.plan.integration
		? {
				status: s.plan.integration.status,
				waveIndex: s.plan.integration.waveIndex,
				attempts: s.plan.integration.attempts,
				publishedLayerId: s.plan.integration.publishedLayerId,
				parentLayerId: s.plan.integration.parentLayerId,
				taskStatusesBeforeMerge: s.plan.integration.taskStatusesBeforeMerge,
			}
		: undefined;
	return JSON.stringify({
		phase: s.plan.phase,
		waveIdx: s.plan.currentWaveIndex,
		wavesLen: s.plan.waves.length,
		baseLayerId: s.plan.baseLayerId,
		headLayerId: s.headLayerId,
		layerSequence: s.layerSequence,
		inFlightCall: s.inFlightCall,
		inFlightParentLayerId: s.inFlightParentLayerId,
		inFlightPublishedLayerId: s.inFlightPublishedLayerId,
		waveStartLayerId: s.waveStartLayerId,
		waveStartTaskStatuses: s.waveStartTaskStatuses,
		rollbackCount: s.rollbackCount,
		crashCount: s.crashCount,
		waveHasPublishedLayer: s.waveHasPublishedLayer,
		tasks: taskSnapshot,
		rec,
	});
}

function formatState(s: ModelState): string {
	const waveIds = s.plan.waves[s.plan.currentWaveIndex] ?? [];
	const tasksStr = waveIds
		.map((id) => `${id}=${s.plan.tasks[id]?.state.status}`)
		.join(", ");
	const rec = s.plan.integration;
	const recStr = rec
		? `{status=${rec.status}, parentLayerId=${rec.parentLayerId ?? "undefined"}, publishedLayerId=${rec.publishedLayerId ?? "undefined"}, taskStatusesBeforeMerge=${JSON.stringify(rec.taskStatusesBeforeMerge)}}`
		: "undefined";
	return [
		`plan.phase=${s.plan.phase}`,
		`plan.baseLayerId=${s.plan.baseLayerId}`,
		`store.headLayerId=${s.headLayerId}`,
		`waveTasks=[${tasksStr}]`,
		`plan.integration=${recStr}`,
	].join(" | ");
}

/**
 * Check all three clauses of `WaveIntegrationSafety` on state `s`.
 */
function checkStateInvariants(
	s: ModelState,
	trace: TraceStep[],
	violations: Map<Violation["clause"], Violation>,
): void {
	// Only evaluate external tool-entry invariants when no tool call is mid-flight in memory
	if (s.inFlightCall !== "none") return;

	// Clause 1: NoDoubleMerge
	// `decideIntegrationAction(plan, headLayerId)` may ONLY permit `"merge"` when:
	//   (a) the current wave has not already published a layer without rolling back,
	//   (b) the LayerFS store head matches `plan.baseLayerId`, and
	//   (c) `plan.phase === "READY_TO_INTEGRATE"` with no active/completed integration record.
	const decision = decideIntegrationAction(s.plan, s.headLayerId);
	if (
		decision.action === "merge" &&
		(s.waveHasPublishedLayer ||
			s.headLayerId !== s.plan.baseLayerId ||
			s.plan.phase !== "READY_TO_INTEGRATE") &&
		!violations.has("NoDoubleMerge")
	) {
		violations.set("NoDoubleMerge", {
			clause: "NoDoubleMerge",
			headline:
				"decideIntegrationAction returned 'merge' when the wave already published a Layer or store.headLayerId !== plan.baseLayerId.",
			harm:
				"Merging stale wave branches against an already-published or diverged LayerFS head overwrites or deletes files on the host working tree.",
			stateSummary: formatState(s),
			trace,
		});
	}

	// Clause 2: NoRecoveryDeadlock
	// Whenever the orchestrator rests in `INTEGRATION_FAILED`, at least one recovery tool
	// (`orch_retry_integration` or `orch_rollback_integration`) must be allowed.
	if (s.plan.phase === "INTEGRATION_FAILED") {
		const retryDecision = decideRetryIntegrationAction(s.plan, s.headLayerId);
		const rollbackDecision = decideRollbackIntegrationAction(s.plan, s.headLayerId);
		const integrateDecision = decideIntegrationAction(s.plan, s.headLayerId);
		if (
			!retryDecision.allowed &&
			!rollbackDecision.allowed &&
			integrateDecision.action !== "merge" &&
			!violations.has("NoRecoveryDeadlock")
		) {
			violations.set("NoRecoveryDeadlock", {
				clause: "NoRecoveryDeadlock",
				headline:
					`Plan is wedged in INTEGRATION_FAILED: retry blocked ("${retryDecision.reason}"), ` +
					`rollback blocked ("${rollbackDecision.reason}"), and integrate is ${integrateDecision.action}.`,
				harm:
					"After a crash during post-test host sync, the user cannot retry tests, roll back the wave, or re-integrate; the active plan is permanently deadlocked.",
				stateSummary: formatState(s),
				trace,
			});
		}
	}
}

/**
 * Generate all next states from `s`, corresponding 1-to-1 with atomic steps in
 * `index.ts`, `integration-state.ts`, and `layerfs-engine.ts`.
 */
function nextStates(
	s: ModelState,
	trace: TraceStep[],
	violations: Map<Violation["clause"], Violation>,
): Array<{ state: ModelState; trace: TraceStep[] }> {
	const out: Array<{ state: ModelState; trace: TraceStep[] }> = [];

	const pushStep = (next: ModelState, step: TraceStep) => {
		out.push({ state: next, trace: [...trace, step] });
	};

	// =========================================================================
	// Crash & restart transitions (`reconcileIntegrationState` in index.ts:276-281
	// calling `reconcileIntegrationRecord` in integration-state.ts:64-101)
	// A process crash can happen at any point while `inFlightCall !== "none"`.
	// =========================================================================
	if (s.inFlightCall !== "none" && s.crashCount < MAX_CRASHES) {
		const crashed = cloneState(s);
		crashed.inFlightCall = "none";
		crashed.inFlightParentLayerId = undefined;
		crashed.inFlightPublishedLayerId = undefined;
		crashed.crashCount += 1;

		// On restart, index.ts:277 calls `reconcileIntegrationRecord(activePlan, engine.getHeadLayerId())`
		reconcileIntegrationRecord(crashed.plan, crashed.headLayerId);

		pushStep(crashed, {
			action: "CrashAndReconcileOnRestart",
			codeRef: "index.ts:276-281 -> integration-state.ts:64-101 (reconcileIntegrationRecord)",
			summary: `Process crashes and restarts; reconcileIntegrationRecord(plan, "${crashed.headLayerId}") runs -> phase=${crashed.plan.phase}, publishedLayerId=${crashed.plan.integration?.publishedLayerId ?? "undefined"}`,
		});
	}

	// =========================================================================
	// In-flight `orch_integrate` steps (index.ts:1120-1335)
	// =========================================================================
	if (s.inFlightCall === "none") {
		// External/out-of-band store head advancement while in READY_TO_INTEGRATE
		// (e.g., an external LayerFS import or stale plan state where store.headLayerId !== plan.baseLayerId)
		if (
			s.plan.phase === "READY_TO_INTEGRATE" &&
			s.headLayerId === s.plan.baseLayerId &&
			s.layerSequence < MAX_LAYER_SEQ
		) {
			const diverged = cloneState(s);
			diverged.layerSequence += 1;
			diverged.headLayerId = `L${diverged.layerSequence}`;
			diverged.waveHasPublishedLayer = true;
			pushStep(diverged, {
				action: "StoreHeadDivergesFromPlanBase",
				codeRef: "integration-state.ts:45-52 (headLayerId !== plan.baseLayerId guard)",
				summary: `LayerFS store head advances to ${diverged.headLayerId} while plan.baseLayerId remains ${diverged.plan.baseLayerId}`,
			});
		}

		const decision = decideIntegrationAction(s.plan, s.headLayerId);
		if (decision.action === "merge") {
			// Step 1 of `orch_integrate` (index.ts:1178-1190):
			// Sets `plan.phase = "INTEGRATING"` and `plan.integration = { status: "running", parentLayerId, ... }`,
			// then calls `persistState()`.
			const next = cloneState(s);
			const waveIdx = next.plan.currentWaveIndex;
			const parentLayerId = next.plan.baseLayerId || next.headLayerId;
			next.plan.phase = "INTEGRATING";
			next.plan.integration = {
				status: "running",
				waveIndex: waveIdx,
				startedAt: 1,
				updatedAt: 1,
				attempts: 1,
				parentLayerId,
				testCommand: next.plan.integrationTestCommand,
			};
			next.inFlightCall = "integrate_started";
			next.inFlightParentLayerId = parentLayerId;
			pushStep(next, {
				action: "BeginIntegratePersistRunning",
				codeRef: "index.ts:1178-1190 (orch_integrate -> persistState)",
				summary: `orch_integrate starts on Wave ${waveIdx + 1} (parentLayerId=${parentLayerId}); persists phase=INTEGRATING, integration.status=running`,
			});
		}
	} else if (s.inFlightCall === "integrate_started") {
		// Branch 2a: `mergeAndPublishWave` fails with conflict/error before publishing a layer (index.ts:1207-1248)
		{
			const failed = cloneState(s);
			failed.plan.phase = "READY_TO_INTEGRATE";
			failed.plan.integration = {
				...failed.plan.integration!,
				status: "merge_failed",
				lastError: "Unresolved merge conflicts",
				updatedAt: 2,
			};
			failed.inFlightCall = "none";
			failed.inFlightParentLayerId = undefined;
			pushStep(failed, {
				action: "MergeFailureBeforePublish",
				codeRef: "index.ts:1227-1248 (orch_integrate merge_failed -> persistState)",
				summary: "mergeAndPublishWave reports conflict before publishing a Layer; phase returns to READY_TO_INTEGRATE",
			});
		}

		// Branch 2b: `mergeAndPublishWave` publishes new Layer `L{seq+1}` to LayerFS store and host (layerfs-engine.ts:1158-1174)
		if (s.layerSequence < MAX_LAYER_SEQ) {
			const published = cloneState(s);
			published.layerSequence += 1;
			const newLayerId = `L${published.layerSequence}`;
			published.headLayerId = newLayerId;
			published.inFlightCall = "integrate_layer_published";
			published.inFlightPublishedLayerId = newLayerId;
			published.waveHasPublishedLayer = true;
			pushStep(published, {
				action: "PublishWaveLayerToStore",
				codeRef: "layerfs-engine.ts:1158-1174 (mergeAndPublishWave -> saveMeta)",
				summary: `mergeAndPublishWave writes new Layer ${newLayerId} (parent ${s.inFlightParentLayerId}) and updates store headLayerId=${newLayerId}`,
			});
		}
	} else if (s.inFlightCall === "integrate_layer_published") {
		// Step 3 of `orch_integrate` (index.ts:1251-1255 + markWaveMerged at index.ts:1030-1039):
		// Sets `plan.integration.publishedLayerId`, calls `markWaveMerged`, and calls `persistState()`.
		const merged = cloneState(s);
		const pubId = merged.inFlightPublishedLayerId!;
		merged.plan.integration!.publishedLayerId = pubId;
		merged.plan.integration!.hostMatchesLayer = true;
		merged.plan.integration!.updatedAt = 3;

		const waveIds = merged.plan.waves[merged.plan.currentWaveIndex] ?? [];
		const before: Record<string, TaskStatus> = {};
		for (const id of waveIds) {
			before[id] = merged.plan.tasks[id].state.status;
			merged.plan.tasks[id].state.status = "merged";
		}
		merged.plan.baseLayerId = pubId;
		merged.plan.integration!.taskStatusesBeforeMerge = before;
		merged.inFlightCall = "integrate_plan_merged";
		pushStep(merged, {
			action: "PersistWaveMergedInPlan",
			codeRef: "index.ts:1030-1039, 1251-1255 (markWaveMerged + persistState)",
			summary: `markWaveMerged records publishedLayerId=${pubId} and taskStatusesBeforeMerge=${JSON.stringify(before)}, sets tasks to merged`,
		});
	} else if (s.inFlightCall === "integrate_plan_merged") {
		// Step 4a: Integration test runs without modifying host tracked files, and either passes or fails.
		// Step 4b: Integration test modifies tracked host files (`!verifyAfterTest.matches` at index.ts:1299),
		// causing `engine.importHostAsLayer` (index.ts:1301) to publish a post-test sync Layer `L{seq+1}` to the store
		// BEFORE `plan.integration.publishedLayerId` is updated and persisted at index.ts:1304-1318.
		if (s.layerSequence < MAX_LAYER_SEQ) {
			const postTestImported = cloneState(s);
			postTestImported.layerSequence += 1;
			const syncLayerId = `L${postTestImported.layerSequence}`;
			postTestImported.headLayerId = syncLayerId;
			postTestImported.inFlightCall = "integrate_post_test_imported";
			postTestImported.inFlightPublishedLayerId = syncLayerId;
			pushStep(postTestImported, {
				action: "PostTestImportHostLayerToStore",
				codeRef: "index.ts:1299-1303 -> layerfs-engine.ts:558-605 (importHostAsLayer -> saveMeta)",
				summary: `Integration test modified tracked host files; importHostAsLayer writes post-test sync Layer ${syncLayerId} (store headLayerId=${syncLayerId}) before plan.persistState()`,
			});
		}

		// Finish with test PASS (no host drift)
		pushStep(finishIntegratePass(s, false), {
			action: "FinishIntegrateTestPass",
			codeRef: "index.ts:1311-1315 -> index.ts:1041-1091 (finalizeWaveAfterPassingTests)",
			summary: "Integration test exits 0; finalizeWaveAfterPassingTests persists passed state",
		});

		// Finish with test FAIL (no host drift)
		pushStep(finishIntegrateFail(s, false), {
			action: "FinishIntegrateTestFail",
			codeRef: "index.ts:1317-1325 (orch_integrate test failed -> persistState)",
			summary: "Integration test exits non-zero; persists phase=INTEGRATION_FAILED, integration.status=failed",
		});
	} else if (s.inFlightCall === "integrate_post_test_imported") {
		// After `importHostAsLayer` updated `headLayerId`, `orch_integrate` updates `plan.baseLayerId`
		// and `plan.integration.publishedLayerId` in memory (index.ts:1304-1305) and persists pass or fail.
		pushStep(finishIntegratePass(s, true), {
			action: "FinishIntegrateTestPassAfterHostSync",
			codeRef: "index.ts:1304-1315 (postTestLayer sync + finalizeWaveAfterPassingTests)",
			summary: `Updates plan.baseLayerId and publishedLayerId to ${s.inFlightPublishedLayerId} and persists passed state`,
		});

		pushStep(finishIntegrateFail(s, true), {
			action: "FinishIntegrateTestFailAfterHostSync",
			codeRef: "index.ts:1304-1325 (postTestLayer sync + test failed -> persistState)",
			summary: `Updates plan.baseLayerId and publishedLayerId to ${s.inFlightPublishedLayerId} and persists phase=INTEGRATION_FAILED`,
		});
	}

	// =========================================================================
	// `orch_retry_integration` transitions (index.ts:1357-1435)
	// =========================================================================
	if (s.inFlightCall === "none") {
		const retryDecision = decideRetryIntegrationAction(s.plan, s.headLayerId);
		if (retryDecision.allowed) {
			// Retry passes (index.ts:1402-1408 -> finalizeWaveAfterPassingTests)
			{
				const retryPass = cloneState(s);
				retryPass.plan.phase = "INTEGRATING";
				retryPass.plan.integration!.status = "running";
				retryPass.plan.integration!.attempts += 1;
				const finalized = finalizeWaveInModel(retryPass);
				pushStep(finalized, {
					action: "RetryIntegrationPass",
					codeRef: "index.ts:1387-1408 (orch_retry_integration -> finalizeWaveAfterPassingTests)",
					summary: "orch_retry_integration re-runs tests without re-merging; tests pass",
				});
			}

			// Retry fails (index.ts:1410-1421)
			if ((s.plan.integration?.attempts ?? 1) < 2) {
				const retryFail = cloneState(s);
				retryFail.plan.integration!.attempts += 1;
				retryFail.plan.integration!.status = "failed";
				retryFail.plan.phase = "INTEGRATION_FAILED";
				pushStep(retryFail, {
					action: "RetryIntegrationFail",
					codeRef: "index.ts:1387-1421 (orch_retry_integration failed -> persistState)",
					summary: "orch_retry_integration re-runs tests; tests fail again, staying in INTEGRATION_FAILED",
				});
			}
		}
	}

	// =========================================================================
	// `orch_rollback_integration` transition (index.ts:1456-1505)
	// =========================================================================
	if (s.inFlightCall === "none" && s.rollbackCount < MAX_ROLLBACKS) {
		const rollbackDecision = decideRollbackIntegrationAction(s.plan, s.headLayerId);
		if (rollbackDecision.allowed) {
			const rolled = cloneState(s);
			const rec = rolled.plan.integration!;
			const targetParent = rec.parentLayerId;
			// `engine.rollbackPublishedLayer(rec.publishedLayerId, { targetParentLayerId: rec.parentLayerId })`
			// resets store headLayerId to targetParent (layerfs-engine.ts:1656-1657).
			rolled.headLayerId = targetParent ?? "";

			// index.ts:1475-1481 restores task statuses from `rec.taskStatusesBeforeMerge ?? {}`
			const before = rec.taskStatusesBeforeMerge ?? {};
			for (const id of rolled.plan.waves[rec.waveIndex] ?? []) {
				const task = rolled.plan.tasks[id];
				if (!task) continue;
				task.state.status = before[id] ?? "approved";
			}
			rolled.plan.baseLayerId = targetParent!;
			rolled.plan.integration = undefined;
			rolled.plan.phase = "READY_TO_INTEGRATE";
			rolled.rollbackCount += 1;
			rolled.waveHasPublishedLayer = false;

			const stepTrace: TraceStep = {
				action: "RollbackIntegration",
				codeRef: "index.ts:1469-1486 (orch_rollback_integration -> rollbackPublishedLayer + restore statuses)",
				summary: `orch_rollback_integration restores store headLayerId=${rolled.headLayerId}, plan.baseLayerId=${rolled.plan.baseLayerId}, and wave task statuses`,
			};
			const nextTrace = [...trace, stepTrace];

			// Clause 3 check (`RollbackPreservesTaskStatuses`):
			// Verify that every task in the wave recovered its exact pre-merge status (`approved` vs `escalated`)
			// and that `headLayerId` and `plan.baseLayerId` match `waveStartLayerId`.
			const waveIds = rolled.plan.waves[rolled.plan.currentWaveIndex] ?? [];
			const mismatchedTasks: string[] = [];
			for (const id of waveIds) {
				const actual = rolled.plan.tasks[id].state.status;
				const expected = rolled.waveStartTaskStatuses[id];
				if (actual !== expected) {
					mismatchedTasks.push(`${id}: expected "${expected}", got "${actual}"`);
				}
			}
			if (
				(mismatchedTasks.length > 0 ||
					rolled.headLayerId !== rolled.waveStartLayerId ||
					rolled.plan.baseLayerId !== rolled.waveStartLayerId) &&
				!violations.has("RollbackPreservesTaskStatuses")
			) {
				violations.set("RollbackPreservesTaskStatuses", {
					clause: "RollbackPreservesTaskStatuses",
					headline:
						mismatchedTasks.length > 0
							? `After orch_rollback_integration, wave task status changed (${mismatchedTasks.join("; ")}).`
							: `After orch_rollback_integration, layer head/base (${rolled.headLayerId}/${rolled.plan.baseLayerId}) did not return to ${rolled.waveStartLayerId}.`,
					harm:
						"When an 'escalated' task is silently reset to 'approved' on rollback, the next orch_integrate call sets includeHostEdits=false and drops the Lead Agent's direct host edits.",
					stateSummary: formatState(rolled),
					trace: nextTrace,
				});
			}

			out.push({ state: rolled, trace: nextTrace });
		}
	}

	return out;
}

function finishIntegratePass(s: ModelState, syncLayerImported: boolean): ModelState {
	const next = cloneState(s);
	if (syncLayerImported && next.inFlightPublishedLayerId) {
		next.plan.baseLayerId = next.inFlightPublishedLayerId;
		next.plan.integration!.publishedLayerId = next.inFlightPublishedLayerId;
	}
	next.inFlightCall = "none";
	next.inFlightParentLayerId = undefined;
	next.inFlightPublishedLayerId = undefined;
	return finalizeWaveInModel(next);
}

function finalizeWaveInModel(next: ModelState): ModelState {
	const plan = next.plan;
	const waveIdx = plan.currentWaveIndex;
	const rec = plan.integration!;
	rec.status = "passed";
	rec.updatedAt = 4;
	rec.lastError = undefined;

	if (waveIdx < plan.waves.length - 1) {
		const nextWave = waveIdx + 1;
		plan.currentWaveIndex = nextWave;
		plan.phase = "READY_TO_INTEGRATE"; // After Wave 2 tasks are dispatched & approved/escalated
		const nextWaveStatuses: Record<string, PreMergeTaskStatus> = {};
		for (const id of plan.waves[nextWave]) {
			plan.tasks[id].state.baseLayerId = plan.baseLayerId;
			plan.tasks[id].state.status = "approved";
			nextWaveStatuses[id] = "approved";
		}
		plan.integration = undefined;
		next.waveStartLayerId = plan.baseLayerId;
		next.waveStartTaskStatuses = nextWaveStatuses;
		next.waveHasPublishedLayer = false;
		return next;
	}

	plan.phase = "COMPLETED" as OrchestratorPhase;
	return next;
}

function finishIntegrateFail(s: ModelState, syncLayerImported: boolean): ModelState {
	const next = cloneState(s);
	if (syncLayerImported && next.inFlightPublishedLayerId) {
		next.plan.baseLayerId = next.inFlightPublishedLayerId;
		next.plan.integration!.publishedLayerId = next.inFlightPublishedLayerId;
	}
	next.plan.integration!.status = "failed";
	next.plan.integration!.lastError = "Integration test command exited with code 1";
	next.plan.phase = "INTEGRATION_FAILED";
	next.inFlightCall = "none";
	next.inFlightParentLayerId = undefined;
	next.inFlightPublishedLayerId = undefined;
	return next;
}

function runExhaustiveVerification(): number {
	const startTime = Date.now();
	const initialConfigs: Array<{
		label: string;
		waves: string[][];
		statuses: Record<string, PreMergeTaskStatus>;
	}> = [
		{
			label: "1-wave [T1=approved]",
			waves: [["T1"]],
			statuses: { T1: "approved" },
		},
		{
			label: "1-wave [T1=approved, T2=escalated]",
			waves: [["T1", "T2"]],
			statuses: { T1: "approved", T2: "escalated" },
		},
		{
			label: "2-wave [Wave1: T1=approved] -> [Wave2: T2=approved]",
			waves: [["T1"], ["T2"]],
			statuses: { T1: "approved", T2: "approved" },
		},
	];

	const visited = new Set<string>();
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [];
	const violations = new Map<Violation["clause"], Violation>();
	let transitionsExplored = 0;

	for (const cfg of initialConfigs) {
		const init = makeInitialState(cfg.waves, cfg.statuses);
		const key = canonicalKey(init);
		if (!visited.has(key)) {
			visited.add(key);
			queue.push({
				state: init,
				trace: [
					{
						action: "Init",
						codeRef: "index.ts:816-864 (orch_plan + orch_review -> READY_TO_INTEGRATE)",
						summary: `Initial configuration: ${cfg.label}, baseLayerId=L1, headLayerId=L1`,
					},
				],
			});
		}
	}

	while (queue.length > 0) {
		const current = queue.shift()!;
		checkStateInvariants(current.state, current.trace, violations);

		const successors = nextStates(current.state, current.trace, violations);
		for (const succ of successors) {
			transitionsExplored += 1;
			const key = canonicalKey(succ.state);
			if (!visited.has(key)) {
				visited.add(key);
				queue.push(succ);
			}
		}
	}

	const elapsedMs = Date.now() - startTime;
	const clauses: Array<{
		id: Violation["clause"];
		title: string;
		description: string;
	}> = [
		{
			id: "NoDoubleMerge",
			title: "NoDoubleMerge (Single-Merge Guard)",
			description:
				"A wave that has published a Layer never permits decideIntegrationAction === 'merge' unless rolled back first.",
		},
		{
			id: "NoRecoveryDeadlock",
			title: "NoRecoveryDeadlock (Recovery Progress from INTEGRATION_FAILED)",
			description:
				"Every reachable INTEGRATION_FAILED state permits at least one of orch_retry_integration or orch_rollback_integration.",
		},
		{
			id: "RollbackPreservesTaskStatuses",
			title: "RollbackPreservesTaskStatuses (Rollback Fidelity across Crashes)",
			description:
				"Rolling back an integration restores the wave's base layer and every task's pre-merge status ('approved' vs 'escalated').",
		},
	];

	console.log("================================================================================");
	console.log("Formal Verification: WaveIntegrationSafety (exhaustive bounded BFS model check)");
	console.log(`Bounds: waves<=2, tasks<=2 (approved|escalated), crashes<=${MAX_CRASHES}, rollbacks<=${MAX_ROLLBACKS}, layers<=${MAX_LAYER_SEQ}`);
	console.log(`Explored: ${visited.size} reachable states, ${transitionsExplored} transitions in ${elapsedMs}ms`);
	console.log("================================================================================\n");

	for (const c of clauses) {
		const v = violations.get(c.id);
		if (!v) {
			console.log(`PASS  [${c.id}] ${c.title}`);
			console.log(`      ${c.description}\n`);
		} else {
			console.log(`FAIL  [${c.id}] ${c.title}`);
			console.log(`      Finding : ${v.headline}`);
			console.log(`      Harm    : ${v.harm}`);
			console.log(`      State   : ${v.stateSummary}`);
			console.log(`      Shortest Counterexample (${v.trace.length - 1} steps):`);
			for (let i = 0; i < v.trace.length; i++) {
				const step = v.trace[i];
				console.log(`        ${i}. [${step.action}] (${step.codeRef})`);
				console.log(`           ${step.summary}`);
			}
			console.log("");
		}
	}

	if (violations.size > 0) {
		console.log(`Result: ${violations.size} of ${clauses.length} WaveIntegrationSafety clause(s) FAILED.`);
		return 1;
	}
	console.log(`Result: All ${clauses.length} WaveIntegrationSafety clauses PASSED.`);
	return 0;
}

process.exitCode = runExhaustiveVerification();
