import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LayerFSEngine } from "./layerfs-engine.ts";
import type { TaskSpec } from "./types.ts";
import { runMechanicalVerificationGate } from "./verifier.ts";
import { SCRATCH_DIR_NAMES, scratchDirs } from "./workspace-env.ts";

const STORE_ROOT = path.join(os.homedir(), ".pi", "agent", "orchestrator-layerfs");

/**
 * Single source of the `src/math.js` fixture used by this suite.
 *
 * The fixture is needed three times (the initial host import, the task-t3 edit that rewrites
 * `add`, and the task-t4 edit that rewrites `sub`); the only difference between those copies is
 * the body of the two functions, so the shared 7 lines live here and the callers pass only the
 * return statements they need. `mathJs()` reproduces the original file byte-for-byte.
 */
function mathJs(addReturn = "return a + b;", subReturn = "return a - b;"): string {
	return [
		"function add(a, b) {",
		`  ${addReturn}`,
		"}",
		"",
		"function sub(a, b) {",
		`  ${subReturn}`,
		"}",
		"",
		"module.exports = { add, sub };",
	].join("\n");
}

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
		"task-t1": "B\nA\nB\nC",
		"task-t2": "A\nC",
		"task-t3": "A\nB\nX\nC",
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
		"task-t1": "B\nA\nB\nC",
		"task-t2": "A\nC",
		"task-t3": "A\nB2\nC",
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

	{
		const sandbox = await createSandbox("t2-mode-single", { "script.sh": content });
		try {
			fs.chmodSync(path.join(sandbox.hostDir, "script.sh"), 0o644);
			const baseLayer = sandbox.engine.importHostAsLayer("base import");
			assert.equal(baseLayer.tree["script.sh"].mode, 0o644, "base entry mode must be 0o644");

			sandbox.engine.forkBranch("task-mode", "L1");
			const ws = sandbox.engine.mountWorkspace("task-mode");
			const workspaceFile = path.join(ws.workspacePath, "script.sh");
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

			fs.chmodSync(path.join(wsMode.workspacePath, "script.sh"), 0o755);
			sandbox.engine.commitWorkspace("task-mode", "chmod +x script.sh");

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

/**
 * Ablation oracle for the LAST hidden link: the `.tmp` / `.cache` scratch convention must
 * have exactly ONE definition (`SCRATCH_DIR_NAMES` in workspace-env.ts). `layerfs-engine.ts`
 * spreads that same tuple into `IGNORED_DIRS`, so renaming a scratch dir in one place moves
 * both the scratch paths AND the import exclusion together.
 *
 * This is deliberately behavioural: it imports a real host tree and inspects the produced
 * LayerFS layer tree, instead of trusting the source text.
 */
async function testScratchDirsAreTheSingleSourceOfTruth() {
	// A host import must never capture scratch dirs.
	const sandbox = await createSandbox("t3-scratch-ignore", {
		".tmp/junk.txt": "ephemeral tmp output\n",
		".cache/junk.txt": "ephemeral cache output\n",
		"src/keep.txt": "keep me\n",
	});
	try {
		const layer = sandbox.engine.importHostAsLayer("scratch ignore import");
		const paths = Object.keys(sandbox.engine.getLayerTree(layer.layerId));

		assert.equal(
			paths.includes(".tmp/junk.txt"),
			false,
			`imported layer must exclude the tmp scratch file, got ${JSON.stringify(paths)}`,
		);
		assert.equal(
			paths.includes(".cache/junk.txt"),
			false,
			`imported layer must exclude the cache scratch file, got ${JSON.stringify(paths)}`,
		);
		for (const scratchName of SCRATCH_DIR_NAMES) {
			assert.equal(
				paths.some((p) => p === scratchName || p.startsWith(`${scratchName}/`)),
				false,
				`imported layer must exclude every path under SCRATCH_DIR_NAMES entry ${scratchName}`,
			);
		}
		assert.equal(
			paths.includes("src/keep.txt"),
			true,
			`imported layer must keep ordinary files, got ${JSON.stringify(paths)}`,
		);
	} finally {
		sandbox.cleanup();
	}

	// The scratch dirs ARE the tuple of path names.
	assert.deepEqual(
		[...SCRATCH_DIR_NAMES],
		[".tmp", ".cache"],
		"SCRATCH_DIR_NAMES must stay the documented .tmp/.cache pair",
	);
	const dirs = scratchDirs("root");
	assert.equal(dirs.tmpDir, path.join("root", ".tmp"), "scratchDirs('root').tmpDir must be root/.tmp");
	assert.equal(
		dirs.cacheDir,
		path.join("root", ".cache"),
		"scratchDirs('root').cacheDir must be root/.cache",
	);
	assert.equal(
		path.basename(dirs.tmpDir),
		SCRATCH_DIR_NAMES[0],
		"tmpDir basename must be SCRATCH_DIR_NAMES[0] -- one source of truth",
	);
	assert.equal(
		path.basename(dirs.cacheDir),
		SCRATCH_DIR_NAMES[1],
		"cacheDir basename must be SCRATCH_DIR_NAMES[1] -- one source of truth",
	);
}

/**
 * Ablation oracle for the mismatch cap collapse: more than 50 corrupted host files must
 * still stop at exactly 50 mismatches after at most one extra path was checked.
 */
async function testHostMismatchCapIsFifty() {
	const files: Record<string, string> = {};
	for (let i = 0; i < 60; i++) files[`tracked/file-${String(i).padStart(2, "0")}.txt`] = `original-${i}\n`;
	const sandbox = await createSandbox("t3-mismatch-cap", files);
	try {
		sandbox.engine.importHostAsLayer("cap import");
		for (let i = 0; i < 60; i++) {
			fs.writeFileSync(
				path.join(sandbox.hostDir, `tracked/file-${String(i).padStart(2, "0")}.txt`),
				`corrupted-${i}-${"x".repeat(32)}\n`,
				"utf-8",
			);
		}

		const verification = sandbox.engine.verifyHostMatchesLayer();
		assert.equal(verification.matches, false, "60 corrupted files must not match the layer");
		assert.equal(
			verification.mismatches.length,
			50,
			`mismatch list must be capped at 50, got ${verification.mismatches.length}`,
		);
		assert.ok(
			verification.checked <= 51,
			`verification must stop early (<=51 paths checked), checked ${verification.checked}`,
		);
		assert.equal(verification.layerId, "L1", "verification must report the verified layer id");
	} finally {
		sandbox.cleanup();
	}
}

/** Single-file host drift: one deleted file and one modified file must both be reported. */
async function testSingleFileHostDriftMessages() {
	const sandbox = await createSandbox("t3-single-drift", {
		"keep.txt": "keep\n",
		"gone.txt": "gone\n",
	});
	try {
		sandbox.engine.importHostAsLayer("drift import");

		fs.rmSync(path.join(sandbox.hostDir, "gone.txt"));
		const afterDelete = sandbox.engine.verifyHostMatchesLayer();
		assert.equal(afterDelete.matches, false, "a deleted tracked file must not match the layer");
		assert.equal(afterDelete.mismatches.length, 1, "exactly one drift entry expected");
		assert.ok(
			afterDelete.mismatches[0].startsWith("gone.txt: "),
			`mismatch must name the deleted path, got: ${afterDelete.mismatches[0]}`,
		);
		assert.match(
			afterDelete.mismatches[0],
			/missing or unreadable/,
			`deleted file mismatch must say 'missing or unreadable', got: ${afterDelete.mismatches[0]}`,
		);

		fs.writeFileSync(path.join(sandbox.hostDir, "keep.txt"), "keep-modified\n", "utf-8");
		const afterModify = sandbox.engine.verifyHostMatchesLayer();
		assert.equal(afterModify.matches, false, "a modified tracked file must not match the layer");
		assert.ok(
			afterModify.mismatches.some((message) => message === "keep.txt: content mismatch"),
			`modified file must report 'keep.txt: content mismatch', got: ${JSON.stringify(afterModify.mismatches)}`,
		);
	} finally {
		sandbox.cleanup();
	}
}

/**
 * Ablation oracle for deleting `threeWayMergeText`: three branches editing three DIFFERENT
 * lines of one base file must still merge into a host file containing all three edits.
 */
async function testThreeBranchDisjointLineMergePublishesAllEdits() {
	const baseText = "line-1\nline-2\nline-3\nline-4\nline-5\n";
	const sandbox = await buildLineMergeWave("t3-three-way-ablation", "shared.txt", baseText, {
		"task-a": "LINE-1\nline-2\nline-3\nline-4\nline-5\n",
		"task-b": "line-1\nline-2\nLINE-3\nline-4\nline-5\n",
		"task-c": "line-1\nline-2\nline-3\nline-4\nLINE-5\n",
	});
	try {
		const result = sandbox.engine.mergeAndPublishWave(["task-a", "task-b", "task-c"], {
			allowAutoThreeWayLineMerge: true,
			message: "three-way ablation merge",
		});
		assert.equal(
			result.ok,
			true,
			`3-branch disjoint line merge must succeed, conflicts: ${JSON.stringify(result.conflicts)}`,
		);
		assert.deepEqual(result.conflicts, [], "disjoint 3-branch merge must not report conflicts");

		const mergedOnHost = fs.readFileSync(path.join(sandbox.hostDir, "shared.txt"), "utf-8");
		assert.equal(
			mergedOnHost,
			"LINE-1\nline-2\nLINE-3\nline-4\nLINE-5\n",
			`merged host file must contain all three branch edits, got: ${JSON.stringify(mergedOnHost)}`,
		);

		const published = sandbox.engine.loadLayer(result.publishedLayerId!);
		const entry = published.tree["shared.txt"];
		assert.ok(entry, "published layer must contain shared.txt");
		assert.equal(
			sandbox.engine.readCanonicalBlob(entry.objectId).toString("utf-8"),
			mergedOnHost,
			"published blob must match the merged host text",
		);
	} finally {
		sandbox.cleanup();
	}
}

async function runTests() {
	const tmpHost = await fs.promises.mkdtemp(path.join(os.tmpdir(), "orch-test-host-"));
	const testProjectId = `test-proj-${Date.now()}`;

	try {
		fs.mkdirSync(path.join(tmpHost, "src"), { recursive: true });
		fs.mkdirSync(path.join(tmpHost, "tests"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpHost, "src", "math.js"),
			mathJs(),
			"utf-8",
		);
		fs.writeFileSync(path.join(tmpHost, ".env"), "SECRET_KEY=do_not_import\n", "utf-8");

		const engine = new LayerFSEngine(tmpHost, testProjectId);

		const l1 = engine.importHostAsLayer("Initial import");
		assert.equal(l1.layerId, "L1");
		assert.ok(l1.tree["src/math.js"], "src/math.js should be in Layer L1");
		assert.equal(l1.tree[".env"], undefined, ".env secret file must be excluded from LayerFS store");

		const b1 = engine.forkBranch("task-t1", "L1");
		const b2 = engine.forkBranch("task-t2", "L1");
		assert.equal(b1.baseLayerId, "L1");
		assert.equal(b2.baseLayerId, "L1");

		const ws1 = engine.mountWorkspace("task-t1");
		const ws2 = engine.mountWorkspace("task-t2");

		assert.ok(fs.existsSync(ws1.tmpDir));
		assert.ok(fs.existsSync(ws1.cacheDir));
		fs.writeFileSync(path.join(ws1.tmpDir, "scratch.txt"), "ephemeral", "utf-8");

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

		assert.throws(
			() => engine.commitWorkspace("task-t1", "Stale commit", ws1.headCommitId),
			/CAS Conflict/,
		);

		const diff1 = engine.diffBranch("task-t1", ["tests/multiply.test.js"]);
		assert.equal(diff1.files.length, 2);
		assert.match(diff1.implUnifiedDiff, /src\/multiply\.js/);
		assert.match(diff1.testUnifiedDiff, /tests\/multiply\.test\.js/);

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

		const mergeRes = engine.mergeAndPublishWave(["task-t1", "task-t2"], {
			allowAutoThreeWayLineMerge: true,
			message: "Wave 1 complete",
		});
		assert.equal(mergeRes.ok, true);
		assert.equal(mergeRes.publishedLayerId, "L2");
		assert.ok(fs.existsSync(path.join(tmpHost, "src", "multiply.js")));
		assert.ok(fs.existsSync(path.join(tmpHost, "src", "divide.js")));

		engine.forkBranch("task-t3", "L2");
		engine.forkBranch("task-t4", "L2");
		const ws3 = engine.mountWorkspace("task-t3");
		const ws4 = engine.mountWorkspace("task-t4");

		fs.writeFileSync(
			path.join(ws3.workspacePath, "src", "math.js"),
			mathJs("return Number(a) + Number(b);"),
			"utf-8",
		);
		engine.commitWorkspace("task-t3", "Update add");

		fs.writeFileSync(
			path.join(ws4.workspacePath, "src", "math.js"),
			mathJs("return a + b;", "return Number(a) - Number(b);"),
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

		await testMultiBranchDisjointLineMergeIsOrderIndependent();
		await testMultiBranchDeleteModifyConflictIsOrderIndependent();
		await testModeOnlyChangeIsMergedAndPublished();

		await testScratchDirsAreTheSingleSourceOfTruth();
		await testHostMismatchCapIsFifty();
		await testSingleFileHostDriftMessages();
		await testThreeBranchDisjointLineMergePublishesAllEdits();

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
