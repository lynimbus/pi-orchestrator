/**
 * Structural wiring contract for index.ts.
 *
 * HONESTY NOTE: this suite is a STRUCTURAL guard, not behavioural proof. `index.ts`
 * cannot be imported by plain `node` here: it value-imports
 * `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` and this repo ships no
 * node_modules. So every assertion below reads ./index.ts as TEXT and matches semantic
 * anchors (identifier names, call shapes), never whitespace, indentation or line numbers.
 * The behavioural proof lives in ./test-thinking-levels.ts, ./test-tool-gate.ts and
 * ./test-session-config.ts.
 *
 * Run with: node ./test-extension-wiring.ts
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerCliArgs } from "./subagent-runner.ts";
import { createSyncTestRunner } from "./test-kit.ts";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const indexSource = fs.readFileSync(path.join(repoRoot, "index.ts"), "utf-8");

/** The shared harness: pass/fail counting, printing and exit status. */
const runner = createSyncTestRunner();
const testCase = runner.testCase;

/**
 * A bounded text window starting at the first `anchor`. Used instead of line ranges so a
 * reformat or an added comment cannot break the assertion, while a call site can still be
 * inspected in isolation.
 */
function windowFrom(anchor: string, length = 480): string {
	const start = indexSource.indexOf(anchor);
	assert.notEqual(start, -1, `index.ts must contain the anchor ${JSON.stringify(anchor)}`);
	return indexSource.slice(start, start + length);
}

/** Every identifier list this repo has ever written the shared config with. */
const CONFIG_WRITE_APIS = [
	"writeFileSync",
	"writeFile",
	"appendFileSync",
	"appendFile",
	"createWriteStream",
	"mkdirSync",
	"renameSync",
	"unlinkSync",
	"rmSync",
	"copyFileSync",
];

/**
 * Matches the removed constant by IDENTIFIER, never by substring: ./thinking-levels.ts
 * exports `EXTENDED_THINKING_LEVELS`, which index.ts may legitimately import, while a
 * reintroduced bare `THINKING_LEVELS` must still fail.
 */
const BARE_THINKING_LEVELS_IDENTIFIER = /(?<![A-Z_])THINKING_LEVELS\b/;

console.log("defect 1 — hardcoded thinking levels are gone");

testCase(
	"index.ts does not declare the THINKING_LEVELS constant: the level list lives behind the model declaration",
	() => {
		const offending = BARE_THINKING_LEVELS_IDENTIFIER.exec(indexSource);
		assert.equal(
			offending,
			null,
			`index.ts must not declare (or reference) the hardcoded THINKING_LEVELS constant` +
				(offending ? `; found at offset ${offending.index}` : "") +
				"; levels come from getSupportedThinkingLevels",
		);
	}
);

testCase(
	"the scoped THINKING_LEVELS check accepts EXTENDED_THINKING_LEVELS but rejects a bare constant",
	() => {
		assert.equal(
			BARE_THINKING_LEVELS_IDENTIFIER.test("\tEXTENDED_THINKING_LEVELS,"),
			false,
			"importing EXTENDED_THINKING_LEVELS from ./thinking-levels.ts is legitimate and must not trip the guard",
		);
		assert.equal(
			BARE_THINKING_LEVELS_IDENTIFIER.test('const THINKING_LEVELS: ThinkingLevel[] = ["off", "high"];'),
			true,
			"a reintroduced `const THINKING_LEVELS = [...]` must still be rejected",
		);
		assert.equal(
			BARE_THINKING_LEVELS_IDENTIFIER.test("\t\t...THINKING_LEVELS.map((lvl) => lvl),"),
			true,
			"a bare reference to the removed constant must still be rejected",
		);
	}
);

testCase(
	"index.ts no longer mentions DEFAULT_CONFIG: defaults come from session-config.ts",
	() => {
		assert.ok(
			!indexSource.includes("DEFAULT_CONFIG"),
			"DEFAULT_CONFIG must not be declared in index.ts; import DEFAULT_ORCHESTRATOR_CONFIG instead",
		);
	}
);

