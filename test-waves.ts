/**
 * Unit tests for dependency-wave computation, allowedFiles overlap detection and
 * escalated-wave integration/rollback wiring.
 *
 * Covers docs/orchestrator-issues.md Section 7 items 6, 7 and 8:
 * - computeDependencyWaves must split topologically ready tasks into sequential
 *   sub-waves whenever their allowedFiles overlap.
 * - Escalated host edits must be merged into the SAME published wave layer
 *   (`includeHostEdits`) instead of publishing an extra un-snapshotted layer.
 * - Rollback must use the recorded parent Layer (`targetParentLayerId`) so a whole
 *   merged chain can be restored atomically.
 * It also guards package.json and the documentation against regressions.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LayerFSEngine } from "./layerfs-engine.ts";
import type { TaskSpec } from "./types.ts";
import { allowedFilesOverlap, computeDependencyWaves, patternsOverlap } from "./verifier.ts";

let passed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

function testCase(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures.push({ name, error: err });
		console.error(`  FAIL ${name}`);
		console.error(err instanceof Error ? err.message : String(err));
	}
}

function task(
	id: string,
	dependsOn: string[] = [],
	allowedFiles: string[] = [`src/${id.toLowerCase()}.ts`],
): TaskSpec {
	return {
		id,
		title: `Task ${id}`,
		description: `implementation for ${id}`,
		dependsOn,
		allowedFiles,
		testFiles: [`test-${id.toLowerCase()}.ts`],
		testCommand: "node ./test-waves.ts",
		interfaceContract: "",
		acceptanceCriteria: [],
		requiredTestCases: [],
	};
}

// ---------------------------------------------------------------------------
// patternsOverlap / allowedFilesOverlap
// ---------------------------------------------------------------------------

function overlapTests(): void {
	console.log("patternsOverlap / allowedFilesOverlap");

	testCase("identical literal paths overlap", () => {
		assert.equal(patternsOverlap("src/a.ts", "src/a.ts"), true);
	});

	testCase("directory prefix of a nested file overlaps (both directions)", () => {
		assert.equal(patternsOverlap("src", "src/a.ts"), true);
		assert.equal(patternsOverlap("src/a.ts", "src"), true);
	});

	testCase("multi-segment directory prefix overlaps", () => {
		assert.equal(patternsOverlap("src/lib", "src/lib/deep/nested.ts"), true);
		assert.equal(patternsOverlap("src/lib/deep/nested.ts", "src/lib"), true);
	});

	testCase("glob matches concrete path", () => {
		assert.equal(patternsOverlap("src/*.ts", "src/a.ts"), true);
		assert.equal(patternsOverlap("src/a.ts", "src/*.ts"), true);
	});

	testCase("recursive glob matches nested path", () => {
		assert.equal(patternsOverlap("src/**", "src/a/b.ts"), true);
		assert.equal(patternsOverlap("src/**", "src/sub/b.ts"), true);
	});

	testCase("recursive glob matches a plain directory (directory covers its descendants)", () => {
		assert.equal(patternsOverlap("src/**", "src"), true);
		assert.equal(patternsOverlap("src", "src/**"), true);
	});

	testCase("double-star glob overlaps shallow glob", () => {
		assert.equal(patternsOverlap("src/**", "src/*.ts"), true);
		assert.equal(patternsOverlap("**", "src/*.ts"), true);
	});

	testCase("overlapping globs with disjoint-looking suffix sets intersect", () => {
		assert.equal(patternsOverlap("src/*.ts", "src/foo.*"), true);
		assert.equal(patternsOverlap("src/foo.*", "src/*.ts"), true);
	});

	testCase("overlapping globs across nested star segments intersect", () => {
		assert.equal(patternsOverlap("src/*/a.ts", "src/b/*.ts"), true);
		assert.equal(patternsOverlap("src/**/x.ts", "src/*/*/x.ts"), true);
		assert.equal(patternsOverlap("src/**/*.ts", "src/**/*.spec.ts"), true);
	});

	testCase("single-character glob intersects literals", () => {
		assert.equal(patternsOverlap("src/a?", "src/ab"), true);
		assert.equal(patternsOverlap("src/a?c", "src/a*c"), true);
	});

	testCase("disjoint literal paths do not overlap", () => {
		assert.equal(patternsOverlap("src/a.ts", "src/b.ts"), false);
	});

	testCase("disjoint sibling directories do not overlap", () => {
		assert.equal(patternsOverlap("src/a", "src/b"), false);
		assert.equal(patternsOverlap("src", "test"), false);
	});

	testCase("glob extensions that differ do not overlap", () => {
		assert.equal(patternsOverlap("src/*.ts", "src/*.js"), false);
		assert.equal(patternsOverlap("src/*.ts", "src/*.tsx"), false);
	});

	testCase("sibling glob roots do not overlap", () => {
		assert.equal(patternsOverlap("src/*.ts", "test/*.ts"), false);
		assert.equal(patternsOverlap("docs/*.md", "src/*.ts"), false);
	});

	testCase("dot in a pattern is a literal, not a regex wildcard", () => {
		assert.equal(patternsOverlap("src/a.ts", "src/ats"), false);
	});

	testCase("trailing slashes are normalized away", () => {
		assert.equal(patternsOverlap("src/", "src/a.ts"), true);
		assert.equal(patternsOverlap("src///", "src"), true);
		assert.equal(patternsOverlap("src/lib/", "src/lib/a.ts"), true);
	});

	testCase("leading ./ and backslashes are normalized away", () => {
		assert.equal(patternsOverlap("./src", "src/a.ts"), true);
		assert.equal(patternsOverlap("src\\a.ts", "src/a.ts"), true);
		assert.equal(patternsOverlap("./src/*.ts", "src/a.ts"), true);
	});

	testCase("empty patterns never overlap", () => {
		assert.equal(patternsOverlap("", ""), false);
		assert.equal(patternsOverlap("", "src/a.ts"), false);
		assert.equal(patternsOverlap("src/a.ts", ""), false);
		assert.equal(allowedFilesOverlap([], ["src/a.ts"]), false);
		assert.equal(allowedFilesOverlap(["src/a.ts"], []), false);
		assert.equal(allowedFilesOverlap([""], [""]), false);
	});

	testCase("allowedFilesOverlap true for any overlapping pair", () => {
		assert.equal(
			allowedFilesOverlap(["docs/readme.md", "src/shared.ts"], ["src/other.ts", "src/shared.ts"]),
			true,
		);
		assert.equal(allowedFilesOverlap(["src"], ["src/a.ts"]), true);
		assert.equal(allowedFilesOverlap(["src/*.ts"], ["src/foo.*"]), true);
	});

	testCase("allowedFilesOverlap false when no pair overlaps", () => {
		assert.equal(allowedFilesOverlap(["src/a.ts"], ["src/b.ts"]), false);
		assert.equal(allowedFilesOverlap(["src/*.ts", "docs/*.md"], ["src/*.js", "tests/*.ts"]), false);
	});
}

