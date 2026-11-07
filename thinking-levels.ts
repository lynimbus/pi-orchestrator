/**
 * Model-declared thinking-level policy for subagents.
 *
 * This module owns exactly one concern: given the list of thinking levels that the
 * selected subagent model actually declares, decide which level the worker gets,
 * what the picker menu shows, and how to phrase the rejection.
 *
 * It deliberately does NOT derive the supported list. `@earendil-works/pi-ai`'s
 * `getSupportedThinkingLevels(model)` is the single source of truth for the
 * reasoning / `thinkingLevelMap` rule; the caller runs it and hands the result in.
 * Duplicating that rule here would let the two copies drift, which is the exact
 * class of bug this module replaces.
 *
 * Two rules follow from that split:
 *
 * - `supported === undefined` means "the declaration is unavailable" (a registry
 *   miss for a hand-typed custom model id, or no model selected). That is NOT the
 *   same as a known non-reasoning model, which pi reports as `["off"]`. Without a
 *   declaration we cannot prove a level unsupported, so nothing is filtered.
 * - Nothing is clamped. An unsupported level resolves to `undefined`, which makes
 *   the caller omit `--thinking` and lets pi apply its own documented clamping
 *   inside the worker session. Clamping silently would hide a misconfiguration.
 *
 * Dependency-free and importable by plain `node`: the only project-facing import
 * is a type, erased at runtime.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Every level pi-agent-core knows, in ascending effort order (includes `max`). */
export const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

const INHERIT_LABEL = "(inherit lead thinking)";
const CURRENT_SUFFIX = " (current)";

/**
 * Narrows an untrusted value (a tool argument, a persisted setting) to a level.
 * Case-sensitive and whitespace-tolerant; anything else is `undefined`.
 */
export function parseThinkingLevel(raw: unknown): ThinkingLevel | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	const match = EXTENDED_THINKING_LEVELS.find((level) => level === trimmed);
	return match;
}

/**
 * Splits a `provider/modelId` spec on the FIRST `/` only, because model ids
 * themselves contain slashes (`magpie/group/deepseek` is provider `magpie`,
 * model id `group/deepseek`).
 */
export function parseModelSpec(spec: unknown): { provider: string; modelId: string } | undefined {
	if (typeof spec !== "string") return undefined;
	const slash = spec.indexOf("/");
	if (slash < 0) return undefined;
	const provider = spec.slice(0, slash).trim();
	const modelId = spec.slice(slash + 1).trim();
	if (provider.length === 0 || modelId.length === 0) return undefined;
	return { provider, modelId };
}

/**
 * `supported === undefined` means the model declaration is unavailable, so no
 * level can be proven unsupported and every level is allowed through.
 */
export function isThinkingLevelSupported(
	level: ThinkingLevel,
	supported: readonly ThinkingLevel[] | undefined
): boolean {
	if (supported === undefined) return true;
	return supported.includes(level);
}

/**
 * Picks the worker's thinking level: the subagent's own setting first, the lead's
 * level second. A pick the selected model does not declare yields `undefined`
 * rather than a clamped neighbour.
 */
export function resolveSubagentThinking(input: {
	configured?: ThinkingLevel | undefined;
	leadLevel?: ThinkingLevel | undefined;
	supported?: readonly ThinkingLevel[] | undefined;
}): ThinkingLevel | undefined {
	const pick = input.configured ?? input.leadLevel;
	if (pick === undefined) return undefined;
	if (input.supported === undefined) return pick;
	return isThinkingLevelSupported(pick, input.supported) ? pick : undefined;
}

/**
 * Builds the picker rows: the inherit entry first, then the declared levels in
 * order, marking the configured one. A level missing from the menu can never be
 * selected, so the menu mirrors the model's declaration exactly.
 */
export function thinkingMenuOptions(
	supported: readonly ThinkingLevel[] | undefined,
	current: ThinkingLevel | undefined
): string[] {
	const levels = supported ?? EXTENDED_THINKING_LEVELS;
	return [
		INHERIT_LABEL,
		...levels.map((level) => (current !== undefined && level === current ? `${level}${CURRENT_SUFFIX}` : level)),
	];
}

/** Explains a rejected level without guessing at a substitute. */
export function unsupportedThinkingLevelMessage(
	level: ThinkingLevel,
	supported: readonly ThinkingLevel[]
): string {
	return `Thinking level "${level}" is not supported by the selected subagent model. Supported levels: ${supported.join(", ")}.`;
}