testCase(
	"index.ts imports getSupportedThinkingLevels as a VALUE from @earendil-works/pi-ai",
	() => {
		const piAiImport = /import\s*\{([^}]*)\}\s*from\s*"@earendil-works\/pi-ai"/.exec(indexSource);
		assert.ok(piAiImport, "index.ts must keep a named import block from @earendil-works/pi-ai");
		assert.ok(
			piAiImport[1].includes("getSupportedThinkingLevels"),
			"getSupportedThinkingLevels must be imported by name from @earendil-works/pi-ai",
		);
		assert.ok(
			!/import\s+type\s*\{[^}]*getSupportedThinkingLevels/.test(indexSource),
			"getSupportedThinkingLevels must be a value import (it is called), never `import type`",
		);
	}
);

testCase(
	"the subagent declaration is resolved from the configured subagent model, else ctx.model, else undefined",
	() => {
		const helper = windowFrom("function supportedThinkingLevels(", 700);
		assert.match(
			helper,
			/getSupportedThinkingLevels\(/,
			"the supported list must come from getSupportedThinkingLevels",
		);
		assert.match(
			helper,
			/ctx\.modelRegistry\.find\(/,
			"the configured subagent model must be looked up in the model registry",
		);
		assert.match(
			helper,
			/ctx\.model\b/,
			"with no configured subagent model the lead's ctx.model must govern the declaration",
		);
		assert.match(
			helper,
			/parseModelSpec\(/,
			"the provider/modelId split must go through parseModelSpec (ids contain slashes)",
		);
		assert.match(
			helper,
			/catch\s*\{/,
			"a missing registry must degrade to undefined instead of throwing",
		);
	}
);

testCase(
	"resolveEffectiveSubagentThinking delegates to resolveSubagentThinking without clamping",
	() => {
		const body = windowFrom("function resolveEffectiveSubagentThinking(", 420);
		assert.match(body, /resolveSubagentThinking\(\s*\{/, "the resolution must delegate to the policy module");
		assert.match(body, /configured:\s*config\.subagentThinkingLevel/, "configured level must be passed through");
		assert.match(body, /leadLevel:\s*ctx\.thinkingLevel/, "the lead level must be passed through as the fallback");
		assert.match(body, /supported:\s*/, "the model declaration must be passed through");
		assert.ok(
			!/includes\(/.test(body),
			"the level must not be checked against a local list; that is the policy module's job",
		);
		assert.ok(!/\?\?/.test(body), "no fallback default may be substituted: an unsupported level stays undefined");
		assert.ok(!/\|\|/.test(body), "no fallback default may be substituted: an unsupported level stays undefined");
	}
);

testCase(
	"the dispatch hands the resolved level to the worker spawn unchanged",
	() => {
		assert.match(
			indexSource,
			/const effectiveThinking = resolveEffectiveSubagentThinking\(ctx\)/,
			"orch_dispatch must resolve the worker level through resolveEffectiveSubagentThinking",
		);
		assert.match(
			indexSource,
			/thinkingLevel:\s*effectiveThinking\b/,
			"the resolved level (which may be undefined) must be forwarded to runWaveTaskSubagent",
		);
		assert.ok(
			!/thinkingLevel:\s*effectiveThinking\s*(\|\||\?\?)/.test(indexSource),
			"the dispatch must not substitute a default level when the resolution is undefined",
		);
	}
);

testCase(
	"buildWorkerCliArgs omits --thinking when the resolved level is undefined",
	() => {
		const omitted = buildWorkerCliArgs("T1", "/tmp/worker-sessions", { thinkingLevel: undefined });
		assert.ok(!omitted.args.includes("--thinking"), "no --thinking flag may be emitted without a level");
		const withLevel = buildWorkerCliArgs("T1", "/tmp/worker-sessions", { thinkingLevel: "high" });
		assert.ok(withLevel.args.includes("--thinking"), "a declared level must still be forwarded");
		assert.equal(withLevel.args[withLevel.args.indexOf("--thinking") + 1], "high");
	}
);

console.log("defect 2 — orch tools are gated while the mode is off");

testCase("index.ts wires the authoritative tool_call gate", () => {
	assert.match(
		indexSource,
		/return orchestratorToolGate\(event\.toolName, config\.enabled\)/,
		"a tool_call handler must return orchestratorToolGate(event.toolName, config.enabled)",
	);
	assert.match(
		indexSource,
		/import\s*\{[^}]*orchestratorToolGate[^}]*\}\s*from\s*"\.\/tool-gate\.ts"/,
		"orchestratorToolGate must come from ./tool-gate.ts",
	);
});

testCase("index.ts imports declaredToolsForRun and prunes declarations while disabled", () => {
	assert.match(
		indexSource,
		/import\s*\{[^}]*declaredToolsForRun[^}]*\}\s*from\s*"\.\/tool-gate\.ts"/,
		"declaredToolsForRun must come from ./tool-gate.ts",
	);
	assert.match(
		indexSource,
		/declaredToolsForRun\([\s\S]{0,120}?false\s*\)/,
		"the disabled run must prune with declaredToolsForRun(..., false)",
	);
});

testCase("the before_agent_start handler prunes selectedTools on the disabled path", () => {
	const handlerStart = indexSource.indexOf('pi.on("before_agent_start"');
	assert.notEqual(handlerStart, -1, 'index.ts must keep its pi.on("before_agent_start") handler');
	const handler = indexSource.slice(handlerStart, indexSource.indexOf('pi.on("tool_call"', handlerStart));
	assert.ok(handler.length > 0, "the handler must be followed by the next registration");
	assert.match(
		handler,
		/if\s*\(\s*!config\.enabled\s*\)\s*\{[\s\S]{0,600}?declaredToolsForRun\(/,
		"the disabled branch must run a block that prunes the declaration, not return immediately",
	);
	assert.ok(
		!/if\s*\(\s*!config\.enabled\s*\)\s*return/.test(handler),
		"the disabled branch must not be an early return that skips pruning",
	);
	assert.match(
		handler,
		/systemPromptOptions/,
		"pruning must target event.systemPromptOptions.selectedTools",
	);
	assert.match(
		handler,
		/selectedTools/,
		"pruning must target event.systemPromptOptions.selectedTools",
	);
	assert.match(
		handler,
		/declaredToolsForRun\([\s\S]{0,120}?false\s*\)/,
		"the prune must pass enabled=false",
	);
});

testCase("the enabled banner is preserved, including its tool instructions", () => {
	const handlerStart = indexSource.indexOf('pi.on("before_agent_start"');
	const handler = indexSource.slice(handlerStart, indexSource.indexOf('pi.on("tool_call"', handlerStart));
	assert.match(handler, /messageType !== "user"/, "the banner must still only fire for user runs");
	assert.match(handler, /ORCHESTRATOR MODE ACTIVE/, "the enabled banner text must stay");
	assert.match(handler, /MANDATORY WORKFLOW RULES/, "the enabled banner rules must stay");
	assert.match(handler, /customType: "orchestrator-workflow-enforcement"/, "the message type must stay");
});

testCase("the eight orch tools stay registered and worker mode stays separate", () => {
	const registered = indexSource.match(/pi\.registerTool\(\{/g) ?? [];
	assert.equal(registered.length, 8, "exactly the eight orch tools must stay registered");
	assert.ok(indexSource.includes("PI_ORCHESTRATOR_WORKER"), "subagent worker mode must stay wired");
	assert.ok(
		indexSource.includes("PI_ORCHESTRATOR_TASK_ID"),
		"the worker's task-id env contract must stay wired",
	);
});

console.log("defect 3 — configuration is per session");

testCase("index.ts no longer declares or calls saveConfig", () => {
	assert.ok(!indexSource.includes("saveConfig"), "saveConfig must be deleted, not merely unused");
});

testCase("nothing in index.ts writes to the agent-dir orchestrator.json path", () => {
	const writePattern = new RegExp(`\\.(?:${CONFIG_WRITE_APIS.join("|")})\\s*\\(`, "g");
	const configPathMarkers = ["getConfigFilePath", "CONFIG_FILE", "configFilePath", "orchestrator.json"];
	const writeCalls = [...indexSource.matchAll(writePattern)];
	for (const match of writeCalls) {
		// Both sides of the call: the original defect aliased the path into `filePath` first.
		const window = indexSource.slice(Math.max(0, match.index - 400), match.index + 400);
		for (const marker of configPathMarkers) {
			assert.ok(
				!window.includes(marker),
				`a config write reappeared near ${match[0]} (${marker}): the agent-dir file is a read-only defaults seed`,
			);
		}
	}
	assert.equal(
		writeCalls.length,
		0,
		`index.ts performs no filesystem writes at all (found ${writeCalls.map((m) => m[0]).join(", ")}); ` +
			"the extension persists per-session state through pi.appendEntry only. If a new write is legitimate, " +
			"scope this assertion to the config path instead of deleting it",
	);
});

testCase("loadConfig reads the defaults file through parseDefaultsFile", () => {
	const body = windowFrom("function loadConfig(", 320);
	assert.match(body, /getConfigFilePath\(\)/, "loadConfig must still read the agent-dir path");
	assert.match(body, /readFileSync\(/, "loadConfig must read the file");
	assert.match(body, /parseDefaultsFile\(/, "the raw file text must be handed to parseDefaultsFile");
	assert.ok(!/JSON\.parse/.test(body), "the defaults file must not be trusted through a bare JSON.parse");
	assert.ok(!/writeFileSync/.test(body), "loadConfig must never write");
});

testCase("session_start resolves through resolveSessionConfig with readSessionState", () => {
	const start = indexSource.indexOf('pi.on("session_start"');
	assert.notEqual(start, -1, 'index.ts must keep its pi.on("session_start") handler');
	const handler = indexSource.slice(start, start + 2400);
	assert.match(handler, /resolveSessionConfig\(\{/, "session_start must build the config through resolveSessionConfig");
	assert.match(handler, /fileDefaults:\s*loadConfig\(\)/, "the defaults file is the lowest-precedence layer");
	assert.match(
		handler,
		/sessionState:\s*readSessionState\(\s*ctx\.sessionManager\.getEntries\(\)\s*\)/,
		"the session's own orchestrator-state entry must be read back, not discarded",
	);
	assert.match(handler, /flagOverrides/, "the CLI flags must arrive as the highest-precedence layer");
	assert.match(
		handler,
		/resolveSessionConfig\(\{[\s\S]{0,400}?flagOverrides/,
		"flagOverrides must be passed to resolveSessionConfig",
	);
	assert.match(handler, /config\s*=\s*resolved\.config/, "the resolved config must be assigned");
	assert.match(handler, /activePlan\s*=\s*resolved\.activePlan/, "the resolved plan must be assigned");
	assert.match(handler, /updateUI\(ctx\)/, "session_start must still refresh the UI");
	assert.ok(!/saveConfig/.test(handler), "session_start must not write the shared config");
});

testCase("an explicit --orch lands last, so it still enables the session it is passed to", () => {
	const handlerStart = indexSource.indexOf('pi.on("session_start"');
	const handler = indexSource.slice(handlerStart, handlerStart + 2400);
	assert.match(handler, /pi\.getFlag\("orch"\)/, "the --orch flag must still be consulted");
	assert.match(handler, /flagOverrides\.enabled\s*=\s*true/, "--orch must seed the flag override layer");
	const flagThinking = windowFrom('pi.getFlag("orch-thinking")', 320);
	assert.match(flagThinking, /parseThinkingLevel\(/, "the --orch-thinking value must be validated by parseThinkingLevel");
	assert.match(flagThinking, /flagOverrides\.subagentThinkingLevel/, "a parsed flag level must land in flagOverrides");
	const flagModel = windowFrom('pi.getFlag("orch-model")', 260);
	assert.match(flagModel, /flagOverrides\.subagentModel/, "a non-empty --orch-model must land in flagOverrides");
});

testCase("the --orch-thinking flag description derives its levels from the model declaration", () => {
	const flag = windowFrom('pi.registerFlag("orch-thinking"', 320);
	assert.ok(
		!/off\|minimal\|low/.test(flag),
		"the flag description must not advertise the removed fixed enum",
	);
	assert.match(
		flag,
		/declaration|declared/i,
		"the flag description must say the levels come from the subagent model's declaration",
	);
});

console.log("/orch thinking follows the model declaration");

testCase("an unsupported level is rejected with unsupportedThinkingLevelMessage and never persisted", () => {
	const thinking = windowFrom('sub === "thinking"', 1400);
	assert.match(thinking, /parseThinkingLevel\(/, "the argument must be parsed before it is trusted");
	assert.match(
		thinking,
		/isThinkingLevelSupported\(level,\s*supported\)/,
		"the parsed level must be checked against the resolved declaration",
	);
	assert.match(
		thinking,
		/unsupportedThinkingLevelMessage\(level,\s*supported\)/,
		"the rejection must explain which levels the model declares",
	);
	assert.match(thinking, /config\.subagentThinkingLevel\s*=\s*level\b/, "a supported level is persisted");
	assert.ok(
		!/config\.subagentThinkingLevel\s*=\s*argThink\b/.test(thinking),
		"the raw argument must never be persisted unvalidated",
	);
	assert.ok(
		!/config\.subagentThinkingLevel\s*=\s*[\w.]+\s+as\s+ThinkingLevel/.test(indexSource),
		"no `as ThinkingLevel` cast may bypass validation before persisting",
	);
	assert.match(thinking, /inherit/, "`inherit` must keep clearing the configured level");
	assert.match(thinking, /promptThinkingSelection\(ctx\)/, "the no-argument path must keep opening the menu");
});

testCase("the interactive menu is built from thinkingMenuOptions and keeps the inherit row", () => {
	const menu = windowFrom("async function promptThinkingSelection(", 900);
	assert.match(
		menu,
		/thinkingMenuOptions\(\s*supported,\s*config\.subagentThinkingLevel\s*\)/,
		"the menu must list thinkingMenuOptions(supported, current)",
	);
	assert.ok(
		indexSource.includes("(inherit lead thinking)"),
		'the "(inherit lead thinking)" row must survive',
	);
	assert.match(menu, /replace\(\s*" \(current\)"/, 'the " (current)" suffix must still be stripped before persisting');
	assert.match(menu, /config\.subagentThinkingLevel = undefined/, "inheriting must clear the configured level");
});

console.log("status report tells the truth about the level");

testCase("formatOrchestratorStatusReport marks an undeclared configured level as unsupported", () => {
	const start = indexSource.indexOf("function formatOrchestratorStatusReport(");
	assert.notEqual(start, -1, "the status report must stay");
	const report = indexSource.slice(start);
	assert.match(report, /isThinkingLevelSupported\(/, "the report must check the declaration before claiming a level");
	assert.match(report, /unsupported/i, "the report must say a level is unsupported when it is not declared");
	assert.match(
		report,
		/Subagent Thinking: \$\{/,
		"the existing report line must stay (shape preserved); only its value is now honest",
	);
	assert.ok(
		!/\- Subagent Thinking: \$\{config\.subagentThinkingLevel \|\|/.test(report),
		"the report must not print an undeclared level as if it were in force",
	);
});

console.log("entry point syntax");

testCase("node --check reports no syntax error for index.ts", () => {
	const checked = spawnSync(process.execPath, ["--check", path.join(repoRoot, "index.ts")], {
		encoding: "utf-8",
	});
	assert.equal(
		checked.status,
		0,
		`node --check index.ts failed: ${checked.stderr || checked.stdout || "(no output)"}`,
	);
});

runner.finish();
