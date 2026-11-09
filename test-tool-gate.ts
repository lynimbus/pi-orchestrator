/**
 * Unit tests for tool-gate.ts — the pure decisions that keep the orch_* tools out of
 * reach while orchestrator mode is OFF.
 *
 * The reproduced bug this guards: with `orchestrator.json` set to `"enabled": false`,
 * all eight orch tools were still declared to the model and their `execute` ran anyway,
 * so a disabled session could call `orch_status`. The gate is the single place that
 * answers "is this name an orch tool", "must this call be blocked", and "which names may
 * a run declare", so index.ts and the tests cannot drift apart.
 *
 * Every assertion here is on an observable outcome: the returned boolean, the returned
 * object, the returned array (its contents, its order and its identity), the untouched
 * input array, and the module source (no imports at all).
 *
 * Run with: node ./test-tool-gate.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import {
	ORCHESTRATOR_MODE_TOOL_NAME,
	ORCHESTRATOR_TOOL_NAMES,
	declaredToolsForRun,
	isOrchestratorTool,
	orchestratorToolGate,
} from "./tool-gate.ts";
import { createSyncTestRunner } from "./test-kit.ts";

/** The one shared harness: pass/fail counting, printing and exit status. */
const runner = createSyncTestRunner();
const testCase = runner.testCase;

/** The eight tools registered by index.ts, spelled out so a rename cannot slip through. */
const DOCUMENTED_TOOL_NAMES = [
	"orch_plan",
	"orch_wave0_commit",
	"orch_dispatch",
	"orch_review",
	"orch_integrate",
	"orch_retry_integration",
	"orch_rollback_integration",
	"orch_status",
];

function toolNameTests(): void {
	console.log("ORCHESTRATOR_TOOL_NAMES");

	testCase(
		"ORCHESTRATOR_TOOL_NAMES deep-equals the eight registered names in order, without duplicates",
		() => {
			assert.deepEqual([...ORCHESTRATOR_TOOL_NAMES], DOCUMENTED_TOOL_NAMES);
			assert.equal(new Set(ORCHESTRATOR_TOOL_NAMES).size, DOCUMENTED_TOOL_NAMES.length);
			assert.equal(ORCHESTRATOR_TOOL_NAMES.length, 8);
		}
	);

	console.log("isOrchestratorTool");

	testCase(
		"isOrchestratorTool is true for every ORCHESTRATOR_TOOL_NAMES entry",
		() => {
			for (const name of ORCHESTRATOR_TOOL_NAMES) {
				assert.equal(isOrchestratorTool(name), true, name);
			}
		}
	);

	testCase(
		"isOrchestratorTool has no prefix or wildcard matching ('orch', 'orch_', 'orch_planx', 'my_orch_plan')",
		() => {
			assert.equal(isOrchestratorTool("orch"), false);
			assert.equal(isOrchestratorTool("orch_"), false);
			assert.equal(isOrchestratorTool("orch_planx"), false);
			assert.equal(isOrchestratorTool("my_orch_plan"), false);
			assert.equal(isOrchestratorTool("orch_*"), false);
		}
	);

	testCase(
		"isOrchestratorTool is false for non-orch tools and non-strings",
		() => {
			assert.equal(isOrchestratorTool("read"), false);
			assert.equal(isOrchestratorTool("bash"), false);
			assert.equal(isOrchestratorTool("edit"), false);
			assert.equal(isOrchestratorTool("write"), false);
			assert.equal(isOrchestratorTool("codemode"), false);
			assert.equal(isOrchestratorTool("ORCH_STATUS"), false);
			assert.equal(isOrchestratorTool(" orch_status"), false);
			assert.equal(isOrchestratorTool(undefined), false);
			assert.equal(isOrchestratorTool(null), false);
			assert.equal(isOrchestratorTool(7), false);
			assert.equal(isOrchestratorTool({ name: "orch_status" }), false);
			assert.equal(isOrchestratorTool(["orch_status"]), false);
		}
	);
}

function gateTests(): void {
	console.log("orchestratorToolGate");

	testCase(
		'orchestratorToolGate("orch_status", false) blocks with a reason naming orch_mode and the tool',
		() => {
			const decision = orchestratorToolGate("orch_status", false);
			assert.notEqual(decision, undefined);
			const block = decision as { block: true; reason: string };
			assert.equal(block.block, true);
			assert.equal(typeof block.reason, "string");
			assert.match(block.reason, /orch_mode/);
			assert.match(block.reason, /orch_status/);
			assert.equal(block.reason.includes("\n"), false, "the reason must be one line");
		}
	);

	testCase(
		"orchestratorToolGate blocks every ORCHESTRATOR_TOOL_NAMES entry when disabled, naming each tool",
		() => {
			for (const name of ORCHESTRATOR_TOOL_NAMES) {
				const decision = orchestratorToolGate(name, false);
				assert.notEqual(decision, undefined, name);
				const block = decision as { block: true; reason: string };
				assert.equal(block.block, true, name);
				assert.match(block.reason, /orch_mode/, name);
				assert.equal(block.reason.includes(name), true, name);
				assert.equal(block.reason.includes("\n"), false, name);
			}
		}
	);

	testCase(
		"orchestratorToolGate allows every ORCHESTRATOR_TOOL_NAMES entry when enabled",
		() => {
			for (const name of ORCHESTRATOR_TOOL_NAMES) {
				assert.equal(orchestratorToolGate(name, true), undefined, name);
			}
		}
	);

	testCase('orchestratorToolGate("orch_plan", true) is undefined', () => {
		assert.equal(orchestratorToolGate("orch_plan", true), undefined);
	});

	testCase(
		"orchestratorToolGate never blocks non-orch tools, enabled or not",
		() => {
			const nonOrchNames = ["read", "bash", "edit", "write", "codemode", "orch", "orch_", "orch_planx"];
			for (const name of nonOrchNames) {
				assert.equal(orchestratorToolGate(name, false), undefined, name);
				assert.equal(orchestratorToolGate(name, true), undefined, name);
			}
			assert.equal(orchestratorToolGate(undefined, false), undefined);
			assert.equal(orchestratorToolGate(undefined, true), undefined);
			assert.equal(orchestratorToolGate(7, false), undefined);
		}
	);
}

