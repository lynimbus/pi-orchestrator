/**
 * Unit tests for session-config.ts — the two orchestrator configuration chains.
 *
 * The reported bug: one shared `orchestrator.json` carried session A's `--orch`
 * flag into session B. The fix splits storage by ownership:
 *
 *   session switch:  DEFAULT.enabled (false) <- session entry enabled <- --orch
 *   global config:   DEFAULT_ORCHESTRATOR_CONFIG <- orchestrator.json <- --orch-model/--orch-thinking
 *
 * The file never owns the switch, and the session entry never owns the seven
 * global keys. These tests pin both chains and the read/write round-trip of the
 * file store. Every assertion is on an observable outcome: a returned object, a
 * returned primitive, or the untouched-ness of the caller's inputs.
 *
 * Run with: node ./test-session-config.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSyncTestRunner } from "./test-kit.ts";
import {
	DEFAULT_ORCHESTRATOR_CONFIG,
	parseDefaultsFile,
	readSessionState,
	resolveSessionConfig,
	serializeGlobalConfig,
} from "./session-config.ts";
import type { OrchestratorSessionState } from "./session-config.ts";
import type { OrchestrationPlan, OrchestratorConfig } from "./types.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const runner = createSyncTestRunner();
const testCase = runner.testCase;

const EMPTY_CONFIG_VALUES: OrchestratorConfig = {
	enabled: false,
	subagentModel: undefined,
	subagentThinkingLevel: undefined,
	maxConcurrency: 4,
	maxRetries: 2,
	requireHumanPlanApproval: false,
	requireHumanFinalApproval: false,
	allowAutoThreeWayLineMerge: true,
};

function configWith(overrides: Partial<OrchestratorConfig>): OrchestratorConfig {
	return { ...EMPTY_CONFIG_VALUES, ...overrides };
}

const DEFAULT_CONFIG = EMPTY_CONFIG_VALUES;

function orchestratorStateEntry(data: unknown): Record<string, unknown> {
	return { type: "custom", customType: "orchestrator-state", data };
}

// SAFETY: tests only check plan identity, never dereference these partial fields.
const PLAN = {
	id: "plan-1",
	tasks: [{ id: "t1", title: "first" }],
} as unknown as OrchestrationPlan;

/** Deep, order-stable snapshot used to prove functions mutate nothing. */
function snapshot(value: unknown): string {
	return JSON.stringify(value);
}

function parseSerialized(output: string): Record<string, unknown> {
	try {
		return JSON.parse(output) as Record<string, unknown>;
	} catch {
		assert.fail("serializeGlobalConfig must emit valid JSON");
	}
}

testCase(
	"DEFAULT_ORCHESTRATOR_CONFIG matches the defaults index.ts ships today",
	() => {
		assert.deepEqual(DEFAULT_ORCHESTRATOR_CONFIG, {
			enabled: false,
			subagentModel: undefined,
			subagentThinkingLevel: undefined,
			maxConcurrency: 4,
			maxRetries: 2,
			requireHumanPlanApproval: false,
			requireHumanFinalApproval: false,
			allowAutoThreeWayLineMerge: true,
		});
	}
);

testCase(
	"DEFAULT_ORCHESTRATOR_CONFIG is off by default and carries every required key",
	() => {
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.enabled, false);
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency, 4);
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.maxRetries, 2);
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.requireHumanPlanApproval, false);
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.requireHumanFinalApproval, false);
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.allowAutoThreeWayLineMerge, true);
		assert.ok("subagentModel" in DEFAULT_ORCHESTRATOR_CONFIG);
		assert.ok("subagentThinkingLevel" in DEFAULT_ORCHESTRATOR_CONFIG);
	}
);

