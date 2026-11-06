/**
 * Unit tests for dependency-wave computation, allowedFiles overlap detection and
 * escalated-wave integration/rollback wiring.
 *
 * - computeDependencyWaves must split topologically ready tasks into sequential
 *   sub-waves whenever their allowedFiles overlap.
 * - Escalated host edits must be merged into the SAME published wave layer
 *   (`includeHostEdits`) instead of publishing an extra un-snapshotted layer.
 * - Rollback must use the recorded parent Layer (`targetParentLayerId`) so a whole
 *   merged chain can be restored atomically.
 * - The shared harness (test-kit.ts) must capture throwing cases and settle the
 *   exit status exactly once.
 *
 * Every assertion here observes a runtime outcome; none of them reads a source
 * file as text, because such checks fail on renames but not on bugs.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LayerFSEngine } from "./layerfs-engine.ts";
import type { TaskSpec } from "./types.ts";
import { allowedFilesOverlap, computeDependencyWaves, patternsOverlap } from "./verifier.ts";
import { createSyncTestRunner } from "./test-kit.ts";

const runner = createSyncTestRunner();
const testCase = runner.testCase;

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

	testCase("./ and // are normalized before comparing a file against a directory", () => {
		// Normalization is observable behavior: the same logical path must overlap
		// no matter how many "./" or "/" spellings the caller used.
		assert.equal(patternsOverlap("./src//a.ts", "src/"), true);
		assert.equal(patternsOverlap("./src//a.ts", "src/a.ts"), true);
		assert.equal(patternsOverlap("src//", "./src"), true);
		assert.equal(allowedFilesOverlap(["./src//a.ts"], ["src/"]), true);
	});

	testCase("allowedFilesOverlap honors ** and ? wildcards across pattern lists", () => {
		// `**` covers any depth, `?` covers exactly one character: a shipped defect
		// in either expansion lets two tasks write the same file concurrently.
		assert.equal(allowedFilesOverlap(["docs/**"], ["docs/deep/nested/file.md"]), true);
		assert.equal(allowedFilesOverlap(["src/**/*.ts"], ["src/a/b/c.ts"]), true);
		assert.equal(allowedFilesOverlap(["src/a?c.ts"], ["src/abc.ts"]), true);
		assert.equal(patternsOverlap("src/a?.ts", "src/abc.ts"), false);
		assert.equal(allowedFilesOverlap(["src/*.ts"], ["src/*.tsx", "docs/*"]), false);
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

	testCase("a task overlapping its dependency still runs in a later wave", () => {
		// T2 depends on T1 and overlaps it; T3 is independent but overlaps T1 too.
		// Observable contract: dependencies always defer a task to a later wave, and
		// an independent overlapping task is spilled behind the overlap, not merged.
		const result = computeDependencyWaves([
			task("T1", [], ["src/**"]),
			task("T2", ["T1"], ["src/a.ts"]),
			task("T3", [], ["src/a.ts"]),
		]);
		assert.equal(result.error, undefined);
		assert.deepEqual(result.waves, [["T1"], ["T3"], ["T2"]]);
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


// Shared harness (test-kit.ts): this suite delegates pass/fail counting,
// printing and the exit status instead of keeping a private runner copy.

/**
 * Redirects `console.log`/`console.error` into an array for probe assertions.
 * `restore()` puts the originals back.
 */
function captureConsoleLines(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const originals = { log: console.log, error: console.error };
	const sink = (...args: unknown[]): void => {
		lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
	};
	console.log = sink as typeof console.log;
	console.error = sink as typeof console.error;
	return {
		lines,
		restore: (): void => {
			console.log = originals.log;
			console.error = originals.error;
		},
	};
}

function harnessConsolidationTests(): void {
	console.log("shared test harness (test-kit.ts)");

	testCase("required: a throwing case is captured and finish() reports once", () => {
		const { lines, restore } = captureConsoleLines();
		const previousExitCode = process.exitCode;
		Reflect.set(process, "exitCode", undefined);

		try {
			const probe = createSyncTestRunner();
			let escaped: unknown;
			try {
				probe.testCase("probe: throwing case", () => {
					throw new Error("boom");
				});
				probe.testCase("probe: green case", () => {});
			} catch (err) {
				escaped = err;
			}
			assert.equal(escaped, undefined, "a throwing case must be captured, never rethrown");
			assert.equal(process.exitCode, undefined, "only finish() may settle the exit status");

			probe.finish();
			assert.equal(process.exitCode, 1, "finish() must set process.exitCode = 1 on any failure");
			const failureOutput = lines.join("\n");
			assert.match(failureOutput, /  FAIL probe: throwing case/);
			assert.match(failureOutput, /boom/);
			assert.match(failureOutput, /1 test\(s\) failed, 1 passed\./);
			assert.match(failureOutput, /--- probe: throwing case ---/);

			const printsBeforeRepeat = lines.length;
			probe.finish();
			assert.equal(
				lines.length,
				printsBeforeRepeat,
				"a repeated finish() must not print the summary twice",
			);

			const labeled = createSyncTestRunner();
			labeled.testCase(
				"probe: acceptance failure",
				() => {
					throw new Error("labeled boom");
				},
				"验收 1",
			);
			labeled.finish();
			assert.equal(process.exitCode, 1);
			assert.match(lines.join("\n"), /  FAIL probe: acceptance failure（验收 1）/);

			const green = createSyncTestRunner();
			green.testCase("probe: green suite", () => {}, "验收 2");
			green.finish();
			assert.equal(process.exitCode, 0, "finish() must set process.exitCode = 0 when nothing failed");
			assert.match(lines.join("\n"), /All 1 test\(s\) passed\./);
		} finally {
			restore();
			Reflect.set(process, "exitCode", previousExitCode);
		}
	});

	testCase("required: createSyncTestRunner reports 1 passed / 1 failed and an idempotent finish()", () => {
		const { lines, restore } = captureConsoleLines();
		const previousExitCode = process.exitCode;
		Reflect.set(process, "exitCode", undefined);

		try {
			const probe = createSyncTestRunner();
			let escaped: unknown;
			try {
				probe.testCase("probe: passing case", () => {});
				probe.testCase("probe: throwing case", () => {
					throw new Error("probe boom");
				});
			} catch (err) {
				escaped = err;
			}
			assert.equal(escaped, undefined, "a throwing case must be captured, never rethrown");

			probe.finish();
			assert.equal(process.exitCode, 1, "1 passed / 1 failed must settle process.exitCode = 1");
			assert.match(
				lines.join("\n"),
				/1 test\(s\) failed, 1 passed\./,
				"finish() must report exactly 1 passed and 1 failed",
			);

			const countsBeforeRepeat = lines.slice();
			probe.finish();
			assert.deepEqual(
				lines,
				countsBeforeRepeat,
				"a second finish() must not change the counts or reprint the summary",
			);
			assert.equal(process.exitCode, 1, "the second finish() must keep process.exitCode = 1");
		} finally {
			restore();
			Reflect.set(process, "exitCode", previousExitCode);
		}
	});

	testCase("required: an empty run reports zero passes and exits 0", () => {
		const { lines, restore } = captureConsoleLines();
		const previousExitCode = process.exitCode;
		Reflect.set(process, "exitCode", 1);
		// Regex, not a literal needle: this suite must not look like a runner copy.
		const emptySummary = /^All 0 test\(s\) passed\.$/;

		try {
			const probe = createSyncTestRunner();
			probe.finish();
			assert.equal(
				process.exitCode,
				0,
				"a run with zero cases has no failure, so it must settle process.exitCode = 0",
			);
			const summaryLines = lines.filter((line) => emptySummary.test(line));
			assert.equal(
				summaryLines.length,
				1,
				`finish() must print exactly one zero-pass summary (actual: ${JSON.stringify(lines)})`,
			);
			assert.match(lines[lines.length - 1] ?? "", emptySummary);
		} finally {
			restore();
			Reflect.set(process, "exitCode", previousExitCode);
		}
	});

	testCase("required: createSyncTestRunner sets process.exitCode = 0 for an all-passing run", () => {
		const { lines, restore } = captureConsoleLines();
		const previousExitCode = process.exitCode;
		Reflect.set(process, "exitCode", 1);

		try {
			const probe = createSyncTestRunner();
			probe.testCase("probe: healthy case", () => {});
			probe.finish();
			assert.equal(
				process.exitCode,
				0,
				"an all-passing run must settle process.exitCode = 0 even after a previous failure",
			);
			assert.match(lines.join("\n"), /All 1 test\(s\) passed\./);
		} finally {
			restore();
			Reflect.set(process, "exitCode", previousExitCode);
		}
	});
}

overlapTests();
waveTests();
escalatedWaveTests();
harnessConsolidationTests();
cleanup();

runner.finish();
