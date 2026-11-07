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

/**
 * A window bounded by two anchors. Preferred over `windowFrom` when the exact end of a
 * branch or function matters: a fixed length can silently swallow the next branch and make
 * a "must not appear here" assertion test the wrong code.
 */
function sliceBetween(startAnchor: string, endAnchor: string): string {
	const start = indexSource.indexOf(startAnchor);
	assert.notEqual(start, -1, `index.ts must contain the anchor ${JSON.stringify(startAnchor)}`);
	const end = indexSource.indexOf(endAnchor, start + startAnchor.length);
	assert.notEqual(end, -1, `index.ts must contain ${JSON.stringify(endAnchor)} after ${JSON.stringify(startAnchor)}`);
	return indexSource.slice(start, end);
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

testCase("persistState appends only the session switch and the active plan", () => {
	const body = sliceBetween("function persistState(", "function commitState(");
	assert.match(body, /pi\.appendEntry\(\s*"orchestrator-state"/, "the session entry must keep its custom type");
	assert.match(body, /enabled:\s*config\.enabled/, "the session entry must carry the switch");
	assert.match(body, /activePlan\b/, "the session entry must carry the active plan");
	assert.ok(!/\bconfig\s*,/.test(body), "the whole config must no longer be appended to the session entry");
	assert.ok(!/\.\.\.config\b/.test(body), "the whole config must not be spread into the session entry");
	assert.ok(
		!/subagentModel|subagentThinkingLevel|maxConcurrency|maxRetries|requireHuman/.test(body),
		"the seven global keys belong to orchestrator.json, not the session entry",
	);
});

testCase("saveGlobalConfig writes the seven global keys with a guarded, non-throwing file write", () => {
	const save = sliceBetween("function saveGlobalConfig(", "function commitGlobalConfig(");
	assert.match(save, /Partial<OrchestratorConfig>/, "the writer must take a partial patch, not a whole config");
	assert.match(save, /loadConfig\(\) \?\? \{\}/, "the patch must merge over the file's existing keys");
	assert.match(save, /\.\.\.patch\b/, "the caller's patch must win over the file's existing keys");

	const mkdirAt = save.search(
		/fs\.mkdirSync\(\s*path\.dirname\(\s*getConfigFilePath\(\)\s*\)\s*,\s*\{\s*recursive:\s*true\s*\}\s*\)/,
	);
	assert.notEqual(mkdirAt, -1, "the writer must create the agent directory recursively before writing");
	const writeAt = save.search(/fs\.writeFileSync\(\s*getConfigFilePath\(\)\s*,\s*serializeGlobalConfig\(/);
	assert.notEqual(writeAt, -1, "the writer must serialize the merged result through serializeGlobalConfig");
	assert.ok(mkdirAt < writeAt, "the directory must exist before the file write");

	assert.match(save, /catch\s*\(/, "a failed write must be caught");
	assert.match(save, /ctx\.ui\.notify\([\s\S]*?"error"\)/, "a failed write must notify with severity error");
	assert.ok(!/\bthrow\b/.test(save), "a failed write must never escape as an exception");
});

testCase("commitGlobalConfig assigns the patch, saves the file, then refreshes the UI", () => {
	const commit = sliceBetween("function commitGlobalConfig(", "function renderStatus(");
	assert.match(commit, /Object\.assign\(config,\s*patch\)/, "the in-memory config must receive the patch");
	assert.match(commit, /saveGlobalConfig\(ctx,\s*patch\)/, "the same patch must be persisted globally");
	assert.match(commit, /updateUI\(ctx\)/, "the UI must be refreshed after the value changes");
});

testCase("the only orchestrator.json write lives inside saveGlobalConfig", () => {
	const saveStart = indexSource.indexOf("function saveGlobalConfig(");
	assert.notEqual(saveStart, -1, "index.ts must declare saveGlobalConfig");
	const saveEnd = indexSource.indexOf("function commitGlobalConfig(", saveStart);
	assert.notEqual(saveEnd, -1, "commitGlobalConfig must follow saveGlobalConfig");

	const writePattern = new RegExp(`\\.(?:${CONFIG_WRITE_APIS.join("|")})\\s*\\(`, "g");
	const configPathMarkers = ["getConfigFilePath", "CONFIG_FILE", "configFilePath", "orchestrator.json"];
	const configWrites: string[] = [];
	for (const match of indexSource.matchAll(writePattern)) {
		// Both sides of the call: a future defect may alias the path into a local first.
		const window = indexSource.slice(Math.max(0, match.index - 400), match.index + 400);
		if (!configPathMarkers.some((marker) => window.includes(marker))) continue;
		configWrites.push(match[0]);
		assert.ok(
			match.index >= saveStart && match.index < saveEnd,
			`a write outside saveGlobalConfig touches the agent-dir config path: ${match[0]}`,
		);
	}
	assert.ok(configWrites.length >= 2, "saveGlobalConfig must both mkdir and write the config file");
	assert.ok(
		configWrites.some((call) => call.includes("writeFileSync")),
		"the config file write must go through writeFileSync",
	);
	assert.ok(!indexSource.includes("saveConfig"), "the removed saveConfig helper must not reappear");
});

testCase("loadConfig reads the global config file through parseDefaultsFile", () => {
	const body = windowFrom("function loadConfig(", 420);
	assert.match(body, /getConfigFilePath\(\)/, "loadConfig must still read the agent-dir path");
	assert.match(body, /readFileSync\(/, "loadConfig must read the file");
	assert.match(body, /parseDefaultsFile\(/, "the raw file text must be handed to parseDefaultsFile");
	assert.ok(!/JSON\.parse/.test(body), "the config file must not be trusted through a bare JSON.parse");
	assert.ok(!/writeFileSync/.test(body), "loadConfig must never write");
});

testCase("the eight global edit points commit through commitGlobalConfig and never through session state", () => {
	const points: Array<{ label: string; start: string; end: string; patchKey: RegExp }> = [
		{
			label: "/orch model",
			start: 'if (sub === "model")',
			end: 'if (sub === "thinking"',
			patchKey: /subagentModel\s*:/,
		},
		{
			label: "/orch thinking",
			start: 'if (sub === "thinking"',
			end: 'if (sub === "reset"',
			patchKey: /subagentThinkingLevel\s*:/,
		},
		{
			label: "promptModelSelection",
			start: "async function promptModelSelection(",
			end: "async function promptThinkingSelection(",
			patchKey: /subagentModel\s*:/,
		},
		{
			label: "promptThinkingSelection",
			start: "async function promptThinkingSelection(",
			end: "async function openInteractiveOrchMenu(",
			patchKey: /subagentThinkingLevel\s*:/,
		},
		{
			label: "menu item 4 (maxConcurrency)",
			start: 'selected.startsWith("4.")',
			end: 'selected.startsWith("5.")',
			patchKey: /maxConcurrency\s*:/,
		},
		{
			label: "menu item 5 (maxRetries)",
			start: 'selected.startsWith("5.")',
			end: 'selected.startsWith("6.")',
			patchKey: /maxRetries\s*:/,
		},
		{
			label: "menu item 6 (requireHumanPlanApproval)",
			start: 'selected.startsWith("6.")',
			end: 'selected.startsWith("7.")',
			patchKey: /requireHumanPlanApproval\s*:/,
		},
		{
			label: "menu item 7 (requireHumanFinalApproval)",
			start: 'selected.startsWith("7.")',
			end: 'selected.startsWith("8.")',
			patchKey: /requireHumanFinalApproval\s*:/,
		},
	];

	for (const point of points) {
		const body = sliceBetween(point.start, point.end);
		assert.match(body, /commitGlobalConfig\(ctx,\s*\{/, `${point.label} must commit through commitGlobalConfig`);
		assert.match(body, point.patchKey, `${point.label} must carry its own key in the patch`);
		assert.ok(!/commitState\(/.test(body), `${point.label} must not persist through the session entry`);
		assert.ok(!/persistState\(/.test(body), `${point.label} must not append session state directly`);
		assert.ok(!/enabled\s*:/.test(body), `${point.label} must never write the switch to the global file`);
	}
});

testCase("the switch, reset and plan paths still commit session state", () => {
	const switchPoints: Array<{ label: string; start: string; end: string }> = [
		{
			label: "/orch on",
			start: 'if (sub === "on" || sub === "enable")',
			end: 'if (sub === "off" || sub === "disable")',
		},
		{
			label: "/orch off",
			start: 'if (sub === "off" || sub === "disable")',
			end: 'if (sub === "toggle")',
		},
		{
			label: "/orch toggle",
			start: 'if (sub === "toggle")',
			end: 'if (sub === "model")',
		},
		{
			label: "/orch reset",
			start: 'if (sub === "reset" || sub === "clear")',
			end: 'if (sub === "status")',
		},
		{
			label: "menu item 1 (toggle)",
			start: 'selected.startsWith("1.")',
			end: 'selected.startsWith("2.")',
		},
		{
			label: "Ctrl+Alt+O shortcut",
			start: 'pi.registerShortcut("ctrl+alt+o"',
			end: 'pi.registerCommand("orch"',
		},
	];
	for (const point of switchPoints) {
		assert.match(
			sliceBetween(point.start, point.end),
			/commitState\(ctx\)/,
			`${point.label} must still persist the switch through the session entry`,
		);
	}

	const toolStarts = [...indexSource.matchAll(/pi\.registerTool\(\{/g)].map((match) => match.index!);
	assert.equal(toolStarts.length, 8, "exactly the eight orch tools must stay registered");
	for (let i = 0; i < toolStarts.length; i++) {
		// Bound each tool registration at the next top-level registration, otherwise the
		// last tool would swallow the /orch command and its global-config writes.
		const boundaries = [
			indexSource.indexOf("pi.registerTool({", toolStarts[i] + 1),
			indexSource.indexOf("pi.registerShortcut(", toolStarts[i] + 1),
			indexSource.indexOf("pi.registerCommand(", toolStarts[i] + 1),
			indexSource.indexOf('pi.on("before_agent_start"', toolStarts[i] + 1),
		].filter((index) => index !== -1);
		assert.ok(boundaries.length > 0, `orch tool block ${i + 1} must end before another registration`);
		const body = indexSource.slice(toolStarts[i], Math.min(...boundaries));
		const toolName = /name:\s*"(orch_[a-z0-9_]+)"/.exec(body)?.[1];
		assert.ok(toolName, `orch tool block ${i + 1} must declare its name`);
		if (toolName !== "orch_status") {
			// orch_status is read-only; every state-changing tool must still persist the session.
			assert.match(body, /commitState\(ctx\)/, `${toolName} must still commit session state`);
		}
		assert.ok(!/commitGlobalConfig\(/.test(body), `${toolName} must not write global config`);
	}
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
	assert.ok(!/saveConfig/.test(handler), "session_start must not call the removed shared-config writer");
	assert.ok(
		!/commitGlobalConfig|saveGlobalConfig/.test(handler),
		"session_start must never write flag overrides into the shared global file",
	);
	assert.match(handler, /session entry/, "the switch precedence comment must name the session entry layer");
	assert.match(handler, /orchestrator\.json/, "the global precedence comment must name the shared file");
	assert.match(handler, /--orch-model/, "the global precedence comment must name the per-session model override");
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

/**
 * Every symbol ./session-config.ts exports. Hardcoded on purpose: deriving the list from the
 * module would make the guard blind to exactly the exports it forgot to enumerate.
 */
const SESSION_CONFIG_EXPORTS = [
	"DEFAULT_ORCHESTRATOR_CONFIG",
	"OrchestratorSessionState",
	"parseDefaultsFile",
	"readSessionState",
	"resolveSessionConfig",
	"serializeGlobalConfig",
];

/**
 * The `import { ... } from "./session-config.ts"` statement of `source`: where it starts and
 * ends, plus the symbols listed in its braces. A leading `type` is stripped because a type
 * import still satisfies a type-only use.
 */
function sessionConfigImportBlock(source: string): {
	start: number;
	end: number;
	imported: Set<string>;
} {
	const specifier = 'from "./session-config.ts"';
	const specifierStart = source.indexOf(specifier);
	assert.notEqual(specifierStart, -1, 'index.ts must import from "./session-config.ts"');
	const start = source.lastIndexOf("import", specifierStart);
	assert.notEqual(start, -1, 'the "./session-config.ts" specifier must close an import statement');
	const braces = source.slice(start, specifierStart).match(/\{([^}]*)\}/);
	assert.ok(braces, 'the "./session-config.ts" import must list its symbols in braces');
	const imported = new Set(
		braces[1]
			.split(",")
			.map((entry) => entry.trim().replace(/^type\s+/, ""))
			.filter((entry) => entry.length > 0),
	);
	return { start, end: specifierStart + specifier.length, imported };
}

/**
 * Symbols used as identifiers OUTSIDE the ./session-config.ts import block but absent from it.
 *
 * Why this exists: Node erases types and never resolves names, `node --check` only parses
 * syntax, and every other assertion in this suite is a text anchor. So a call to an export
 * that was never imported passes all three checks and only throws at runtime — inside
 * `saveGlobalConfig` the try/catch swallows the ReferenceError and the file write silently
 * never happens. This helper closes that hole: use implies import.
 */
function findSessionConfigSymbolsUsedWithoutImport(source: string): string[] {
	const { start, end, imported } = sessionConfigImportBlock(source);
	const outsideImport = source.slice(0, start) + source.slice(end);
	return SESSION_CONFIG_EXPORTS.filter(
		(symbol) => !imported.has(symbol) && new RegExp(`\\b${symbol}\\b`).test(outsideImport),
	);
}

testCase("index.ts imports every session-config.ts export it uses, so a call cannot ReferenceError", () => {
	const { imported } = sessionConfigImportBlock(indexSource);
	const missing = findSessionConfigSymbolsUsedWithoutImport(indexSource);
	assert.deepEqual(
		missing,
		[],
		`index.ts uses session-config.ts export(s) without importing them: ${missing.join(", ") || "(none)"}; ` +
			"node --check only parses and saveGlobalConfig's try/catch would swallow the ReferenceError",
	);
	assert.ok(
		imported.has("serializeGlobalConfig"),
		"the session-config import block must include serializeGlobalConfig (it writes orchestrator.json)",
	);
});

testCase("the session-config import guard names a used export the import block omits", () => {
	const broken = [
		"import {",
		"\tDEFAULT_ORCHESTRATOR_CONFIG,",
		"\tparseDefaultsFile,",
		"\treadSessionState,",
		"\tresolveSessionConfig,",
		'} from "./session-config.ts";',
		"",
		"function saveGlobalConfig(): void {",
		'\tfs.writeFileSync(getConfigFilePath(), serializeGlobalConfig(next), "utf-8");',
		"}",
	].join("\n");
	assert.deepEqual(
		findSessionConfigSymbolsUsedWithoutImport(broken),
		["serializeGlobalConfig"],
		"a used but unimported export must fail the guard and be named in the message",
	);
});

testCase("the session-config import guard ignores exports index.ts never mentions", () => {
	const source = [
		"import {",
		"\tDEFAULT_ORCHESTRATOR_CONFIG,",
		'} from "./session-config.ts";',
		"",
		"const config = DEFAULT_ORCHESTRATOR_CONFIG;",
	].join("\n");
	assert.deepEqual(
		findSessionConfigSymbolsUsedWithoutImport(source),
		[],
		"the guard must be `use implies import`, not `must import every export`",
	);
});

testCase("getConfigFilePath is declared exactly once, so the config path cannot be redefined", () => {
	const declarations = indexSource.match(/function getConfigFilePath/g) ?? [];
	assert.equal(
		declarations.length,
		1,
		`index.ts must declare function getConfigFilePath exactly once (found ${declarations.length}); ` +
			"a duplicate definition is a TS2393 duplicate implementation error",
	);
});

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