testCase(
	"session-config.ts only uses node builtins plus type-only imports",
	() => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = fs.readFileSync(path.join(here, "session-config.ts"), "utf-8");
		const imports = [...source.matchAll(/import\s+([\s\S]*?)\s+from\s+"([^"]+)"/g)];
		for (const [, clause, specifier] of imports) {
			const isNodeBuiltin = specifier.startsWith("node:");
			const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
			const isTypeOnly = clause.trim().startsWith("type ");
			assert.ok(
				isNodeBuiltin || isRelative || isTypeOnly,
				`non-type import of ${specifier} would crash the run`,
			);
			if (specifier.startsWith("@earendil-works/")) {
				assert.ok(isTypeOnly, `value import from a pi package would crash the run: ${specifier}`);
			}
		}
	}
);

testCase(
	"session-config.ts stays pure: no filesystem and no pi value API",
	() => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const source = fs.readFileSync(path.join(here, "session-config.ts"), "utf-8");
		assert.equal(/from\s+"node:fs/.test(source), false, "the module must not read or write files itself");
		assert.equal(
			/import\s+(?!type\b)[^;]*?from\s+"@earendil-works\/[^"]+"/s.test(source),
			false,
			"pi packages may only be type-imported",
		);
		assert.equal(/\bpi\.\w+\(/.test(source), false, "the module must not call the pi API");
	}
);

testCase(
	"parseDefaultsFile rejects invalid JSON, empty input, arrays and null",
	() => {
		assert.equal(parseDefaultsFile("{not json"), undefined);
		assert.equal(parseDefaultsFile(""), undefined);
		assert.equal(parseDefaultsFile("[1,2]"), undefined);
		assert.equal(parseDefaultsFile("null"), undefined);
	}
);

testCase(
	"parseDefaultsFile rejects JSON scalars (non-plain-object roots)",
	() => {
		assert.equal(parseDefaultsFile("42"), undefined);
		assert.equal(parseDefaultsFile('"a string"'), undefined);
		assert.equal(parseDefaultsFile("true"), undefined);
	}
);

testCase(
	"parseDefaultsFile keeps a single recognized number",
	() => {
		assert.deepEqual(parseDefaultsFile('{"maxConcurrency": 8}'), { maxConcurrency: 8 });
	}
);

testCase(
	"parseDefaultsFile always drops enabled so a shared file cannot switch sessions on",
	() => {
		const parsed = parseDefaultsFile('{"enabled": true}');
		assert.deepEqual(parsed, {});
		assert.equal(parsed && "enabled" in parsed, false);
	}
);

testCase(
	"parseDefaultsFile drops unknown keys and wrong-typed values",
	() => {
		assert.deepEqual(
			parseDefaultsFile('{"maxRetries": 9, "bogus": 1, "requireHumanPlanApproval": "yes"}'),
			{ maxRetries: 9 },
		);
	}
);

testCase(
	"parseDefaultsFile on the real legacy file shape drops only enabled",
	() => {
		const raw = JSON.stringify({
			enabled: true,
			subagentModel: "magpie/group/deepseek",
			maxConcurrency: 6,
			maxRetries: 5,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: true,
		});
		const parsed = parseDefaultsFile(raw);
		assert.deepEqual(parsed, {
			subagentModel: "magpie/group/deepseek",
			maxConcurrency: 6,
			maxRetries: 5,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: true,
		});
		assert.equal(parsed && "enabled" in parsed, false);
	}
);

testCase(
	"parseDefaultsFile maps the legacy aliases thinkingLevel / model / concurrency",
	() => {
		assert.deepEqual(parseDefaultsFile('{"thinkingLevel":"low","model":"a/b","concurrency":3}'), {
			subagentThinkingLevel: "low",
			subagentModel: "a/b",
			maxConcurrency: 3,
		} satisfies Partial<OrchestratorConfig>);
	}
);

testCase(
	"parseDefaultsFile prefers the canonical key over its legacy alias",
	() => {
		assert.deepEqual(
			parseDefaultsFile(
				'{"model":"canonical/model","subagentModel":"canonical/model","concurrency":7,"maxConcurrency":7}',
			),
			{ subagentModel: "canonical/model", maxConcurrency: 7 },
		);
		assert.deepEqual(
			parseDefaultsFile('{"maxConcurrency":"nope","concurrency":5}'),
			{ maxConcurrency: 5 },
			"an unusable canonical value falls back to the usable alias",
		);
	}
);

