/**
 * Per-session orchestrator configuration.
 *
 * This module owns the ONE question that used to leak across sessions: which
 * `OrchestratorConfig` is live for the session that is starting right now.
 *
 * Why it exists: the agent-dir file (`orchestrator.json`) is shared by every
 * session, so a `--orch` flag applied in one session was written back into it
 * and switched on every session started afterwards. The session's own
 * `orchestrator-state` entry (already appended to the session JSONL) is the
 * correct per-session store; the agent-dir file is demoted to an optional
 * hand-edited defaults seed that the extension never writes.
 *
 * Precedence, lowest to highest:
 *
 *   DEFAULT_ORCHESTRATOR_CONFIG <- file defaults <- session entry <- CLI flags
 *
 * Everything here is pure: no filesystem access, no pi API calls, no mutation
 * of the caller's inputs, and no throws — malformed input degrades to the
 * defaults. Wiring into the extension (load / append / rebuild) belongs to
 * index.ts; parsing CLI flags also stays there, so flags arrive already parsed.
 */

import type { OrchestrationPlan, OrchestratorConfig } from "./types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Baseline config: everything off except the opt-in auto line merge. */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
	enabled: false,
	subagentModel: undefined,
	subagentThinkingLevel: undefined,
	maxConcurrency: 4,
	maxRetries: 2,
	requireHumanPlanApproval: false,
	requireHumanFinalApproval: false,
	allowAutoThreeWayLineMerge: true,
};

/** The per-session store shape carried by the session's `orchestrator-state` entry. */
export interface OrchestratorSessionState {
	config?: OrchestratorConfig;
	activePlan?: OrchestrationPlan | null;
}

const CONFIG_KEYS = [
	"enabled",
	"subagentModel",
	"subagentThinkingLevel",
	"maxConcurrency",
	"maxRetries",
	"requireHumanPlanApproval",
	"requireHumanFinalApproval",
	"allowAutoThreeWayLineMerge",
] as const;

const BOOLEAN_KEYS = [
	"requireHumanPlanApproval",
	"requireHumanFinalApproval",
	"allowAutoThreeWayLineMerge",
] as const;

const SESSION_STATE_TYPE = "custom";
const SESSION_STATE_CUSTOM_TYPE = "orchestrator-state";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
	const value = source[key];
	return typeof value === "boolean" ? value : undefined;
}

function readNonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number | undefined {
	const value = source[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Reads the optional hand-edited agent-dir defaults file. Absent, unreadable or
 * non-object content yields `undefined`; a valid object with nothing usable
 * yields `{}`. Legacy aliases (`model`, `thinkingLevel`, `concurrency`) are
 * mapped onto their canonical fields, and the canonical key wins when both are
 * present.
 *
 * `enabled` is ALWAYS dropped: honouring a shared file's on/off switch is
 * exactly the global-leak bug this module removes. A legacy file that still
 * says `"enabled": true` therefore seeds everything except the switch, and a
 * new session starts OFF unless its own session entry or the `--orch` flag
 * turns it on.
 */
export function parseDefaultsFile(raw: string): Partial<OrchestratorConfig> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		return undefined;
	}

	const result: Partial<OrchestratorConfig> = {};

	for (const key of BOOLEAN_KEYS) {
		const value = readBoolean(parsed, key);
		if (value !== undefined) {
			result[key] = value;
		}
	}

	const model = readNonEmptyString(parsed, "subagentModel") ?? readNonEmptyString(parsed, "model");
	if (model !== undefined) {
		result.subagentModel = model;
	}

	const thinkingLevel =
		readNonEmptyString(parsed, "subagentThinkingLevel") ?? readNonEmptyString(parsed, "thinkingLevel");
	if (thinkingLevel !== undefined) {
		result.subagentThinkingLevel = thinkingLevel as ThinkingLevel;
	}

	const concurrency = readFiniteNumber(parsed, "maxConcurrency") ?? readFiniteNumber(parsed, "concurrency");
	if (concurrency !== undefined) {
		result.maxConcurrency = concurrency;
	}

	const maxRetries = readFiniteNumber(parsed, "maxRetries");
	if (maxRetries !== undefined) {
		result.maxRetries = maxRetries;
	}

	return result;
}

function toSessionState(data: unknown): OrchestratorSessionState {
	if (!isPlainObject(data)) {
		return {};
	}
	const state: OrchestratorSessionState = {};
	if (isPlainObject(data.config)) {
		state.config = data.config as unknown as OrchestratorConfig;
	}
	if (data.activePlan !== undefined) {
		state.activePlan = (data.activePlan ?? null) as OrchestrationPlan | null;
	}
	return state;
}

/**
 * Scans session entries and returns the data of the LAST `orchestrator-state`
 * entry, or `undefined` when the session has none. Malformed entries are
 * skipped, and an entry with missing or non-object data contributes `{}`.
 */
export function readSessionState(entries: readonly unknown[]): OrchestratorSessionState | undefined {
	let found: OrchestratorSessionState | undefined;
	for (const entry of entries) {
		if (!isPlainObject(entry)) {
			continue;
		}
		if (entry.type !== SESSION_STATE_TYPE || entry.customType !== SESSION_STATE_CUSTOM_TYPE) {
			continue;
		}
		found = toSessionState(entry.data);
	}
	return found;
}

function applyLayer(target: OrchestratorConfig, layer: Partial<OrchestratorConfig> | undefined): void {
	if (layer === undefined || layer === null || typeof layer !== "object") {
		return;
	}
	const source = layer as Record<string, unknown>;
	const writable = target as unknown as Record<string, unknown>;
	for (const key of CONFIG_KEYS) {
		const value = source[key];
		if (value !== undefined) {
			writable[key] = value;
		}
	}
}

/**
 * Builds the live config for one session by layering file defaults, the
 * session's own entry and CLI flags over the baseline, lowest precedence first.
 * A higher layer only overrides the keys it actually carries, so an explicit
 * `undefined` never erases a lower layer's value.
 */
export function resolveSessionConfig(
	input: {
		fileDefaults?: Partial<OrchestratorConfig> | undefined;
		sessionState?: OrchestratorSessionState | undefined;
		flagOverrides?: Partial<OrchestratorConfig> | undefined;
	} = {},
): { config: OrchestratorConfig; activePlan: OrchestrationPlan | null } {
	const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG };
	applyLayer(config, input?.fileDefaults);
	applyLayer(config, input?.sessionState?.config);
	applyLayer(config, input?.flagOverrides);
	return { config, activePlan: input?.sessionState?.activePlan ?? null };
}
