/**
 * Unit tests for thinking-levels.ts, the model-declared thinking-level policy.
 *
 * The scenarios mirror the runtime evidence behind the defect: `magpie/group/deepseek`
 * declares ["off","low","high","max"] (minimal / medium / xhigh are null), while
 * `magpie/group/hy4` declares only ["high"]. Every assertion is an observable
 * returned value, never module internals.
 *
 * Run with: node ./test-thinking-levels.ts
 */

import * as assert from "node:assert/strict";
import {
	EXTENDED_THINKING_LEVELS,
	isThinkingLevelSupported,
	parseModelSpec,
	parseThinkingLevel,
	resolveSubagentThinking,
	thinkingMenuOptions,
	unsupportedThinkingLevelMessage,
} from "./thinking-levels.ts";
import { createAsyncTestRunner } from "./test-kit.ts";

/** The one shared harness: pass/fail counting, printing and exit status. */
const runner = createAsyncTestRunner();
const testCase = runner.testCase;

/** What pi itself reported for magpie/group/deepseek (thinkingLevelMap nulls dropped). */
const DEEPSEEK_LEVELS = ["off", "low", "high", "max"] as const;

/**
 * the extended list is the union pi-agent-core knows about, including `max`, which the
 * old hardcoded list omitted.
 */
await testCase(
	"EXTENDED_THINKING_LEVELS deep-equals the seven levels pi knows, in order",
	() => {
		assert.deepStrictEqual(
			[...EXTENDED_THINKING_LEVELS],
			["off", "minimal", "low", "medium", "high", "xhigh", "max"]
		);
	}
);

/** model ids contain slashes, so only the first one splits. */
await testCase(
	"parseModelSpec splits 'magpie/group/deepseek' on the first slash only",
	() => {
		assert.deepStrictEqual(parseModelSpec("magpie/group/deepseek"), {
			provider: "magpie",
			modelId: "group/deepseek",
		});
	}
);

await testCase("parseModelSpec accepts a one-slash spec", () => {
	assert.deepStrictEqual(parseModelSpec("anthropic/claude-x"), {
		provider: "anthropic",
		modelId: "claude-x",
	});
});

await testCase("parseModelSpec trims both halves", () => {
	assert.deepStrictEqual(parseModelSpec("  magpie/group/deepseek  "), {
		provider: "magpie",
		modelId: "group/deepseek",
	});
});

await testCase("parseModelSpec returns undefined for a spec with no slash", () => {
	assert.strictEqual(parseModelSpec("deepseek"), undefined);
});

await testCase("parseModelSpec returns undefined for an empty provider half", () => {
	assert.strictEqual(parseModelSpec("/group/deepseek"), undefined);
});

await testCase("parseModelSpec returns undefined for an empty modelId half", () => {
	assert.strictEqual(parseModelSpec("magpie/"), undefined);
});

await testCase("parseModelSpec returns undefined for a whitespace-only half", () => {
	assert.strictEqual(parseModelSpec("magpie/   "), undefined);
	assert.strictEqual(parseModelSpec("   /group/deepseek"), undefined);
});

await testCase("parseModelSpec returns undefined for non-string input", () => {
	assert.strictEqual(parseModelSpec(undefined), undefined);
	assert.strictEqual(parseModelSpec(42), undefined);
	assert.strictEqual(parseModelSpec(null), undefined);
	// Keep the excluded values alive so this test documents the accepted set.
	assert.deepStrictEqual(parseModelSpec("a/b"), { provider: "a", modelId: "b" });
});

await testCase("parseThinkingLevel accepts 'medium' with and without whitespace", () => {
	assert.strictEqual(parseThinkingLevel("medium"), "medium");
	assert.strictEqual(parseThinkingLevel("  medium  "), "medium");
});

await testCase("parseThinkingLevel accepts 'max', the level the old list omitted", () => {
	assert.strictEqual(parseThinkingLevel("max"), "max");
});

await testCase("parseThinkingLevel rejects case variants, unknown words and non-strings", () => {
	assert.strictEqual(parseThinkingLevel("MEDIUM"), undefined);
	assert.strictEqual(parseThinkingLevel("turbo"), undefined);
	assert.strictEqual(parseThinkingLevel(null), undefined);
	assert.strictEqual(parseThinkingLevel(undefined), undefined);
	assert.strictEqual(parseThinkingLevel(7), undefined);
});

await testCase("parseThinkingLevel accepts every extended level", () => {
	for (const level of EXTENDED_THINKING_LEVELS) {
		assert.strictEqual(parseThinkingLevel(level), level);
	}
});

/**
 * the deepseek declaration makes the three null'd levels unsupported and keeps the four it
 * names.
 */
await testCase(
	"isThinkingLevelSupported against the deepseek declaration drops minimal/medium/xhigh",
	() => {
		const supported = [...DEEPSEEK_LEVELS];
		assert.strictEqual(isThinkingLevelSupported("off", supported), true);
		assert.strictEqual(isThinkingLevelSupported("minimal", supported), false);
		assert.strictEqual(isThinkingLevelSupported("low", supported), true);
		assert.strictEqual(isThinkingLevelSupported("medium", supported), false);
		assert.strictEqual(isThinkingLevelSupported("high", supported), true);
		assert.strictEqual(isThinkingLevelSupported("xhigh", supported), false);
		assert.strictEqual(isThinkingLevelSupported("max", supported), true);
	}
);

