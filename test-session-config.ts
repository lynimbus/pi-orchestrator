/**
 * Unit tests for session-config.ts — per-session orchestrator config resolution.
 *
 * The reported bug: one shared `orchestrator.json` in the agent dir carried the
 * `--orch` flag of session A into session B. The fix makes the session's own
 * `orchestrator-state` entry the live store and demotes the agent-dir file to a
 * read-only defaults seed. These tests pin that precedence chain:
 *
 *   DEFAULT_ORCHESTRATOR_CONFIG <- file defaults <- session entry <- CLI flags
 *
 * Every assertion is on an observable outcome: a returned object, a returned
 * primitive, or the untouched-ness of the caller's inputs.
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
} from "./session-config.ts";
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

const PLAN = {
	id: "plan-1",
	tasks: [{ id: "t1", title: "first" }],
} as unknown as OrchestrationPlan;

/** Deep, order-stable snapshot used to prove resolveSessionConfig mutates nothing. */
function snapshot(value: unknown): string {
	return JSON.stringify(value);
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
				{ type: "custom", customType: "orchestrator-state-prime", data: { config: DEFAULT_CONFIG } },
			]),
			undefined,
		);
	}
);

testCase(
	"readSessionState returns the LAST orchestrator-state entry",
	() => {
		const state = readSessionState([
			orchestratorStateEntry({ config: configWith({ enabled: false, maxConcurrency: 1 }), activePlan: null }),
			orchestratorStateEntry({ config: configWith({ enabled: true, maxConcurrency: 9 }), activePlan: PLAN }),
		]);
		assert.deepEqual(state, {
			config: configWith({ enabled: true, maxConcurrency: 9 }),
			activePlan: PLAN,
		});
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
			readSessionState([orchestratorStateEntry({ config: DEFAULT_CONFIG }), "junk"]),
			{ config: DEFAULT_CONFIG },
			"a non-object entry after the real one is skipped, not fatal",
		);
	}
);

testCase(
	"readSessionState ignores a non-plain-object config but keeps activePlan",
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
	"resolveSessionConfig lets the session entry turn the mode ON over a file that says false",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { enabled: false },
			sessionState: { config: configWith({ enabled: true }) },
		});
		assert.equal(config.enabled, true);
	}
);

testCase(
	"resolveSessionConfig lets the session entry turn the mode OFF over a file that says true (the reported leak)",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { enabled: true },
			sessionState: { config: configWith({ enabled: false }) },
		});
		assert.equal(config.enabled, false);
	}
);

testCase(
	"resolveSessionConfig lets file defaults beat the built-in defaults for every field",
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
			enabled: true,
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
			sessionState: { config: configWith({ enabled: false }) },
			flagOverrides: { enabled: true },
		});
		assert.equal(config.enabled, true);
	}
);

testCase(
	"resolveSessionConfig gives flagOverrides the highest precedence over every layer",
	() => {
		const { config } = resolveSessionConfig({
			fileDefaults: { maxConcurrency: 6 },
			sessionState: { config: configWith({ maxConcurrency: 8, enabled: false }) },
			flagOverrides: { maxConcurrency: 12, enabled: true },
		});
		assert.equal(config.maxConcurrency, 12);
		assert.equal(config.enabled, true);
	}
);

testCase(
	"resolveSessionConfig merges a partial session config over the defaults instead of wiping them",
	() => {
		const { config } = resolveSessionConfig({
			sessionState: { config: { maxConcurrency: 8 } as unknown as OrchestratorConfig },
		});
		assert.equal(config.maxConcurrency, 8);
		assert.equal(config.maxRetries, 2);
		assert.equal(config.enabled, false);
		assert.equal(config.allowAutoThreeWayLineMerge, true);
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
			sessionState: { config: { subagentModel: undefined } as unknown as OrchestratorConfig },
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
		const sessionConfig = configWith({ enabled: true, maxRetries: 9 });
		const sessionState = { config: sessionConfig, activePlan: PLAN };
		const flagOverrides: Partial<OrchestratorConfig> = { enabled: false, maxConcurrency: 12 };

		const before = snapshot({ fileDefaults, sessionState, flagOverrides });

		const result = resolveSessionConfig({ fileDefaults, sessionState, flagOverrides });
		result.config.maxConcurrency = 1;
		result.config.subagentModel = "mutated";

		assert.equal(snapshot({ fileDefaults, sessionState, flagOverrides }), before);
		assert.deepEqual(fileDefaults, { maxConcurrency: 6, subagentModel: "a/b" });
		assert.deepEqual(sessionState, { config: configWith({ enabled: true, maxRetries: 9 }), activePlan: PLAN });
		assert.deepEqual(flagOverrides, { enabled: false, maxConcurrency: 12 });
		assert.equal(sessionConfig.maxConcurrency, 4);
	}
);

testCase(
	"resolveSessionConfig end-to-end: seeded file + session entry + flag behaves like the fix",
	() => {
		const seededFile = parseDefaultsFile(
			'{"enabled":true,"subagentModel":"magpie/group/deepseek","maxConcurrency":6,"maxRetries":5}',
		);
		assert.ok(seededFile !== undefined);

		const newSession = resolveSessionConfig({ fileDefaults: seededFile });
		assert.equal(newSession.config.enabled, false, "a fresh session starts OFF despite the legacy file");
		assert.equal(newSession.config.subagentModel, "magpie/group/deepseek", "hand-edited seeds still apply");
		assert.equal(newSession.config.maxConcurrency, 6);
		assert.equal(newSession.config.maxRetries, 5);

		const flaggedSession = resolveSessionConfig({ fileDefaults: seededFile, flagOverrides: { enabled: true } });
		assert.equal(flaggedSession.config.enabled, true);

		const restored = resolveSessionConfig({
			fileDefaults: seededFile,
			sessionState: readSessionState([orchestratorStateEntry({ config: flaggedSession.config, activePlan: null })]),
		});
		assert.equal(restored.config.enabled, true, "the session's own entry restores --orch on resume");

		const sibling = resolveSessionConfig({
			fileDefaults: seededFile,
			sessionState: readSessionState([
				orchestratorStateEntry({ config: configWith({ enabled: false }), activePlan: null }),
			]),
		});
		assert.equal(sibling.config.enabled, false, "another session's entry stays OFF");
	}
);

runner.finish();