function declarationTests(): void {
	console.log("declaredToolsForRun");

	testCase(
		"declaredToolsForRun drops all eight orch tools and keeps the rest in order when disabled",
		() => {
			const selected = ["read", ...ORCHESTRATOR_TOOL_NAMES, "bash"];
			assert.deepEqual(declaredToolsForRun(selected, false), ["read", "bash"]);
		}
	);

	testCase(
		"declaredToolsForRun removes every occurrence of a repeated orch tool when disabled",
		() => {
			assert.deepEqual(
				declaredToolsForRun(["orch_status", "read", "orch_plan", "orch_status", "bash"], false),
				["read", "bash"],
			);
		}
	);

	testCase(
		"declaredToolsForRun returns equal contents and order in a NEW array when enabled",
		() => {
			const selected = ["read", "orch_plan", "bash"];
			const declared = declaredToolsForRun(selected, true);
			assert.deepEqual(declared, ["read", "orch_plan", "bash"]);
			assert.notEqual(declared, selected);
			assert.deepEqual(declared, [...selected]);
		}
	);

	testCase(
		"declaredToolsForRun([] , false) and declaredToolsForRun([], true) are empty arrays",
		() => {
			assert.deepEqual(declaredToolsForRun([], false), []);
			assert.deepEqual(declaredToolsForRun([], true), []);
		}
	);

	testCase(
		"declaredToolsForRun returns a NEW array even when there is no orch tool to remove",
		() => {
			const selected = ["read", "bash"];
			const declared = declaredToolsForRun(selected, false);
			assert.deepEqual(declared, ["read", "bash"]);
			assert.notEqual(declared, selected);
			assert.deepEqual(declaredToolsForRun(selected, true), ["read", "bash"]);
		}
	);

	testCase(
		"declaredToolsForRun never mutates the input array",
		() => {
			const selected = ["read", "orch_plan", "orch_status", "bash"];
			const snapshot = JSON.stringify(selected);
			const declaredDisabled = declaredToolsForRun(selected, false);
			assert.equal(JSON.stringify(selected), snapshot, "disabled call must leave the input byte-identical");
			assert.deepEqual(selected, ["read", "orch_plan", "orch_status", "bash"]);
			declaredDisabled.push("mutated-by-caller");
			assert.deepEqual(selected, ["read", "orch_plan", "orch_status", "bash"]);

			const declaredEnabled = declaredToolsForRun(selected, true);
			assert.equal(JSON.stringify(selected), snapshot, "enabled call must leave the input byte-identical");
			assert.deepEqual(declaredEnabled, ["read", "orch_plan", "orch_status", "bash"]);
			declaredEnabled.pop();
			assert.equal(JSON.stringify(selected), snapshot);
		}
	);

	testCase(
		"declaredToolsForRun does not mutate an ORCHESTRATOR_TOOL_NAMES-derived selection",
		() => {
			const selected: readonly string[] = [...ORCHESTRATOR_TOOL_NAMES];
			const snapshot = JSON.stringify(selected);
			assert.deepEqual(declaredToolsForRun(selected, false), []);
			assert.equal(JSON.stringify(selected), snapshot);
			assert.deepEqual(declaredToolsForRun(selected, true), DOCUMENTED_TOOL_NAMES);
			assert.equal(JSON.stringify(selected), snapshot);
		}
	);
}

function moduleShapeTests(): void {
	console.log("tool-gate.ts module shape");

	testCase(
		"tool-gate.ts has no imports at all, so plain `node` can load it",
		() => {
			const source = fs.readFileSync(new URL("./tool-gate.ts", import.meta.url), "utf8");
			assert.equal(/^\s*import\b/m.test(source), false, "no static import statements");
			assert.equal(/\bimport\s*\(/.test(source), false, "no dynamic imports");
			assert.equal(/\brequire\s*\(/.test(source), false, "no require() calls");
			assert.equal(source.includes("@earendil-works"), false, "no dependency on a pi package");
		}
	);
}

function main(): void {
	toolNameTests();
	gateTests();
	declarationTests();
	moduleShapeTests();
	runner.finish();
}

main();
