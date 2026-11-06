import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LayerFSEngine } from "./layerfs-engine.ts";
import type { TaskSpec } from "./types.ts";
import { runMechanicalVerificationGate } from "./verifier.ts";

const STORE_ROOT = path.join(os.homedir(), ".pi", "agent", "orchestrator-layerfs");

interface Sandbox {
	hostDir: string;
	projectId: string;
	engine: LayerFSEngine;
	cleanup: () => void;
}

async function createSandbox(tag: string, files: Record<string, string>): Promise<Sandbox> {
	const hostDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `orch-${tag}-host-`));
	for (const [relPath, content] of Object.entries(files)) {
		const full = path.join(hostDir, relPath);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	}
	const projectId = `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const engine = new LayerFSEngine(hostDir, projectId);
	return {
		hostDir,
		projectId,
		engine,
		cleanup: () => {
			fs.rmSync(hostDir, { recursive: true, force: true });
			fs.rmSync(path.join(STORE_ROOT, projectId), { recursive: true, force: true });
		},
	};
}

/** Imports the host as L1, forks one branch per edit and commits `relPath` with the given text. */
async function buildLineMergeWave(
	tag: string,
	relPath: string,
	baseText: string,
	branchEdits: Record<string, string>,
): Promise<Sandbox> {
	const sandbox = await createSandbox(tag, { [relPath]: baseText });
	sandbox.engine.importHostAsLayer("base import");
	for (const [branchName, text] of Object.entries(branchEdits)) {
		sandbox.engine.forkBranch(branchName, "L1");
		const ws = sandbox.engine.mountWorkspace(branchName);
		fs.writeFileSync(path.join(ws.workspacePath, relPath), text, "utf-8");
		sandbox.engine.commitWorkspace(branchName, `edit ${relPath} on ${branchName}`);
	}
	return sandbox;
}

/**
 * Acceptance criterion 3: 3 branches making disjoint edits must merge cleanly in ANY branch order
 * and always produce `B\nA\nX\nC`.
 */
async function testMultiBranchDisjointLineMergeIsOrderIndependent() {
	const baseText = "A\nB\nC";
	const edits = {
		"task-t1": "B\nA\nB\nC", // insert "B" at 0..0
		"task-t2": "A\nC", // delete "B" at 1..2
		"task-t3": "A\nB\nX\nC", // insert "X" at 2..2
	};
	const orders = [
		["task-t1", "task-t2", "task-t3"],
		["task-t1", "task-t3", "task-t2"],
		["task-t3", "task-t2", "task-t1"],
	];

	for (const order of orders) {
		const sandbox = await buildLineMergeWave(
			`t2-disjoint-${order.join("_")}`,
			"shared.txt",
			baseText,
			edits,
		);
		try {
			const result = sandbox.engine.mergeAndPublishWave(order, {
				allowAutoThreeWayLineMerge: true,
				message: `disjoint merge ${order.join(",")}`,
			});
			assert.equal(
				result.ok,
				true,
				`3-branch disjoint merge must succeed for order [${order.join(", ")}], got: ${JSON.stringify(result.conflicts)}`,
			);
			assert.deepEqual(result.conflicts, [], "disjoint merge must not report conflicts");
			assert.ok(result.publishedLayerId, "disjoint merge must publish a layer");

			const mergedOnHost = fs.readFileSync(path.join(sandbox.hostDir, "shared.txt"), "utf-8");
			assert.equal(
				mergedOnHost,
				"B\nA\nX\nC",
				`3-branch disjoint merge must publish 'B\\nA\\nX\\nC' for order [${order.join(", ")}]`,
			);

			const publishedLayer = sandbox.engine.loadLayer(result.publishedLayerId!);
			const publishedEntry = publishedLayer.tree["shared.txt"];
			assert.ok(publishedEntry, "published layer must contain shared.txt");
			const publishedText = sandbox.engine
				.readCanonicalBlob(publishedEntry.objectId)
				.toString("utf-8");
			assert.equal(
				publishedText,
				"B\nA\nX\nC",
				`published layer blob must be 'B\\nA\\nX\\nC' for order [${order.join(", ")}]`,
			);
		} finally {
			sandbox.cleanup();
		}
	}
}

/**
 * Acceptance criteria 1 & 2: a delete/modify conflict on the same base line must be reported for
 * EVERY branch order (and never silently collapse into `B2\nA\nC`).
 */
async function testMultiBranchDeleteModifyConflictIsOrderIndependent() {
	const baseText = "A\nB\nC";
	const edits = {
		"task-t1": "B\nA\nB\nC", // insert "B" at 0..0
		"task-t2": "A\nC", // delete "B" at 1..2
		"task-t3": "A\nB2\nC", // modify "B" -> "B2" at 1..2
	};
	const orders = [
		["task-t1", "task-t2", "task-t3"],
		["task-t2", "task-t3", "task-t1"],
		["task-t3", "task-t1", "task-t2"],
	];

	for (const order of orders) {
		const sandbox = await buildLineMergeWave(
			`t2-conflict-${order.join("_")}`,
			"shared.txt",
			baseText,
			edits,
		);
		try {
			const result = sandbox.engine.mergeAndPublishWave(order, {
				allowAutoThreeWayLineMerge: true,
				message: `conflicting merge ${order.join(",")}`,
			});
			assert.equal(
				result.ok,
				false,
				`delete/modify conflict must be reported for order [${order.join(", ")}]`,
			);
			assert.equal(result.publishedLayerId, undefined, "conflicting merge must not publish a layer");
			assert.ok(result.conflicts.length > 0, "conflicting merge must report at least one conflict");
			const conflict = result.conflicts.find((c) => c.path === "shared.txt");
			assert.ok(conflict, `conflict must be reported on shared.txt for order [${order.join(", ")}]`);
			assert.match(conflict!.reason, /Overlapping line modifications/);

			// Host must be untouched (no silent corruption to 'B2\nA\nC' / 'B\nA\nC').
			const hostText = fs.readFileSync(path.join(sandbox.hostDir, "shared.txt"), "utf-8");
			assert.equal(hostText, baseText, "conflicting merge must leave the host file untouched");
		} finally {
			sandbox.cleanup();
		}
	}
}

/**
 * Acceptance criterion 4: a mode-only change (chmod +x, identical bytes) must be detected and
 * published to the new layer and to the host file mode.
 */
async function testModeOnlyChangeIsMergedAndPublished() {
	const content = "#!/bin/sh\necho hi\n";

	// (a) single-branch mode-only change
	{
		const sandbox = await createSandbox("t2-mode-single", { "script.sh": content });
		try {
			fs.chmodSync(path.join(sandbox.hostDir, "script.sh"), 0o644);
			const baseLayer = sandbox.engine.importHostAsLayer("base import");
			assert.equal(baseLayer.tree["script.sh"].mode, 0o644, "base entry mode must be 0o644");

			sandbox.engine.forkBranch("task-mode", "L1");
			const ws = sandbox.engine.mountWorkspace("task-mode");
			const workspaceFile = path.join(ws.workspacePath, "script.sh");
			// chmod only: byte contents stay identical
			fs.chmodSync(workspaceFile, 0o755);
			assert.equal(fs.readFileSync(workspaceFile, "utf-8"), content);
			sandbox.engine.commitWorkspace("task-mode", "chmod +x script.sh");

			const result = sandbox.engine.mergeAndPublishWave(["task-mode"], {
				allowAutoThreeWayLineMerge: true,
				message: "mode-only merge",
			});
			assert.equal(result.ok, true, `mode-only merge must succeed: ${result.error ?? ""}`);
			const published = sandbox.engine.loadLayer(result.publishedLayerId!);
			const entry = published.tree["script.sh"];
			assert.ok(entry, "published layer must still contain script.sh");
			assert.equal(entry.mode, 0o755, "published layer entry must record mode 0o755");
			assert.equal(
				entry.objectId,
				baseLayer.tree["script.sh"].objectId,
				"mode-only change must keep the same content objectId",
			);
			const hostMode = fs.statSync(path.join(sandbox.hostDir, "script.sh")).mode & 0o777;
			assert.equal(hostMode, 0o755, "host file mode must be updated to 0o755");
			assert.equal(
				fs.readFileSync(path.join(sandbox.hostDir, "script.sh"), "utf-8"),
				content,
				"host file content must be preserved",
			);
		} finally {
			sandbox.cleanup();
		}
	}

	// (b) multi-branch: one branch chmods, another edits the bytes -> mode must survive
	const multiBranchOrders = [
		["task-mode", "task-edit"],
		["task-edit", "task-mode"],
	];
	for (const order of multiBranchOrders) {
		const sandbox = await createSandbox(`t2-mode-multi-${order.join("_")}`, {
			"script.sh": content,
		});
		try {
			fs.chmodSync(path.join(sandbox.hostDir, "script.sh"), 0o644);
			const baseLayer = sandbox.engine.importHostAsLayer("base import");
			assert.equal(baseLayer.tree["script.sh"].mode, 0o644);

			sandbox.engine.forkBranch("task-mode", "L1");
			sandbox.engine.forkBranch("task-edit", "L1");
			const wsMode = sandbox.engine.mountWorkspace("task-mode");
			const wsEdit = sandbox.engine.mountWorkspace("task-edit");

			// Mode-only touch on branch 1
			fs.chmodSync(path.join(wsMode.workspacePath, "script.sh"), 0o755);
			sandbox.engine.commitWorkspace("task-mode", "chmod +x script.sh");

			// Content-only touch on branch 2 (keeps 0o644)
			fs.writeFileSync(
				path.join(wsEdit.workspacePath, "script.sh"),
				"#!/bin/sh\necho bye\n",
				"utf-8",
			);
			sandbox.engine.commitWorkspace("task-edit", "change greeting");

			const result = sandbox.engine.mergeAndPublishWave(order, {
				allowAutoThreeWayLineMerge: true,
				message: `mode + content merge ${order.join(",")}`,
			});
			assert.equal(
				result.ok,
				true,
				`mode+content merge must succeed for order [${order.join(", ")}]: ${result.error ?? ""}`,
			);
			assert.deepEqual(result.conflicts, []);
			const published = sandbox.engine.loadLayer(result.publishedLayerId!);
			const entry = published.tree["script.sh"];
			assert.ok(entry, "published layer must contain script.sh");
			assert.equal(entry.mode, 0o755, "multi-branch merge must preserve the 0o755 mode change");
			assert.equal(
				sandbox.engine.readCanonicalBlob(entry.objectId).toString("utf-8"),
				"#!/bin/sh\necho bye\n",
				"multi-branch merge must keep the edited content",
			);
			const hostMode = fs.statSync(path.join(sandbox.hostDir, "script.sh")).mode & 0o777;
			assert.equal(hostMode, 0o755, "host mode must stay 0o755 after the merged wave");
		} finally {
			sandbox.cleanup();
		}
	}

	// (c) both branches only chmod -> convergent entry with mode 0o755
	{
		const sandbox = await createSandbox("t2-mode-both", { "script.sh": content });
		try {
			fs.chmodSync(path.join(sandbox.hostDir, "script.sh"), 0o644);
			sandbox.engine.importHostAsLayer("base import");
			for (const branchName of ["task-mode-a", "task-mode-b"]) {
				sandbox.engine.forkBranch(branchName, "L1");
				const ws = sandbox.engine.mountWorkspace(branchName);
				fs.chmodSync(path.join(ws.workspacePath, "script.sh"), 0o755);
				sandbox.engine.commitWorkspace(branchName, `chmod +x on ${branchName}`);
			}
			const result = sandbox.engine.mergeAndPublishWave(["task-mode-a", "task-mode-b"], {
				allowAutoThreeWayLineMerge: true,
				message: "convergent mode-only merge",
			});
			assert.equal(result.ok, true, `convergent mode merge must succeed: ${result.error ?? ""}`);
			const published = sandbox.engine.loadLayer(result.publishedLayerId!);
			assert.equal(published.tree["script.sh"].mode, 0o755);
			assert.equal(
				fs.statSync(path.join(sandbox.hostDir, "script.sh")).mode & 0o777,
				0o755,
				"host mode must be 0o755 after a convergent mode-only wave merge",
			);
		} finally {
			sandbox.cleanup();
		}
	}
}

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

		// T2 regressions: N-way line merge order independence, conflict soundness, mode-only touches.
		await testMultiBranchDisjointLineMergeIsOrderIndependent();
		await testMultiBranchDeleteModifyConflictIsOrderIndependent();
		await testModeOnlyChangeIsMergedAndPublished();

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