testCase(
	"parseDefaultsFile validates runtime types for every recognized field",
	() => {
		assert.deepEqual(
			parseDefaultsFile(
				JSON.stringify({
					subagentModel: 42,
					subagentThinkingLevel: false,
					maxConcurrency: "8",
					maxRetries: null,
					requireHumanPlanApproval: 1,
					requireHumanFinalApproval: "true",
					allowAutoThreeWayLineMerge: 0,
				}),
			),
			{},
		);
	}
);

testCase(
	"parseDefaultsFile rejects non-finite numbers (JSON 1e999 parses to Infinity)",
	() => {
		assert.deepEqual(parseDefaultsFile('{"maxConcurrency":1e999,"maxRetries":1e999}'), {});
	}
);

testCase(
	"parseDefaultsFile trims subagentModel and drops a blank one",
	() => {
		assert.deepEqual(parseDefaultsFile('{"subagentModel":"  a/b  "}'), { subagentModel: "a/b" });
		assert.deepEqual(parseDefaultsFile('{"subagentModel":"   "}'), {});
		assert.deepEqual(parseDefaultsFile('{"model":""}'), {});
	}
);

testCase(
	"parseDefaultsFile accepts an explicitly empty (but boolean) enabled:false and still drops it",
	() => {
		assert.deepEqual(parseDefaultsFile('{"enabled": false, "maxRetries": 3}'), { maxRetries: 3 });
	}
);

testCase(
	"parseDefaultsFile returns {} for a valid JSON object with nothing usable",
	() => {
		assert.deepEqual(parseDefaultsFile("{}"), {});
		assert.deepEqual(parseDefaultsFile('{"totally":"unknown"}'), {});
	}
);

testCase(
	"serializeGlobalConfig writes the defined seven-key store with a trailing newline",
	() => {
		const output = serializeGlobalConfig({
			...DEFAULT_ORCHESTRATOR_CONFIG,
			subagentModel: "m",
			maxRetries: 3,
		});
		assert.ok(output.endsWith("\n"), "the file must end with a newline");
		const parsed = parseSerialized(output);
		assert.deepEqual(parsed, {
			subagentModel: "m",
			maxConcurrency: 4,
			maxRetries: 3,
			requireHumanPlanApproval: false,
			requireHumanFinalApproval: false,
			allowAutoThreeWayLineMerge: true,
		});
		assert.equal("enabled" in parsed, false);
		assert.deepEqual(parseDefaultsFile(output), {
			subagentModel: "m",
			maxConcurrency: 4,
			maxRetries: 3,
			requireHumanPlanApproval: false,
			requireHumanFinalApproval: false,
			allowAutoThreeWayLineMerge: true,
		});
	}
);

testCase(
	"serializeGlobalConfig omits undefined keys instead of writing them as null",
	() => {
		const output = serializeGlobalConfig({ ...DEFAULT_ORCHESTRATOR_CONFIG });
		const parsed = parseSerialized(output);
		assert.equal("subagentModel" in parsed, false);
		assert.equal("subagentThinkingLevel" in parsed, false);
		assert.equal(output.includes("subagentModel"), false);
		assert.equal(output.includes("subagentThinkingLevel"), false);
		assert.equal("enabled" in parsed, false);
	}
);

testCase(
	"serializeGlobalConfig round-trips all seven global keys and never writes enabled",
	() => {
		const partial: Partial<OrchestratorConfig> = {
			enabled: true,
			subagentModel: "provider/model",
			subagentThinkingLevel: "high" as ThinkingLevel,
			maxConcurrency: 7,
			maxRetries: 6,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: false,
		};
		const output = serializeGlobalConfig(partial);
		const parsed = parseSerialized(output);
		assert.equal(Object.keys(parsed).length, 7, "all seven non-switch keys are present");
		assert.equal("enabled" in parsed, false);
		assert.deepEqual(parseDefaultsFile(output), {
			subagentModel: "provider/model",
			subagentThinkingLevel: "high",
			maxConcurrency: 7,
			maxRetries: 6,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: false,
		});
	}
);

