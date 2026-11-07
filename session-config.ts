/**
 * Orchestrator configuration storage contracts.
 *
 * Two chains share this module, and only these two:
 *
 *   session switch: DEFAULT.enabled (false) <- session entry `enabled` <- --orch flag
 *   global config:  DEFAULT_ORCHESTRATOR_CONFIG <- orchestrator.json <- --orch-model / --orch-thinking
 *
 * `orchestrator.json` is the agent-dir store for the seven global keys only:
 * `parseDefaultsFile` reads it, `serializeGlobalConfig` writes it, and it never
 * owns `enabled`. The session's `orchestrator-state` entry owns `enabled` and
 * `activePlan` only, because the master switch is the one setting that must
 * follow a session instead of leaking through a shared file.
 *
 * Why the split: the file is shared by every session, so a `--orch` flag once
 * written there switched on every session started afterwards. Global tuning
 * values (model, concurrency, approvals) are intentionally shared; the switch
 * and the active plan are not.
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

/**
 * The per-session store shape carried by the session's `orchestrator-state`
 * entry. It deliberately has no `config` field: global settings belong to the
 * shared file, not to whichever session happened to resolve them.
 */
export interface OrchestratorSessionState {
	enabled?: boolean;
	activePlan?: OrchestrationPlan | null;
}

/** The seven settings owned by the shared defaults file. */
const GLOBAL_CONFIG_KEYS = [
	"subagentModel",
	"subagentThinkingLevel",
	"maxConcurrency",
	"maxRetries",
	"requireHumanPlanApproval",
	"requireHumanFinalApproval",
	"allowAutoThreeWayLineMerge",
] as const;

/** Every key a live config accepts, including the session-owned switch. */
const CONFIG_KEYS = ["enabled", ...GLOBAL_CONFIG_KEYS] as const;

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
 * Reads the agent-dir `orchestrator.json`, the store for the seven global keys.
 * Absent, unreadable or non-object content yields `undefined`; a valid object
 * with nothing usable yields `{}`. Legacy aliases (`model`, `thinkingLevel`,
 * `concurrency`) are mapped onto their canonical fields, and the canonical key
 * wins when both are present.
 *
 * `enabled` is ALWAYS dropped: a shared file can never own the session switch.
 * The extension persists global settings with `serializeGlobalConfig`, which
 * never writes the key, so a hand-edited `"enabled": true` is simply ignored
 * and every new session starts OFF unless its own session entry or the `--orch`
 * flag turns it on.
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
		// SAFETY: the parser only checks non-empty strings; thinking-level validity is enforced by the caller.
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

/**
 * Serializes the seven global keys for `orchestrator.json`. `undefined` values
 * are omitted rather than written as `null`, `enabled` is never written, and
 * `parseDefaultsFile` round-trips every defined value back.
 */
export function serializeGlobalConfig(partial: Partial<OrchestratorConfig>): string {
	const output: Record<string, unknown> = {};
	for (const key of GLOBAL_CONFIG_KEYS) {
		const value = partial?.[key];
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return `${JSON.stringify(output, null, 2)}\n`;
}

function toSessionState(data: unknown): OrchestratorSessionState {
	if (!isPlainObject(data)) {
		return {};
	}
	const state: OrchestratorSessionState = {};
	const enabled =
		readBoolean(data, "enabled") ??
		(isPlainObject(data.config) ? readBoolean(data.config, "enabled") : undefined);
	if (enabled !== undefined) {
		state.enabled = enabled;
	}
	if (data.activePlan !== undefined) {
		// SAFETY: activePlan is stored opaquely; this module only round-trips its identity.
		state.activePlan = (data.activePlan ?? null) as OrchestrationPlan | null;
	}
	return state;
}

/**
 * Scans session entries and returns the data of the LAST `orchestrator-state`
 * entry, or `undefined` when the session has none. Malformed entries are
 * skipped, and an entry with missing or non-object data contributes `{}`.
 *
 * `enabled` is read from the current `data.enabled` shape, falling back to the
 * b27e1b8 `data.config.enabled` shape so sessions written before the split
 * still restore their switch. Either value must be a boolean; every legacy
 * non-switch key is ignored because the shared file is the global store now.
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

function applyLayer(
	target: OrchestratorConfig,
	layer: Partial<OrchestratorConfig> | undefined,
	keys: readonly (keyof OrchestratorConfig)[],
): void {
	if (layer === undefined || layer === null || typeof layer !== "object") {
		return;
	}
	// SAFETY: both views describe the same config object; only the index signature is added.
	const source = layer as Record<string, unknown>;
	// SAFETY: keys is restricted to OrchestratorConfig keys, so every write stays inside the config.
	const writable = target as unknown as Record<string, unknown>;
	for (const key of keys) {
		const value = source[key];
		if (value !== undefined) {
			writable[key] = value;
		}
	}
}

/**
 * Builds the live config for one session, lowest precedence first:
 *
 *   DEFAULT <- fileDefaults (global keys only) <- sessionState (`enabled` only) <- flagOverrides (all keys)
 *
 * The file's `enabled` is ignored unconditionally, the session entry can never
 * contribute a global key, and a higher layer only overrides the keys it
 * actually carries, so an explicit `undefined` never erases a lower value.
 */
export function resolveSessionConfig(
	input: {
		fileDefaults?: Partial<OrchestratorConfig> | undefined;
		sessionState?: OrchestratorSessionState | undefined;
		flagOverrides?: Partial<OrchestratorConfig> | undefined;
	} = {},
): { config: OrchestratorConfig; activePlan: OrchestrationPlan | null } {
	const config: OrchestratorConfig = { ...DEFAULT_ORCHESTRATOR_CONFIG };
	applyLayer(config, input?.fileDefaults, GLOBAL_CONFIG_KEYS);

	const sessionEnabled = input?.sessionState?.enabled;
	if (typeof sessionEnabled === "boolean") {
		config.enabled = sessionEnabled;
	}

	applyLayer(config, input?.flagOverrides, CONFIG_KEYS);
	return { config, activePlan: input?.sessionState?.activePlan ?? null };
}