// ---------------------------------------------------------------------------
// computeDependencyWaves
// ---------------------------------------------------------------------------

function waveTests(): void {
	console.log("computeDependencyWaves");

	testCase("required: independent tasks split when allowedFiles overlap", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/shared.ts"]),
			task("T2", [], ["src/shared.ts"]),
			task("T3", [], ["src/other.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1", "T3"], ["T2"]]);
	});

	testCase("required: topological deps and sub-wave splitting combine", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/**"]),
			task("T2", [], ["src/index.ts"]),
			task("T3", ["T1", "T2"], ["tests/t3.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1"], ["T2"], ["T3"]]);
	});

	testCase("non-overlapping ready tasks stay in a single wave", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/a.ts"]),
			task("T2", [], ["src/b.ts"]),
			task("T3", [], ["src/c.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1", "T2", "T3"]]);
	});

	testCase("greedy first-fit packing keeps declaration order", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/a.ts"]),
			task("T2", [], ["src/b.ts"]),
			task("T3", [], ["src/a.ts"]),
			task("T4", [], ["src/b.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1", "T2"], ["T3", "T4"]]);
	});

	testCase("greedy packing starts a new sub-wave only on overlap", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/a.ts"]),
			task("T2", [], ["src/a.ts"]),
			task("T3", [], ["src/b.ts"]),
			task("T4", [], ["src/c.ts"]),
			task("T5", [], ["src/b.ts"]),
		]);
		assert.equal(result.error, undefined);
		// T3 and T4 fill the gaps of sub-wave 1; T5 overlaps T3 -> sub-wave 2.
		assert.deepEqual(result.waves, [["T1", "T3", "T4"], ["T2", "T5"]]);
	});

	testCase("simple chain produces one task per wave", () => {
		const result = computeDependencyWaves([
			task("A", [], ["src/a.ts"]),
			task("B", ["A"], ["src/a.ts"]),
			task("C", ["B"], ["src/a.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["A"], ["B"], ["C"]]);
	});

	testCase("diamond dependency graph keeps parallel siblings in one wave", () => {
		const result = computeDependencyWaves([
			task("A", [], ["src/a.ts"]),
			task("B", ["A"], ["src/b.ts"]),
			task("C", ["A"], ["src/c.ts"]),
			task("D", ["B", "C"], ["src/d.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["A"], ["B", "C"], ["D"]]);
	});

	testCase("dependency implying overlap is already serialized by topology", () => {
		const result = computeDependencyWaves([
			task("T1", [], ["src/x.ts"]),
			task("T2", ["T1"], ["src/x.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1"], ["T2"]]);
	});

	testCase("empty task list yields no waves", () => {
		const result = computeDependencyWaves([]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, []);
	});

	testCase("single task yields one wave", () => {
		const result = computeDependencyWaves([task("T1")]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1"]]);
	});

	testCase("required: duplicate task IDs produce an error, not a throw", () => {
		const result = computeDependencyWaves([task("T1"), task("T1")]);
		assert.equal(result.waves.length, 0);
		assert.equal(result.error, 'Duplicate task ID: "T1"');
	});

	testCase("required: unknown dependency produces an error, not a throw", () => {
		const result = computeDependencyWaves([task("T1", ["NOPE"])]);
		assert.equal(result.waves.length, 0);
		assert.equal(result.error, 'Task "T1" depends on unknown task "NOPE".');
	});

	testCase("required: self dependency produces an error, not a throw", () => {
		const result = computeDependencyWaves([task("T1", ["T1"])]);
		assert.equal(result.waves.length, 0);
		assert.equal(result.error, 'Task "T1" cannot depend on itself.');
	});

	testCase("required: two-node cycle produces an error, not a throw", () => {
		const result = computeDependencyWaves([task("A", ["B"]), task("B", ["A"])]);
		assert.equal(result.waves.length, 0);
		assert.match(result.error ?? "", /^Cyclic dependency detected among tasks:/);
		assert.match(result.error ?? "", /A/);
		assert.match(result.error ?? "", /B/);
	});

	testCase("three-node cycle produces an error", () => {
		const result = computeDependencyWaves([
			task("A", ["C"]),
			task("B", ["A"]),
			task("C", ["B"]),
		]);
		assert.equal(result.waves.length, 0);
		assert.match(result.error ?? "", /^Cyclic dependency detected among tasks:/);
	});

	testCase("cycle error only lists tasks stuck in the cycle", () => {
		const result = computeDependencyWaves([
			task("OK", [], ["src/ok.ts"]),
			task("A", ["B"], ["src/a.ts"]),
			task("B", ["A"], ["src/b.ts"]),
		]);
		assert.equal(result.waves.length, 0);
		assert.equal(result.error, "Cyclic dependency detected among tasks: A, B");
	});

	testCase("waves never contain duplicate ids and preserve every task", () => {
		const tasks = [
			task("T1", [], ["src/**"]),
			task("T2", [], ["src/a.ts"]),
			task("T3", [], ["src/b.ts"]),
			task("T4", ["T1", "T2", "T3"], ["tests/*.ts"]),
		];
		const result = computeDependencyWaves(tasks);
		assert.equal(result.error, undefined);
		const flat = result.waves.flat();
		assert.equal(flat.length, tasks.length);
		assert.deepEqual([...flat].sort(), ["T1", "T2", "T3", "T4"]);
		assert.equal(new Set(flat).size, flat.length);
		// T1 sorts first into sub-wave 1; T2 overlaps T1 -> sub-wave 2; T3 overlaps
		// neither T1's `src/**`? it does, so it lands after T1's slot too.
		assert.deepEqual(result.waves, [["T1"], ["T2", "T3"], ["T4"]]);
	});
}

// ---------------------------------------------------------------------------
// Escalated wave integration + rollback (LayerFS end-to-end simulation)
// ---------------------------------------------------------------------------

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const cleanupPaths: string[] = [];
let projectCounter = 0;

function nextProjectId(): string {
	projectCounter += 1;
	return `orch-waves-${process.pid}-${Date.now()}-${projectCounter}`;
}

function cleanup(): void {
	for (const target of cleanupPaths) {
		fs.rmSync(target, { recursive: true, force: true });
	}
	cleanupPaths.length = 0;
}

function readRepoFile(relPath: string): string {
	return fs.readFileSync(path.join(repoRoot, relPath), "utf-8");
}

/** Returns the slice of `src` between `startMarker` and `endMarker`. */
function sourceBetween(src: string, startMarker: string, endMarker: string): string {
	const start = src.indexOf(startMarker);
	assert.notEqual(start, -1, `missing marker: ${startMarker}`);
	const end = src.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
	return src.slice(start, end);
}

function escalatedWaveTests(): void {
	console.log("escalated wave merge & rollback (LayerFS end-to-end)");

	testCase(
		"required: 1 approved branch + 1 escalated host task publish ONE wave layer and roll back cleanly",
		() => {
			const host = fs.mkdtempSync(path.join(os.tmpdir(), "orch-waves-host-"));
			cleanupPaths.push(host);
			fs.writeFileSync(path.join(host, "shared.txt"), "base\n", "utf-8");
			fs.writeFileSync(path.join(host, "keep.txt"), "keep\n", "utf-8");

			const engine = new LayerFSEngine(host, nextProjectId());
			cleanupPaths.push(engine.getMetrics().storeRoot);

			const l1 = engine.importHostAsLayer("Initial plan import");
			assert.equal(l1.layerId, "L1");

			// T1: approved subagent branch forked from the wave base.
			const t1Branch = engine.forkBranch("task-t1", "L1");
			const t1Workspace = engine.mountWorkspace("task-t1");
			fs.writeFileSync(
				path.join(t1Workspace.workspacePath, "branch-t1.txt"),
				"t1 branch edit\n",
				"utf-8",
			);
			engine.commitWorkspace("task-t1", "T1 implementation", t1Branch.headCommitId);

			// T2: escalated -> the Lead edited the host working tree directly.
			fs.writeFileSync(path.join(host, "escalated-t2.txt"), "t2 host edit\n", "utf-8");

			// Mirror the exact `orch_integrate` wiring in index.ts.
			const taskStatuses: Record<string, string> = { T1: "approved", T2: "escalated" };
			const branchNames: Record<string, string> = { T1: "task-t1", T2: "task-t2" };
			const currentWaveIds = ["T1", "T2"];
			const escalatedIds = currentWaveIds.filter(
				(id) => taskStatuses[id] === "escalated",
			);
			assert.deepEqual(escalatedIds, ["T2"]);
			const approvedBranches = currentWaveIds
				.filter((id) => taskStatuses[id] === "approved")
				.map((id) => branchNames[id]);
			assert.deepEqual(approvedBranches, ["task-t1"]);

			const mergeResult = engine.mergeAndPublishWave(approvedBranches, {
				allowAutoThreeWayLineMerge: true,
				message: "Wave 1: approved T1 + escalated T2",
				expectedBaseLayerId: "L1",
				includeHostEdits: escalatedIds.length > 0,
			});
			assert.equal(mergeResult.ok, true, mergeResult.error);
			assert.equal(mergeResult.publishedLayerId, "L2");
			assert.equal(
				engine.getHeadLayerId(),
				"L2",
				"escalated host edits must NOT publish an extra, un-snapshotted layer",
			);
			assert.equal(mergeResult.treeRegressionWarning, undefined);

			// The single wave layer L2 contains BOTH the branch edits and the host edits.
			const l2Tree = engine.getLayerTree("L2");
			assert.ok("branch-t1.txt" in l2Tree, "L2 must contain T1's branch edit");
			assert.ok("escalated-t2.txt" in l2Tree, "L2 must contain T2's escalated host edit");
			assert.ok("shared.txt" in l2Tree, "L2 must keep the unchanged base file");
			assert.equal(
				fs.readFileSync(path.join(host, "branch-t1.txt"), "utf-8"),
				"t1 branch edit\n",
			);
			assert.equal(
				fs.readFileSync(path.join(host, "escalated-t2.txt"), "utf-8"),
				"t2 host edit\n",
			);
			const verified = engine.verifyHostMatchesLayer("L2");
			assert.equal(verified.matches, true, verified.mismatches.join("; "));

			// Rollback uses the recorded parent Layer (mirrors `orch_rollback_integration`).
			const rollback = engine.rollbackPublishedLayer("L2", { targetParentLayerId: "L1" });
			assert.equal(rollback.ok, true, rollback.message);
			assert.equal(rollback.restoredLayerId, "L1");
			assert.equal(engine.getHeadLayerId(), "L1");
			assert.equal(fs.existsSync(path.join(host, "branch-t1.txt")), false);
			assert.equal(fs.existsSync(path.join(host, "escalated-t2.txt")), false);
			assert.equal(fs.readFileSync(path.join(host, "shared.txt"), "utf-8"), "base\n");
			assert.equal(engine.verifyHostMatchesLayer("L1").matches, true);
		},
	);
}

// ---------------------------------------------------------------------------
// index.ts wiring, package.json and issue-doc guards
// ---------------------------------------------------------------------------

function wiringTests(): void {
	console.log("index.ts / package.json / docs wiring");

	testCase("required: index.ts imports computeDependencyWaves from verifier.ts (no local copy)", () => {
		const src = readRepoFile("index.ts");
		assert.match(
			src,
			/import\s*\{[\s\S]*?\bcomputeDependencyWaves\b[\s\S]*?\}\s*from\s*"\.\/verifier\.ts";/,
			"computeDependencyWaves must be imported from ./verifier.ts",
		);
		assert.doesNotMatch(
			src,
			/function\s+computeDependencyWaves\s*\(/,
			"the duplicate local computeDependencyWaves definition must be removed",
		);
	});

	testCase("required: orch_integrate passes includeHostEdits and reuses treeRegressionWarning", () => {
		const src = readRepoFile("index.ts");
		const block = sourceBetween(src, 'name: "orch_integrate"', 'name: "orch_retry_integration"');
		assert.match(block, /const\s+escalatedIds\s*=\s*currentWaveIds\.filter\(/);
		assert.match(block, /includeHostEdits:\s*escalatedIds\.length\s*>\s*0/);
		assert.ok(
			block.indexOf("const escalatedIds") < block.indexOf("engine.mergeAndPublishWave("),
			"escalatedIds must be computed BEFORE merging so includeHostEdits can be passed",
		);
		assert.match(
			block,
			/reimportWarning\s*=\s*`\\n⚠ \$\{mergeResult\.treeRegressionWarning\}`/,
			"reimportWarning must come from mergeResult.treeRegressionWarning",
		);
		assert.equal(
			block.includes("engine.importHostAsLayer("),
			false,
			"escalated host edits must not be re-imported as an extra layer",
		);
	});

	testCase("required: orch_rollback_integration passes the recorded parent layer", () => {
		const src = readRepoFile("index.ts");
		const block = sourceBetween(
			src,
			'name: "orch_rollback_integration"',
			'name: "orch_status"',
		);
		assert.match(
			block,
			/rollbackPublishedLayer\(\s*rec\.publishedLayerId\s*,\s*\{\s*targetParentLayerId:\s*rec\.parentLayerId\s*\}\s*\)/,
		);
	});

	testCase("required: package.json test script runs test.ts, test-regressions.ts and test-waves.ts", () => {
		const pkg = JSON.parse(readRepoFile("package.json")) as { scripts?: Record<string, string> };
		const script = pkg.scripts?.test ?? "";
		const parts = script
			.split("&&")
			.map((part) => part.trim())
			.filter(Boolean);
		assert.deepEqual(parts, [
			"node ./test.ts",
			"node ./test-regressions.ts",
			"node ./test-waves.ts",
		]);
	});

	testCase("required: docs Section 7 items 6/7/8 document the completed fixes", () => {
		const docs = readRepoFile("docs/orchestrator-issues.md");
		const section = docs.split("### 顺带排查出的其他潜在问题")[1] ?? "";
		assert.ok(section.trim().length > 0, "Section 7 must exist");

		const itemMap = new Map<number, string>();
		let current: number | undefined;
		for (const line of section.split("\n")) {
			const heading = /^(\d+)\.\s+(.*)$/.exec(line);
			if (heading) {
				current = Number(heading[1]);
				itemMap.set(current, heading[2]);
			} else if (current !== undefined && line.trim()) {
				itemMap.set(current, `${itemMap.get(current)}\n${line.trim()}`);
			}
		}

		for (const index of [6, 7, 8]) {
			const item = itemMap.get(index);
			assert.ok(item, `Section 7 item ${index} must exist`);
			assert.doesNotMatch(
				item,
				/未改动|未修复|遗留限制|已知限制/,
				`Section 7 item ${index} must no longer be documented as an unfixed limitation`,
			);
			assert.match(
				item,
				/已[^。\n]{0,60}(修复|实现|改为|按此策略落地)/,
				`Section 7 item ${index} must describe the implemented fix`,
			);
		}

		assert.match(itemMap.get(6) ?? "", /allowedFiles|子波次/);
		assert.match(itemMap.get(7) ?? "", /合并|校验/);
		assert.match(itemMap.get(8) ?? "", /includeHostEdits|targetParentLayerId/);
	});
}

overlapTests();
waveTests();
escalatedWaveTests();
wiringTests();
cleanup();

console.log("");
if (failures.length > 0) {
	console.error(`${failures.length} test(s) failed, ${passed} passed.`);
	for (const f of failures) {
		console.error(`\n--- ${f.name} ---`);
		console.error(f.error instanceof Error ? f.error.stack ?? f.error.message : String(f.error));
	}
	process.exitCode = 1;
} else {
	console.log(`All ${passed} test(s) passed.`);
	process.exitCode = 0;
}