testCase(
	"serializeGlobalConfig uses two-space indentation and does not mutate its input",
	() => {
		const partial: Partial<OrchestratorConfig> = {
			subagentModel: "a/b",
			maxConcurrency: 5,
		};
		const before = snapshot(partial);
		const output = serializeGlobalConfig(partial);
		assert.ok(output.includes('\n  "subagentModel": "a/b",\n'));
		assert.equal(snapshot(partial), before);
	}
);

testCase(
	"serializeGlobalConfig of an empty partial is a parseable empty object",
	() => {
		const output = serializeGlobalConfig({});
		assert.equal(output, "{}\n");
		assert.deepEqual(parseDefaultsFile(output), {});
	}
);

testCase("readSessionState returns undefined for an empty entry list", () => {
	assert.equal(readSessionState([]), undefined);
});

testCase(
	"readSessionState returns undefined when no orchestrator-state entry is present",
	() => {
		assert.equal(readSessionState([{ type: "custom", customType: "other", data: {} }]), undefined);
		assert.equal(
			readSessionState([
				{ type: "message", role: "user", content: "hi" },
				{ type: "custom", customType: "orchestrator-state-prime", data: { enabled: true } },
			]),
			undefined,
		);
	}
);

testCase(
	"readSessionState returns the LAST orchestrator-state entry",
	() => {
		const state = readSessionState([
			orchestratorStateEntry({ enabled: false, activePlan: null }),
			orchestratorStateEntry({ enabled: true, activePlan: PLAN }),
		]);
		assert.deepEqual(state, { enabled: true, activePlan: PLAN });
	}
);

testCase(
	"readSessionState reads enabled:false and a null plan from the new shape",
	() => {
		const state = readSessionState([orchestratorStateEntry({ enabled: false, activePlan: null })]);
		assert.equal(state?.enabled, false);
		assert.equal(state?.activePlan, null);
	}
);

testCase(
	"readSessionState accepts the b27e1b8 legacy config shape but drops every non-switch key",
	() => {
		const state = readSessionState([
			orchestratorStateEntry({
				config: configWith({ enabled: true, subagentModel: "legacy", maxConcurrency: 9 }),
				activePlan: PLAN,
			}),
		]);
		assert.deepEqual(state, { enabled: true, activePlan: PLAN });
		assert.equal(state !== undefined && "config" in state, false);
	}
);

testCase(
	"readSessionState prefers a boolean data.enabled over the legacy config.enabled",
	() => {
		assert.deepEqual(
			readSessionState([
				orchestratorStateEntry({
					enabled: false,
					config: { enabled: true },
				}),
			]),
			{ enabled: false },
		);
		assert.deepEqual(
			readSessionState([
				orchestratorStateEntry({
					enabled: true,
					config: { enabled: false },
				}),
			]),
			{ enabled: true },
		);
	}
);

testCase(
	"readSessionState falls back to a boolean legacy config.enabled when data.enabled is absent",
	() => {
		assert.deepEqual(
			readSessionState([orchestratorStateEntry({ config: { enabled: false } })]),
			{ enabled: false },
		);
	}
);

testCase(
	"readSessionState ignores a non-boolean enabled instead of throwing",
	() => {
		const state = readSessionState([orchestratorStateEntry({ enabled: "yes" })]);
		assert.equal(state?.enabled, undefined);
		assert.deepEqual(state, {});

		assert.deepEqual(readSessionState([orchestratorStateEntry({ enabled: 1 })]), {});
		assert.deepEqual(readSessionState([orchestratorStateEntry({ enabled: null })]), {});
		assert.deepEqual(
			readSessionState([orchestratorStateEntry({ config: { enabled: "yes" }, activePlan: null })]),
			{ activePlan: null },
		);
	}
);

