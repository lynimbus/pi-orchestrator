/**
 * Pure integration state-machine decisions.
 *
 * Kept free of Pi/LayerFS side effects so the P0 data-loss guard (a wave must
 * never be merged twice) can be covered by deterministic unit tests.
 */

import type { OrchestrationPlan } from "./types.ts";

export type IntegrationDecision =
	| { action: "merge"; reason: string }
	| { action: "no-op"; reason: string }
	| { action: "blocked"; reason: string };

/**
 * Decide what a call to `orch_integrate` is allowed to do.
 *
 * A wave that already published a Layer is NEVER merged again: the branches are
 * stale relative to the new head, and replaying their full trees would publish a
 * rollback Layer and erase the host working tree.
 */
export function decideIntegrationAction(
	plan: OrchestrationPlan,
	headLayerId: string,
): IntegrationDecision {
	const rec = plan.integration;
	if (rec && (rec.status === "passed" || rec.status === "failed")) {
		return {
			action: "no-op",
			reason:
				`Wave ${rec.waveIndex + 1} was already integrated (status: ${rec.status}, ` +
				`published Layer: ${rec.publishedLayerId ?? "none"}). ` +
				`Re-merging stale branches would publish a rollback Layer and erase host changes.`,
		};
	}
	if (rec?.status === "running") {
		return {
			action: "blocked",
			reason: "An integration is already in progress for this wave.",
		};
	}
	if (plan.phase !== "READY_TO_INTEGRATE") {
		return {
			action: "blocked",
			reason: `Current phase is ${plan.phase}, not READY_TO_INTEGRATE.`,
		};
	}
	if (headLayerId !== plan.baseLayerId) {
		return {
			action: "blocked",
			reason:
				`Plan base is ${plan.baseLayerId} but the store head is ${headLayerId}. ` +
				`The host/store diverged or this wave was already merged.`,
		};
	}
	return {
		action: "merge",
		reason: `Wave ${plan.currentWaveIndex + 1} is ready to merge from ${plan.baseLayerId}.`,
	};
}

/**
 * Reconcile an interrupted integration using the LayerFS head as the source of truth.
 *
 * A Layer may already have been published even when the persisted plan still says
 * `READY_TO_INTEGRATE` / `running`; in that case the wave MUST be marked as merged
 * and no second merge may be attempted.
 */
export function reconcileIntegrationRecord(
	plan: OrchestrationPlan,
	headLayerId: string,
): boolean {
	const rec = plan.integration;
	if (!rec || rec.status !== "running") return false;
	// If the head advanced beyond the pre-merge parent, a Layer was published even
	// if the process died before recording `publishedLayerId`.
	const published =
		rec.publishedLayerId ??
		(headLayerId !== rec.parentLayerId ? headLayerId : undefined);

	if (published && headLayerId === published) {
		for (const id of plan.waves[rec.waveIndex] ?? []) {
			const task = plan.tasks[id];
			if (task && task.state.status !== "merged") task.state.status = "merged";
		}
		plan.baseLayerId = published;
		rec.publishedLayerId = published;
		rec.status = "failed";
		rec.lastError =
			"Integration was interrupted after the Layer was published; the test result is unknown.";
		rec.updatedAt = Date.now();
		plan.phase = "INTEGRATION_FAILED";
		return true;
	}
	if (headLayerId === rec.parentLayerId) {
		// Nothing was published: safe to attempt the merge again.
		plan.integration = undefined;
		plan.phase = "READY_TO_INTEGRATE";
		return true;
	}
	rec.status = "failed";
	rec.publishedLayerId = rec.publishedLayerId ?? headLayerId;
	rec.lastError = `Store head (${headLayerId}) diverged from the integration record; refusing to merge again.`;
	rec.updatedAt = Date.now();
	plan.phase = "INTEGRATION_FAILED";
	return true;
}

/** `orch_retry_integration` may only re-run tests for a published, failed wave. */
export function decideRetryIntegrationAction(
	plan: OrchestrationPlan,
	headLayerId: string,
): { allowed: boolean; reason: string } {
	const rec = plan.integration;
	if (!rec || rec.status !== "failed" || !rec.publishedLayerId) {
		return {
			allowed: false,
			reason: `There is no failed, published integration to retry (phase ${plan.phase}).`,
		};
	}
	if (headLayerId !== rec.publishedLayerId) {
		return {
			allowed: false,
			reason: `Store head ${headLayerId} does not match the published Layer ${rec.publishedLayerId}.`,
		};
	}
	return { allowed: true, reason: `Re-running tests for Layer ${rec.publishedLayerId}.` };
}

/** `orch_rollback_integration` may only undo the latest published, failed wave. */
export function decideRollbackIntegrationAction(
	plan: OrchestrationPlan,
	headLayerId: string,
): { allowed: boolean; reason: string } {
	const rec = plan.integration;
	if (!rec?.publishedLayerId) {
		return { allowed: false, reason: "This plan has no published Layer to roll back." };
	}
	if (rec.status !== "failed") {
		return {
			allowed: false,
			reason: `Rollback is only offered while the integration is failed (current status: ${rec.status}).`,
		};
	}
	if (headLayerId !== rec.publishedLayerId) {
		return {
			allowed: false,
			reason: `Store head ${headLayerId} is not the published Layer ${rec.publishedLayerId}.`,
		};
	}
	return { allowed: true, reason: `Rolling back Layer ${rec.publishedLayerId}.` };
}