await testCase("isThinkingLevelSupported is true for every level when the declaration is unavailable", () => {
	for (const level of EXTENDED_THINKING_LEVELS) {
		assert.strictEqual(isThinkingLevelSupported(level, undefined), true, level);
	}
});

await testCase("isThinkingLevelSupported on an empty declaration rejects every level", () => {
	for (const level of EXTENDED_THINKING_LEVELS) {
		assert.strictEqual(isThinkingLevelSupported(level, []), false, level);
	}
});

/** configured wins, but only when the model declares it. */
await testCase(
	"resolveSubagentThinking prefers configured over leadLevel",
	() => {
		assert.strictEqual(
			resolveSubagentThinking({
				configured: "high",
				leadLevel: "low",
				supported: [...DEEPSEEK_LEVELS],
			}),
			"high"
		);
	}
);

await testCase(
	"resolveSubagentThinking returns undefined when the configured level is declared null",
	() => {
		assert.strictEqual(
			resolveSubagentThinking({ configured: "medium", supported: [...DEEPSEEK_LEVELS] }),
			undefined
		);
	}
);

await testCase("resolveSubagentThinking keeps 'max', a level the old list never offered", () => {
	assert.strictEqual(
		resolveSubagentThinking({ configured: "max", supported: [...DEEPSEEK_LEVELS] }),
		"max"
	);
});

/** an unavailable declaration never filters the user's choice. */
await testCase(
	"resolveSubagentThinking ignores supported when the declaration is unavailable",
	() => {
		assert.strictEqual(resolveSubagentThinking({ configured: "xhigh", supported: undefined }), "xhigh");
		assert.strictEqual(
			resolveSubagentThinking({ leadLevel: "minimal", supported: undefined }),
			"minimal"
		);
	}
);

await testCase("resolveSubagentThinking falls back to the lead level when nothing is configured", () => {
	assert.strictEqual(
		resolveSubagentThinking({ leadLevel: "low", supported: [...DEEPSEEK_LEVELS] }),
		"low"
	);
});

await testCase("resolveSubagentThinking returns undefined when the inherited lead level is unsupported", () => {
	assert.strictEqual(
		resolveSubagentThinking({ leadLevel: "medium", supported: [...DEEPSEEK_LEVELS] }),
		undefined
	);
});

await testCase(
	"resolveSubagentThinking returns undefined when both configured and leadLevel are undefined",
	() => {
		assert.strictEqual(resolveSubagentThinking({ supported: [...DEEPSEEK_LEVELS] }), undefined);
		assert.strictEqual(resolveSubagentThinking({}), undefined);
	}
);

await testCase("resolveSubagentThinking does not clamp an unsupported level into a neighbour", () => {
	assert.strictEqual(
		resolveSubagentThinking({ configured: "minimal", supported: [...DEEPSEEK_LEVELS] }),
		undefined
	);
});

/** the menu shrinks to the narrow magpie/group/hy4 declaration. */
await testCase(
	"thinkingMenuOptions marks the current level and keeps the inherit entry first",
	() => {
		assert.deepStrictEqual(thinkingMenuOptions(["high"], "high"), [
			"(inherit lead thinking)",
			"high (current)",
		]);
	}
);

await testCase("thinkingMenuOptions does not mark a level that is not current", () => {
	assert.deepStrictEqual(thinkingMenuOptions([...DEEPSEEK_LEVELS], "max"), [
		"(inherit lead thinking)",
		"off",
		"low",
		"high",
		"max (current)",
	]);
});

await testCase(
	"thinkingMenuOptions falls back to the extended levels without a current suffix",
	() => {
		assert.deepStrictEqual(thinkingMenuOptions(undefined, undefined), [
			"(inherit lead thinking)",
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	}
);

await testCase("thinkingMenuOptions marks the current level in the fallback list too", () => {
	assert.deepStrictEqual(thinkingMenuOptions(undefined, "off"), [
		"(inherit lead thinking)",
		"off (current)",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

await testCase("thinkingMenuOptions returns only the inherit entry for an empty declaration", () => {
	assert.deepStrictEqual(thinkingMenuOptions([], undefined), ["(inherit lead thinking)"]);
});

await testCase(
	"unsupportedThinkingLevelMessage names the level and lists every supported level",
	() => {
		const message = unsupportedThinkingLevelMessage("medium", [...DEEPSEEK_LEVELS]);
		assert.ok(message.includes("medium"), `expected "medium" in: ${message}`);
		for (const level of DEEPSEEK_LEVELS) {
			assert.ok(message.includes(level), `expected "${level}" in: ${message}`);
		}
		assert.ok(!message.includes("\n"), `expected a single line, got: ${message}`);
	}
);

await testCase("unsupportedThinkingLevelMessage reflects the narrow hy4 declaration", () => {
	const message = unsupportedThinkingLevelMessage("low", ["high"]);
	assert.ok(message.includes("low"), `expected "low" in: ${message}`);
	assert.ok(message.includes("high"), `expected "high" in: ${message}`);
	assert.ok(!message.includes("max"), `did not expect "max" in: ${message}`);
});

runner.finish();