testCase(
	"readSessionState tolerates missing data, non-object data and non-object entries",
	() => {
		assert.deepEqual(readSessionState([{ type: "custom", customType: "orchestrator-state" }]), {});
		assert.deepEqual(readSessionState([orchestratorStateEntry(42)]), {});
		assert.deepEqual(readSessionState([orchestratorStateEntry("nope")]), {});
		assert.deepEqual(readSessionState([orchestratorStateEntry(null)]), {});
		assert.deepEqual(readSessionState([orchestratorStateEntry([1, 2, 3])]), {});
		assert.equal(readSessionState(["junk"]), undefined);
		assert.equal(readSessionState([42, null, undefined, "junk"]), undefined);
		assert.deepEqual(
			readSessionState([orchestratorStateEntry({ enabled: true }), "junk"]),
			{ enabled: true },
			"a non-object entry after the real one is skipped, not fatal",
		);
	}
);

testCase(
	"readSessionState ignores a non-plain-object legacy config but keeps activePlan",
	() => {
		assert.deepEqual(readSessionState([orchestratorStateEntry({ config: "nope", activePlan: PLAN })]), {
			activePlan: PLAN,
		});
		assert.deepEqual(readSessionState([orchestratorStateEntry({ config: null, activePlan: null })]), {
			activePlan: null,
		});
	}
);

testCase(
	"resolveSessionConfig with no inputs yields the defaults and a null plan",
	() => {
		const { config, activePlan } = resolveSessionConfig({});
		assert.deepEqual(config, DEFAULT_ORCHESTRATOR_CONFIG);
		assert.equal(activePlan, null);
	}
);

testCase(
	"resolveSessionConfig keeps working when every layer is explicitly undefined",
	() => {
		const { config, activePlan } = resolveSessionConfig({
			fileDefaults: undefined,
			sessionState: undefined,
			flagOverrides: undefined,
		});
		assert.deepEqual(config, DEFAULT_ORCHESTRATOR_CONFIG);
		assert.equal(activePlan, null);

		const noArg = resolveSessionConfig();
		assert.deepEqual(noArg.config, DEFAULT_ORCHESTRATOR_CONFIG);

		// SAFETY: runtime robustness test for a null argument the public signature excludes.
		const nullArg = resolveSessionConfig(null as unknown as {});
		assert.deepEqual(nullArg.config, DEFAULT_ORCHESTRATOR_CONFIG);
		assert.equal(nullArg.activePlan, null);
	}
);

testCase(
	"resolveSessionConfig returns a fresh config object, not the shared constant",
	() => {
		const { config } = resolveSessionConfig({});
		assert.notStrictEqual(config, DEFAULT_ORCHESTRATOR_CONFIG);
		config.maxConcurrency = 99;
		assert.equal(DEFAULT_ORCHESTRATOR_CONFIG.maxConcurrency, 4);
	}
);

testCase(
	"resolveSessionConfig ignores the file's enabled but applies its global keys",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { enabled: true, subagentModel: "magpie/group/deepseek" },
		});
		assert.equal(config.enabled, false, "a shared file can never switch a session on");
		assert.equal(config.subagentModel, "magpie/group/deepseek");
	}
);

testCase(
	"resolveSessionConfig applies only enabled from the session entry",
	() => {
		// SAFETY: deliberately injects fields the session contract no longer allows.
		const sessionState = {
			enabled: true,
			subagentModel: "leaked-from-session",
			maxConcurrency: 99,
		} as unknown as OrchestratorSessionState;
		const { config } = resolveSessionConfig({
			fileDefaults: { maxConcurrency: 6 },
			sessionState,
		});
		assert.equal(config.enabled, true);
		assert.equal(config.subagentModel, undefined, "the session entry owns no global model");
		assert.equal(config.maxConcurrency, 6, "the file's global value still wins over a session extra");
	}
);

testCase(
	"resolveSessionConfig layers file <- session enabled <- flags exactly",
	() => {
		const { config, activePlan } = resolveSessionConfig({
			fileDefaults: { subagentModel: "file" },
			sessionState: { enabled: true },
			flagOverrides: { subagentModel: "flag" },
		});
		assert.equal(config.enabled, true);
		assert.equal(config.subagentModel, "flag");
		assert.equal(activePlan, null);
	}
);

