import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LayerFSEngine } from "./layerfs-engine.ts";
import type { TaskSpec } from "./types.ts";
import { runMechanicalVerificationGate } from "./verifier.ts";

async function runTests() {
	const tmpHost = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orch-test-host-"));
	const testProjectId = `test-proj-${Date.now()}`;

	try {
		// Create initial files in host
		fs.mkdirSync(path.join(tmpHost, "src"), { recursive: true });
		fs.mkdirSync(path.join(tmpHost, "tests"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpHost, "src", "math.js"),
			[
				"function add(a, b) {",
				"  return a + b;",
				"}",
				"",
				"function sub(a, b) {",
				"  return a - b;",
				"}",
				"",
				"module.exports = { add, sub };",
			].join("\n"),
			"utf-8",
		);
		fs.writeFileSync(path.join(tmpHost, ".env"), "SECRET_KEY=do_not_import\n", "utf-8");

		const engine = new LayerFSEngine(tmpHost, testProjectId);

		// 1. Test initial Layer import & secret filtering
		const l1 = engine.importHostAsLayer("Initial import");
		assert.equal(l1.layerId, "L1");
		assert.ok(l1.tree["src/math.js"], "src/math.js should be in Layer L1");
		assert.equal(l1.tree[".env"], undefined, ".env secret file must be excluded from LayerFS store");

		// 2. Fork two parallel branches from L1
		const b1 = engine.forkBranch("task-t1", "L1");
		const b2 = engine.forkBranch("task-t2", "L1");
		assert.equal(b1.baseLayerId, "L1");
		assert.equal(b2.baseLayerId, "L1");

		const ws1 = engine.mountWorkspace("task-t1");
		const ws2 = engine.mountWorkspace("task-t2");

		// Scratch .tmp and .cache must exist
		assert.ok(fs.existsSync(ws1.tmpDir));
		assert.ok(fs.existsSync(ws1.cacheDir));
		fs.writeFileSync(path.join(ws1.tmpDir, "scratch.txt"), "ephemeral", "utf-8");

		// Task T1 adds multiply.js + tests/multiply.test.js
		fs.writeFileSync(
			path.join(ws1.workspacePath, "src", "multiply.js"),
			"exports.multiply = (a, b) => a * b;\n",
			"utf-8",
		);
		fs.mkdirSync(path.join(ws1.workspacePath, "tests"), { recursive: true });
		fs.writeFileSync(
			path.join(ws1.workspacePath, "tests", "multiply.test.js"),
			[
				"const assert = require('node:assert/strict');",
				"const { multiply } = require('../src/multiply.js');",
				"assert.equal(multiply(3, 4), 12);",
				"assert.equal(multiply(0, 9), 0);",
			].join("\n"),
			"utf-8",
		);

		const c1 = engine.commitWorkspace("task-t1", "Implement multiply", ws1.headCommitId);
		assert.equal(c1.tree[".tmp/scratch.txt"], undefined, ".tmp scratch files must never be committed");

		// CAS check: committing again with stale expectedHeadCommitId must throw
		assert.throws(
			() => engine.commitWorkspace("task-t1", "Stale commit", ws1.headCommitId),
			/CAS Conflict/,
		);

		// Diff check: implementation diff and test diff must be separated
		const diff1 = engine.diffBranch("task-t1", ["tests/multiply.test.js"]);
		assert.equal(diff1.files.length, 2);
		assert.match(diff1.implUnifiedDiff, /src\/multiply\.js/);
		assert.match(diff1.testUnifiedDiff, /tests\/multiply\.test\.js/);

		// 3. Test Mechanical Verification Gate (Passing case)
		const spec1: TaskSpec = {
			id: "T1",
			title: "Implement multiply",
			description: "Add multiply function",
			dependsOn: [],
			allowedFiles: ["src/multiply.js"],
			testFiles: ["tests/multiply.test.js"],
			testCommand: "node tests/multiply.test.js",
			interfaceContract: "multiply(a: number, b: number): number",
			acceptanceCriteria: ["Returns product of a and b"],
			requiredTestCases: [{ input: "3, 4", expected: "12" }],
		};

		const gate1 = await runMechanicalVerificationGate(
			spec1,
			ws1.workspacePath,
			diff1,
			"status: DONE\ntask: T1\n## 新增测试\n- multiply test\n## 假设\n- 无",
		);
		assert.equal(gate1.gateReport.passed, true, "Mechanical gate should pass for valid T1");
		assert.equal(gate1.workerReport.status, "DONE");

		// 4. Test Mechanical Gate Failures (Tampering with .only and out-of-scope file)
		fs.writeFileSync(
			path.join(ws2.workspacePath, "src", "unauthorized.js"),
			"exports.bad = true;\n",
			"utf-8",
		);
		fs.mkdirSync(path.join(ws2.workspacePath, "tests"), { recursive: true });
		fs.writeFileSync(
			path.join(ws2.workspacePath, "tests", "divide.test.js"),
			"describe.only('cheating test', () => { expect(1).toBe(1); });\n",
			"utf-8",
		);
		engine.commitWorkspace("task-t2", "Bad attempt", ws2.headCommitId);
		const diff2Bad = engine.diffBranch("task-t2", ["tests/divide.test.js"]);

		const spec2: TaskSpec = {
			id: "T2",
			title: "Implement divide",
			description: "Add divide function",
			dependsOn: [],
			allowedFiles: ["src/divide.js"],
			testFiles: ["tests/divide.test.js"],
			testCommand: "node -e 'process.exit(0)'",
			interfaceContract: "divide(a, b)",
			acceptanceCriteria: ["Divides a by b"],
			requiredTestCases: [{ input: "6, 2", expected: "3" }],
		};

		const gate2Bad = await runMechanicalVerificationGate(
			spec2,
			ws2.workspacePath,
			diff2Bad,
			"status: DONE",
		);
		assert.equal(gate2Bad.gateReport.passed, false);
		assert.equal(gate2Bad.gateReport.checks.fileScope.passed, false, "Should catch unauthorized.js");
		assert.equal(gate2Bad.gateReport.checks.testIntegrity.passed, false, "Should catch .only()");

		// Fix T2 in its workspace and re-commit
		fs.rmSync(path.join(ws2.workspacePath, "src", "unauthorized.js"));
		fs.writeFileSync(
			path.join(ws2.workspacePath, "src", "divide.js"),
			"exports.divide = (a, b) => a / b;\n",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(ws2.workspacePath, "tests", "divide.test.js"),
			"const assert = require('node:assert/strict');\nconst { divide } = require('../src/divide.js');\nassert.equal(divide(6, 2), 3);\n",
			"utf-8",
		);
		engine.commitWorkspace("task-t2", "Fixed T2");
		const diff2Good = engine.diffBranch("task-t2", ["tests/divide.test.js"]);
		const gate2Good = await runMechanicalVerificationGate(
			spec2,
			ws2.workspacePath,
			diff2Good,
			"status: DONE",
		);
		assert.equal(gate2Good.gateReport.passed, true, "Fixed T2 should pass gate");

		// 5. Merge Wave 1 (T1 + T2) and publish Layer L2 to host
		const mergeRes = engine.mergeAndPublishWave(["task-t1", "task-t2"], {
			allowAutoThreeWayLineMerge: true,
			message: "Wave 1 complete",
		});
		assert.equal(mergeRes.ok, true);
		assert.equal(mergeRes.publishedLayerId, "L2");
		assert.ok(fs.existsSync(path.join(tmpHost, "src", "multiply.js")));
		assert.ok(fs.existsSync(path.join(tmpHost, "src", "divide.js")));

		// 6. Test 3-Way Line Merge on the same file (disjoint hunks in src/math.js)
		engine.forkBranch("task-t3", "L2");
		engine.forkBranch("task-t4", "L2");
		const ws3 = engine.mountWorkspace("task-t3");
		const ws4 = engine.mountWorkspace("task-t4");

		// T3 modifies top of src/math.js
		fs.writeFileSync(
			path.join(ws3.workspacePath, "src", "math.js"),
			[
				"function add(a, b) {",
				"  return Number(a) + Number(b);",
				"}",
				"",
				"function sub(a, b) {",
				"  return a - b;",
				"}",
				"",
				"module.exports = { add, sub };",
			].join("\n"),
			"utf-8",
		);
		engine.commitWorkspace("task-t3", "Update add");

		// T4 modifies bottom of src/math.js
		fs.writeFileSync(
			path.join(ws4.workspacePath, "src", "math.js"),
			[
				"function add(a, b) {",
				"  return a + b;",
				"}",
				"",
				"function sub(a, b) {",
				"  return Number(a) - Number(b);",
				"}",
				"",
				"module.exports = { add, sub };",
			].join("\n"),
			"utf-8",
		);
		engine.commitWorkspace("task-t4", "Update sub");

		const mergeWave2 = engine.mergeAndPublishWave(["task-t3", "task-t4"], {
			allowAutoThreeWayLineMerge: true,
			message: "Wave 2 disjoint line merge",
		});
		assert.equal(mergeWave2.ok, true, "Disjoint hunks in src/math.js should 3-way merge cleanly");
		const mergedMath = fs.readFileSync(path.join(tmpHost, "src", "math.js"), "utf-8");
		assert.match(mergedMath, /Number\(a\) \+ Number\(b\)/);
		assert.match(mergedMath, /Number\(a\) - Number\(b\)/);

		console.log("ALL LAYERFS ENGINE & MECHANICAL GATE TESTS PASSED!");
	} finally {
		fs.rmSync(tmpHost, { recursive: true, force: true });
		fs.rmSync(
			path.join(os.homedir(), ".pi", "agent", "orchestrator-layerfs", testProjectId),
			{ recursive: true, force: true },
		);
	}
}

runTests().catch((err) => {
	console.error(err);
	process.exit(1);
});