testCase(
	"resolveSessionConfig lets the session switch turn the mode ON over a file that says false",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { enabled: false },
			sessionState: { enabled: true },
		});
		assert.equal(config.enabled, true);
	}
);

testCase(
	"resolveSessionConfig lets a session switch OFF over a file that says true (the reported leak)",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { enabled: true },
			sessionState: { enabled: false },
		});
		assert.equal(config.enabled, false);
	}
);

testCase(
	"resolveSessionConfig lets file defaults beat the built-in defaults for every global field",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: {
				enabled: true,
				subagentModel: "magpie/group/deepseek",
				subagentThinkingLevel: "high" as ThinkingLevel,
				maxConcurrency: 6,
				maxRetries: 5,
				requireHumanPlanApproval: true,
				requireHumanFinalApproval: true,
				allowAutoThreeWayLineMerge: false,
			},
		});
		assert.deepEqual(config, {
			enabled: false,
			subagentModel: "magpie/group/deepseek",
			subagentThinkingLevel: "high",
			maxConcurrency: 6,
			maxRetries: 5,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: false,
		});
	}
);

testCase(
	"resolveSessionConfig lets an explicit --orch flag win over a session entry that says false",
	() => {
		const { config } = resolveSessionConfig({
			sessionState: { enabled: false },
			flagOverrides: { enabled: true },
		});
		assert.equal(config.enabled, true);
	}
);

testCase(
	"resolveSessionConfig lets an explicit --orch=false win over a session entry that says true",
	() => {
		const { config } = resolveSessionConfig({
			sessionState: { enabled: true },
			flagOverrides: { enabled: false },
		});
		assert.equal(config.enabled, false);
	}
);

testCase(
	"resolveSessionConfig applies every flag override key at the highest precedence",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { maxConcurrency: 6, subagentModel: "file/model" },
			sessionState: { enabled: true },
			flagOverrides: {
				enabled: false,
				subagentModel: "flag/model",
				subagentThinkingLevel: "low" as ThinkingLevel,
				maxConcurrency: 12,
				maxRetries: 8,
				requireHumanPlanApproval: true,
				requireHumanFinalApproval: true,
				allowAutoThreeWayLineMerge: false,
			},
		});
		assert.deepEqual(config, {
			enabled: false,
			subagentModel: "flag/model",
			subagentThinkingLevel: "low",
			maxConcurrency: 12,
			maxRetries: 8,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: true,
			allowAutoThreeWayLineMerge: false,
		});
	}
);

testCase(
	"resolveSessionConfig never lets an undefined value in a higher layer erase a lower one",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { subagentModel: "a/b" },
			flagOverrides: { subagentModel: undefined },
		});
		assert.equal(config.subagentModel, "a/b");

		const withSession = resolveSessionConfig({
			fileDefaults: { subagentModel: "a/b", maxRetries: 7 },
			sessionState: { enabled: undefined },
			flagOverrides: { maxRetries: undefined },
		});
		assert.equal(withSession.config.subagentModel, "a/b");
		assert.equal(withSession.config.maxRetries, 7);
	}
);

testCase(
	"resolveSessionConfig carries activePlan through by identity",
	() => {
		const { activePlan } = resolveSessionConfig({ sessionState: { activePlan: PLAN } });
		assert.strictEqual(activePlan, PLAN);
	}
);

testCase(
	"resolveSessionConfig yields a null activePlan when absent or null",
	() => {
		assert.equal(resolveSessionConfig({ sessionState: {} }).activePlan, null);
		assert.equal(resolveSessionConfig({ sessionState: { activePlan: null } }).activePlan, null);
		assert.equal(resolveSessionConfig({ sessionState: { activePlan: undefined } }).activePlan, null);
		assert.equal(resolveSessionConfig({}).activePlan, null);
	}
);

testCase(
	"resolveSessionConfig never mutates fileDefaults, sessionState or flagOverrides",
	() => {
		const fileDefaults: Partial<OrchestratorConfig> = { maxConcurrency: 6, subagentModel: "a/b" };
		const sessionState: OrchestratorSessionState = { enabled: true, activePlan: PLAN };
		const flagOverrides: Partial<OrchestratorConfig> = { enabled: false, maxConcurrency: 12 };

		const before = snapshot({ fileDefaults, sessionState, flagOverrides });

		const result = resolveSessionConfig({ fileDefaults, sessionState, flagOverrides });
		result.config.maxConcurrency = 1;
		result.config.subagentModel = "mutated";

		assert.equal(snapshot({ fileDefaults, sessionState, flagOverrides }), before);
		assert.deepEqual(fileDefaults, { maxConcurrency: 6, subagentModel: "a/b" });
		assert.deepEqual(sessionState, { enabled: true, activePlan: PLAN });
		assert.deepEqual(flagOverrides, { enabled: false, maxConcurrency: 12 });
	}
);

testCase(
	"resolveSessionConfig end-to-end: seeded file + session entry + flag",
	() => {
		const seededFile = parseDefaultsFile(
			'{"enabled":true,"subagentModel":"magpie/group/deepseek","maxConcurrency":6,"maxRetries":5}',
		);
		assert.ok(seededFile !== undefined);

		const newSession = resolveSessionConfig({ fileDefaults: seededFile });
		assert.equal(newSession.config.enabled, false, "a fresh session starts OFF despite the legacy file");
		assert.equal(newSession.config.subagentModel, "magpie/group/deepseek", "global seeds still apply");
		assert.equal(newSession.config.maxConcurrency, 6);
		assert.equal(newSession.config.maxRetries, 5);

		const flaggedSession = resolveSessionConfig({ fileDefaults: seededFile, flagOverrides: { enabled: true } });
		assert.equal(flaggedSession.config.enabled, true);

		const restored = resolveSessionConfig({
			fileDefaults: seededFile,
			sessionState: readSessionState([
				orchestratorStateEntry({ enabled: flaggedSession.config.enabled, activePlan: null }),
			]),
		});
		assert.equal(restored.config.enabled, true, "the session's own entry restores --orch on resume");
		assert.equal(restored.config.subagentModel, "magpie/group/deepseek", "session entry never carries globals");

		const sibling = resolveSessionConfig({
			fileDefaults: seededFile,
			sessionState: readSessionState([orchestratorStateEntry({ enabled: false, activePlan: null })]),
		});
		assert.equal(sibling.config.enabled, false, "another session's entry stays OFF");
	}
);

testCase(
	"resolveSessionConfig reads a b27e1b8 legacy entry's switch but lets the global file keep its keys",
	() => {
		const legacyState = readSessionState([
			orchestratorStateEntry({ config: configWith({ enabled: true, subagentModel: "legacy" }), activePlan: null }),
		]);
		const { config } = resolveSessionConfig({
			fileDefaults: { subagentModel: "global" },
			sessionState: legacyState,
		});
		assert.equal(config.enabled, true, "the old entry's switch still restores on resume");
		assert.equal(config.subagentModel, "global", "the old entry's global snapshot is ignored");
	}
);

testCase(
	"serializeGlobalConfig round-trips a resolved config's global keys through parseDefaultsFile",
	() => {
		const resolved = resolveSessionConfig({
			fileDefaults: { subagentModel: "a/b", maxRetries: 3 },
			flagOverrides: { maxConcurrency: 9, requireHumanPlanApproval: true },
		});
		const output = serializeGlobalConfig(resolved.config);
		assert.deepEqual(parseDefaultsFile(output), {
			subagentModel: "a/b",
			maxConcurrency: 9,
			maxRetries: 3,
			requireHumanPlanApproval: true,
			requireHumanFinalApproval: false,
			allowAutoThreeWayLineMerge: true,
		});
	}
);

runner.finish();