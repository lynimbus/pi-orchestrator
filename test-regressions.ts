/**
 * Regression tests for the failures documented in docs/orchestrator-issues.md
 * plus extra latent issues found while auditing the extension.
 *
 * Run with: node ./test-regressions.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { LayerFSEngine } from "./layerfs-engine.ts";
import {
	decideIntegrationAction,
	decideRetryIntegrationAction,
	decideRollbackIntegrationAction,
	reconcileIntegrationRecord,
} from "./integration-state.ts";
import type { OrchestrationPlan } from "./types.ts";
import { executeWorkspaceCommand } from "./verifier.ts";

let counter = 0;
function nextProjectId(): string {
	counter += 1;
	return `orch-reg-${process.pid}-${Date.now()}-${counter}`;
}

function makeHost(files: Record<string, string>): string {
	const host = fs.mkdtempSync(path.join(os.tmpdir(), "orch-reg-host-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(host, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	}
	return host;
}

function readHost(host: string, rel: string): string | undefined {
	try {
		return fs.readFileSync(path.join(host, rel), "utf-8");
	} catch {
		return undefined;
	}
}

function listHostFiles(host: string): string[] {
	const out: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of fs.readdirSync(dir)) {
			if (name === ".tmp" || name === ".cache") continue;
			const full = path.join(dir, name);
			const stat = fs.lstatSync(full);
			const rel = prefix ? `${prefix}/${name}` : name;
			if (stat.isDirectory()) walk(full, rel);
			else if (stat.isFile() || stat.isSymbolicLink()) out.push(rel);
		}
	};
	walk(host, "");
	return out.sort();
}

/**
 * CJS view of `node:fs`. The engine imports the ESM facade (`import * as fs from "node:fs"`),
 * so assignments must be followed by `syncBuiltinESMExports()` to be visible to it.
 */
const fsCjs = createRequire(import.meta.url)("node:fs") as typeof fs;

/** Records every `fs.readFileSync` that targets a file inside `host` (host-relative paths). */
function patchHostReads(host: string): {
	reads: string[];
	reset: () => void;
	restore: () => void;
} {
	const original = fsCjs.readFileSync;
	const reads: string[] = [];
	(fsCjs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (
		this: unknown,
		target: fs.PathOrFileDescriptor,
		...rest: unknown[]
	) {
		if (typeof target === "string") {
			const rel = path.relative(host, target).replace(/\\/g, "/");
			if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) reads.push(rel);
		}
		return (original as (...args: unknown[]) => unknown).call(this, target, ...rest);
	} as typeof fs.readFileSync;
	syncBuiltinESMExports();
	return {
		reads,
		reset: () => {
			reads.length = 0;
		},
		restore: () => {
			(fsCjs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
			syncBuiltinESMExports();
		},
	};
}

/** Makes `fs.rmSync` silently refuse to delete the given absolute paths (simulates leftovers). */
function patchRmSyncBlocked(absolutePaths: string[]): () => void {
	const original = fsCjs.rmSync;
	const blocked = new Set(absolutePaths.map((p) => path.resolve(p)));
	(fsCjs as unknown as { rmSync: typeof fs.rmSync }).rmSync = function (
		this: unknown,
		target: fs.PathLike,
		options?: fs.RmOptions,
	) {
		if (typeof target === "string" && blocked.has(path.resolve(target))) return;
		return (original as (...args: unknown[]) => unknown).call(this, target, options);
	} as typeof fs.rmSync;
	syncBuiltinESMExports();
	return () => {
		(fsCjs as unknown as { rmSync: typeof fs.rmSync }).rmSync = original;
		syncBuiltinESMExports();
	};
}

function readHostJson(filePath: string): any {
	return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

const hosts: string[] = [];
const stores: string[] = [];

function track(engine: LayerFSEngine, host: string) {
	hosts.push(host);
	stores.push(engine.getMetrics().storeRoot);
}

function cleanup() {
	for (const p of [...hosts, ...stores]) {
		fs.rmSync(p, { recursive: true, force: true });
	}
}

/** P1: initial import must include untracked files; warn when a host import drops files. */
function testUntrackedImportAndRegressionWarning() {
	const host = makeHost({
		"tracked.txt": "tracked\n",
		"untracked-new.txt": "new file, not git added\n",
		".env": "SECRET=do_not_import\n",
	});
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);

	const l1 = engine.importHostAsLayer("Initial import");
	assert.ok(l1.tree["tracked.txt"], "tracked file must be in L1");
	assert.ok(l1.tree["untracked-new.txt"], "UNTRACKED file must be in L1 (import scans the host tree, not git ls-files)");
	assert.equal(l1.tree[".env"], undefined, "secret must stay out of the store");
	assert.equal(l1.treeRegressionWarning, undefined);

	fs.rmSync(path.join(host, "tracked.txt"));
	const l2 = engine.importHostAsLayer("Second import", { expectedParentLayerId: "L1" });
	assert.equal(l2.parentLayerId, "L1");
	assert.match(l2.treeRegressionWarning ?? "", /drops 1 file/, "must warn when host import loses files");
	assert.throws(
		() => engine.importHostAsLayer("Stale import", { expectedParentLayerId: "L1" }),
		/Stale host import/,
		"host import must refuse a diverged store head",
	);
}

/** P0: duplicate integrate must be refused and must not touch the host working tree. */
function testDuplicateIntegrateIsRefused() {
	const host = makeHost({ "shared.txt": "base\n", "keep.txt": "keep\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);

	const l1 = engine.importHostAsLayer("Initial plan import");
	assert.equal(l1.layerId, "L1");

	// Wave 0: host edit published as L2 (matches the incident's L1 -> L2 sequence).
	fs.writeFileSync(path.join(host, "shared.txt"), "wave0\n", "utf-8");
	const l2 = engine.importHostAsLayer("Wave 0", { expectedParentLayerId: "L1" });
	assert.equal(l2.layerId, "L2");

	const b1 = engine.forkBranch("task-t1", "L2");
	const b2 = engine.forkBranch("task-t2", "L2");
	const ws1 = engine.mountWorkspace("task-t1");
	const ws2 = engine.mountWorkspace("task-t2");
	fs.writeFileSync(path.join(ws1.workspacePath, "added-by-t1.txt"), "t1\n", "utf-8");
	fs.writeFileSync(path.join(ws2.workspacePath, "added-by-t2.txt"), "t2\n", "utf-8");
	engine.commitWorkspace("task-t1", "T1 work", b1.headCommitId);
	engine.commitWorkspace("task-t2", "T2 work", b2.headCommitId);

	const first = engine.mergeAndPublishWave(["task-t1", "task-t2"], {
		allowAutoThreeWayLineMerge: true,
		message: "Wave 1",
		expectedBaseLayerId: "L2",
	});
	assert.equal(first.ok, true, "first integrate must succeed");
	assert.equal(first.publishedLayerId, "L3");
	assert.equal(first.hostMatchesLayer, true, "host must be verified against the published layer");
	assert.ok(first.rollbackSnapshotId, "a host pre-image snapshot must exist");
	assert.equal(readHost(host, "added-by-t1.txt"), "t1\n");
	assert.equal(readHost(host, "added-by-t2.txt"), "t2\n");
	assert.equal(readHost(host, "shared.txt"), "wave0\n");

	const treeBefore = engine.getLayerTree("L3");
	const hostBefore = listHostFiles(host).map((f) => `${f}:${readHost(host, f)}`).join("|");
	assert.equal(Object.keys(treeBefore).length, 4, "L3 must contain L2 files + both new files");

	// SECOND integrate, exactly as the incident: same wave, same branches, head already L3.
	const duplicateWithExpectedBase = engine.mergeAndPublishWave(["task-t1", "task-t2"], {
		allowAutoThreeWayLineMerge: true,
		message: "Wave 1 (duplicate)",
		expectedBaseLayerId: "L2",
	});
	assert.equal(duplicateWithExpectedBase.ok, false, "duplicate integrate MUST be refused");
	assert.match(duplicateWithExpectedBase.error ?? "", /already integrated|expected base layer/);

	// Even without the plan hint, the stale-branch check must refuse it.
	const duplicateWithoutHint = engine.mergeAndPublishWave(["task-t1", "task-t2"], {
		allowAutoThreeWayLineMerge: true,
		message: "Wave 1 (duplicate, no hint)",
	});
	assert.equal(duplicateWithoutHint.ok, false, "stale branches must be refused even without a plan hint");
	assert.match(duplicateWithoutHint.error ?? "", /Stale branch/);

	assert.equal(engine.getHeadLayerId(), "L3", "no L4 rollback layer may be published");
	assert.equal(
		listHostFiles(host).map((f) => `${f}:${readHost(host, f)}`).join("|"),
		hostBefore,
		"host working tree must be byte-for-byte unchanged after a refused duplicate merge",
	);
	assert.deepEqual(engine.getLayerTree("L3"), treeBefore);
	assert.equal(engine.verifyHostMatchesLayer("L3").matches, true);
}

/** Fork-base diff: cross-branch additions survive; explicit deletions still work. */
function testCrossBranchAdditionsAndExplicitDeletion() {
	const host = makeHost({ "keep.txt": "keep\n", "remove.txt": "bye\n", "base.txt": "base\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	engine.importHostAsLayer("L1");

	const branches: string[] = [];
	for (const [name, addFile] of [
		["b1", "one.txt"],
		["b2", "two.txt"],
		["b3", "three.txt"],
	] as const) {
		const b = engine.forkBranch(name, "L1");
		const ws = engine.mountWorkspace(name);
		fs.writeFileSync(path.join(ws.workspacePath, addFile), `${name}\n`, "utf-8");
		if (name === "b3") fs.rmSync(path.join(ws.workspacePath, "remove.txt"));
		engine.commitWorkspace(name, `${name} work`, b.headCommitId);
		branches.push(name);
	}

	const merged = engine.mergeAndPublishWave(branches, {
		allowAutoThreeWayLineMerge: true,
		message: "Wave with explicit deletion",
	});
	assert.equal(merged.ok, true);
	assert.equal(readHost(host, "one.txt"), "b1\n");
	assert.equal(readHost(host, "two.txt"), "b2\n");
	assert.equal(readHost(host, "three.txt"), "b3\n");
	assert.equal(readHost(host, "remove.txt"), undefined, "explicit deletion must be applied");
	assert.equal(readHost(host, "keep.txt"), "keep\n");
	assert.equal(Object.keys(engine.getLayerTree("L2")).length, 5);
	assert.ok(merged.mergedFiles.some((f) => f.changeType === "deleted" && f.path === "remove.txt"));
}

/** Host pre-image snapshot, host<->layer verification, rollback, and safe re-merge. */
function testSnapshotVerifyAndRollback() {
	const host = makeHost({ "base.txt": "v1\n", "untouched.txt": "same\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	engine.importHostAsLayer("L1");
	const b1 = engine.forkBranch("b1", "L1");
	const ws = engine.mountWorkspace("b1");
	fs.writeFileSync(path.join(ws.workspacePath, "base.txt"), "v2\n", "utf-8");
	fs.writeFileSync(path.join(ws.workspacePath, "new.txt"), "new\n", "utf-8");
	engine.commitWorkspace("b1", "work", b1.headCommitId);

	const merged = engine.mergeAndPublishWave(["b1"], {
		allowAutoThreeWayLineMerge: true,
		message: "publish L2",
	});
	assert.equal(merged.ok, true);
	assert.equal(merged.publishedLayerId, "L2");
	assert.equal(readHost(host, "base.txt"), "v2\n");
	assert.equal(readHost(host, "new.txt"), "new\n");
	assert.equal(engine.verifyHostMatchesLayer("L2").matches, true);

	// Drift detection
	fs.writeFileSync(path.join(host, "base.txt"), "v3\n", "utf-8");
	const drift = engine.verifyHostMatchesLayer("L2");
	assert.equal(drift.matches, false);
	assert.ok(drift.mismatches.some((m) => m.includes("base.txt")));

	// Rollback restores the exact pre-image and rewinds the store head.
	const rollback = engine.rollbackPublishedLayer("L2");
	assert.equal(rollback.ok, true);
	assert.equal(rollback.restoredLayerId, "L1");
	assert.equal(engine.getHeadLayerId(), "L1");
	assert.equal(readHost(host, "base.txt"), "v1\n", "pre-image content restored");
	assert.equal(readHost(host, "new.txt"), undefined, "added file removed");
	assert.equal(readHost(host, "untouched.txt"), "same\n");
	assert.equal(engine.verifyHostMatchesLayer("L1").matches, true);
	assert.equal(engine.rollbackPublishedLayer("L2").ok, false, "cannot roll back a non-head layer");

	// Re-integrating after a rollback must work (branches are forked from the restored head).
	const remerge = engine.mergeAndPublishWave(["b1"], {
		allowAutoThreeWayLineMerge: true,
		message: "re-merge after rollback",
	});
	assert.equal(remerge.ok, true);
	assert.equal(remerge.publishedLayerId, "L3");
	assert.equal(readHost(host, "base.txt"), "v2\n");
	assert.equal(readHost(host, "new.txt"), "new\n");
}

/** Executable bit recorded in the layer must actually reach the host. */
function testExecutableModePropagation() {
	const host = makeHost({ "script.sh": "#!/bin/sh\necho hi\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	engine.importHostAsLayer("L1");
	const b = engine.forkBranch("b1", "L1");
	const ws = engine.mountWorkspace("b1");
	const script = path.join(ws.workspacePath, "script.sh");
	fs.writeFileSync(script, "#!/bin/sh\necho fixed\n", "utf-8");
	fs.chmodSync(script, 0o755);
	engine.commitWorkspace("b1", "chmod", b.headCommitId);
	const merged = engine.mergeAndPublishWave(["b1"], {
		allowAutoThreeWayLineMerge: true,
		message: "chmod publish",
	});
	assert.equal(merged.ok, true);
	const mode = fs.statSync(path.join(host, "script.sh")).mode & 0o777;
	assert.notEqual(mode & 0o111, 0, "executable bit must be applied to the host file");
}

/** P1/P2/P3: scratch dirs, full diagnostics, stray artifact cleanup, abort, timeout. */
async function testWorkspaceCommandDiagnostics() {
	const host = makeHost({ "app.txt": "app\n" });
	hosts.push(host);
	assert.equal(fs.existsSync(path.join(host, ".tmp")), false, "host has no .tmp initially");

	const ok = await executeWorkspaceCommand(
		'tmp="$(mktemp)" && echo hello > "$tmp" && cat "$tmp"',
		host,
	);
	assert.equal(ok.exitCode, 0, "plain mktemp must work with the injected TMPDIR");
	assert.ok(fs.existsSync(path.join(host, ".tmp")), "TMPDIR directory must be created");
	assert.ok(fs.existsSync(path.join(host, ".cache")), "XDG_CACHE_HOME directory must be created");
	assert.match(ok.environment, /TMPDIR=/);
	assert.match(ok.outputHead, /hello/);
	assert.equal(ok.failureLines.length >= 0, true);

	const failing = await executeWorkspaceCommand(
		'echo "ROOT_CAUSE_MARKER: mktemp failed"; for i in $(seq 1 200); do echo "filler line $i"; done; exit 7',
		host,
	);
	assert.equal(failing.exitCode, 7);
	assert.ok(
		failing.failureLines.some((l) => l.includes("ROOT_CAUSE_MARKER")),
		"failure lines must be extracted from the WHOLE output, not just the tail",
	);
	assert.match(failing.outputHead, /ROOT_CAUSE_MARKER/, "output head must survive the rolling buffer");
	assert.ok(!failing.outputTail.includes("ROOT_CAUSE_MARKER"), "tail alone would have lost the root cause");

	const stray = await executeWorkspaceCommand("touch ./-", host, undefined, 120_000, {
		cleanupStrayRootFiles: true,
	});
	assert.equal(stray.exitCode, 0);
	assert.ok(stray.strayArtifacts.includes("-"), "stray root artifact must be reported");
	assert.equal(fs.existsSync(path.join(host, "-")), false, "stray root artifact must be removed");
	assert.equal(fs.existsSync(path.join(host, "app.txt")), true, "pre-existing files must be kept");

	const ac = new AbortController();
	ac.abort();
	const aborted = await executeWorkspaceCommand("echo should-not-run", host, ac.signal);
	assert.equal(aborted.exitCode, 130, "an already-aborted signal must not throw a TDZ error");

	const timedOut = await executeWorkspaceCommand("sleep 5", host, undefined, 60);
	assert.equal(timedOut.exitCode, 124, "timeout must terminate the process and resolve");
	assert.ok(timedOut.durationMs < 4000, "timeout must not hang for the full sleep duration");

	// Integration tests run against the host: scratch dirs may be redirected out of the repo.
	const host2 = makeHost({ "repo.txt": "repo\n" });
	hosts.push(host2);
	const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-scratch-"));
	hosts.push(scratchRoot);
	const redirected = await executeWorkspaceCommand('tmp="$(mktemp)" && echo ok > "$tmp"', host2, undefined, 120_000, {
		scratchRoot,
	});
	assert.equal(redirected.exitCode, 0);
	assert.equal(fs.existsSync(path.join(host2, ".tmp")), false, "host repo must not be polluted");
	assert.equal(fs.existsSync(path.join(scratchRoot, ".tmp")), true);
}

/** Unrelated host drift is reported but must not abort a valid merge. */
function testUnrelatedHostDriftIsReportedNotFatal() {
	const host = makeHost({ "managed.txt": "v1\n", "other.txt": "original\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	engine.importHostAsLayer("L1");
	const b = engine.forkBranch("b1", "L1");
	const ws = engine.mountWorkspace("b1");
	fs.writeFileSync(path.join(ws.workspacePath, "managed.txt"), "v2\n", "utf-8");
	fs.writeFileSync(path.join(ws.workspacePath, "new.txt"), "new\n", "utf-8");
	engine.commitWorkspace("b1", "work", b.headCommitId);

	// Simulate a direct escalated lead edit on an unrelated file before integration.
	fs.writeFileSync(path.join(host, "other.txt"), "edited by lead\n", "utf-8");

	const merged = engine.mergeAndPublishWave(["b1"], {
		allowAutoThreeWayLineMerge: true,
		message: "merge with drift",
	});
	assert.equal(merged.ok, true, "unrelated host drift must not abort the merge");
	assert.equal(merged.hostMatchesLayer, true, "merged paths must match");
	assert.ok(merged.hostDrift?.some((m) => m.includes("other.txt")), "drift must be reported");
	assert.equal(readHost(host, "managed.txt"), "v2\n");
	assert.equal(readHost(host, "other.txt"), "edited by lead\n", "direct lead edit must be preserved");
	assert.equal(engine.verifyHostMatchesLayer("L2").matches, false, "full verification reports the drift");
}

/** Corrupt store metadata must fail loudly instead of silently resetting the head. */
function testCorruptMetadataFailsLoudly() {
	const host = makeHost({ "a.txt": "a\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	engine.importHostAsLayer("L1");
	const metaPath = path.join(engine.getMetrics().storeRoot, "store-meta.json");
	const original = fs.readFileSync(metaPath, "utf-8");
	fs.writeFileSync(metaPath, "{}", "utf-8");
	assert.throws(() => engine.getMetrics(), /corrupt/, "corrupt metadata must not silently reset the store");
	fs.writeFileSync(metaPath, original, "utf-8");
	assert.equal(engine.getMetrics().headLayerId, "L1");
}

/** A LayerFS store must not be reused against a different host working tree. */
function testStoreSourceRootBinding() {
	const host = makeHost({ "a.txt": "a\n" });
	const projectId = nextProjectId();
	const engine = new LayerFSEngine(host, projectId);
	track(engine, host);
	engine.importHostAsLayer("L1");

	const otherHost = makeHost({ "b.txt": "b\n" });
	hosts.push(otherHost);
	const otherEngine = new LayerFSEngine(otherHost, projectId);
	assert.throws(
		() => otherEngine.importHostAsLayer("import from wrong cwd"),
		/refusing to use it from/,
	);
	assert.throws(
		() =>
			otherEngine.mergeAndPublishWave([], {
				allowAutoThreeWayLineMerge: true,
				message: "merge from wrong cwd",
			}),
		/refusing to use it from/,
	);
}

/** Pure state-machine guard: no second integrate, retry/rollback preconditions. */
function testIntegrationStateMachine() {
	const base = {
		planId: "p",
		goal: "g",
		createdAt: 0,
		phase: "READY_TO_INTEGRATE",
		wave0Files: [],
		wave0Completed: true,
		integrationTestCommand: "bash tests/run.sh",
		waves: [["T1"]],
		currentWaveIndex: 0,
		baseLayerId: "L2",
		projectId: "p",
		tasks: {},
	} as unknown as OrchestrationPlan;

	assert.equal(decideIntegrationAction(base, "L2").action, "merge");
	assert.equal(
		decideIntegrationAction({ ...base, phase: "COMPLETED" } as OrchestrationPlan, "L2").action,
		"blocked",
	);
	assert.equal(decideIntegrationAction(base, "L3").action, "blocked", "diverged head blocks merge");

	const published = {
		status: "failed" as const,
		waveIndex: 0,
		startedAt: 0,
		updatedAt: 0,
		attempts: 1,
		publishedLayerId: "L3",
		parentLayerId: "L2",
	};
	const afterFailure = { ...base, phase: "INTEGRATION_FAILED", integration: published } as OrchestrationPlan;
	assert.equal(decideIntegrationAction(afterFailure, "L3").action, "no-op", "second integrate is a no-op");
	assert.equal(
		decideIntegrationAction({ ...afterFailure, integration: { ...published, status: "passed" } } as OrchestrationPlan, "L3").action,
		"no-op",
		"integrate after success is a no-op",
	);
	assert.equal(
		decideIntegrationAction({ ...afterFailure, integration: { ...published, status: "running" } } as OrchestrationPlan, "L3").action,
		"blocked",
	);
	assert.equal(decideRetryIntegrationAction(afterFailure, "L3").allowed, true);
	assert.equal(decideRetryIntegrationAction(afterFailure, "L2").allowed, false);
	assert.equal(decideRetryIntegrationAction(base, "L2").allowed, false);
	assert.equal(decideRollbackIntegrationAction(afterFailure, "L3").allowed, true);
	assert.equal(
		decideRollbackIntegrationAction({ ...afterFailure, integration: { ...published, status: "passed" } } as OrchestrationPlan, "L3").allowed,
		false,
	);
}

/** Crash recovery uses the LayerFS head as the source of truth. */
function testIntegrationCrashRecovery() {
	const makePlan = (): OrchestrationPlan =>
		({
			planId: "p",
			goal: "g",
			createdAt: 0,
			phase: "INTEGRATING",
			wave0Files: [],
			wave0Completed: true,
			integrationTestCommand: "bash tests/run.sh",
			waves: [["T1"]],
			currentWaveIndex: 0,
			baseLayerId: "L2",
			projectId: "p",
			tasks: {
				T1: { spec: {}, state: { status: "approved" } },
			},
			integration: {
				status: "running",
				waveIndex: 0,
				startedAt: 0,
				updatedAt: 0,
				attempts: 1,
				parentLayerId: "L2",
			},
		} as unknown as OrchestrationPlan);

	// Layer published but the crash happened before `publishedLayerId` was recorded.
	const p1 = makePlan();
	assert.equal(reconcileIntegrationRecord(p1, "L3"), true);
	assert.equal(p1.integration?.status, "failed");
	assert.equal(p1.integration?.publishedLayerId, "L3");
	assert.equal(p1.baseLayerId, "L3");
	assert.equal(p1.phase, "INTEGRATION_FAILED");
	assert.equal(p1.tasks.T1.state.status, "merged");
	assert.equal(decideIntegrationAction(p1, "L3").action, "no-op", "no duplicate merge after recovery");
	assert.equal(decideRetryIntegrationAction(p1, "L3").allowed, true);

	// Nothing published: the merge may be retried.
	const p2 = makePlan();
	assert.equal(reconcileIntegrationRecord(p2, "L2"), true);
	assert.equal(p2.integration, undefined);
	assert.equal(p2.phase, "READY_TO_INTEGRATE");
	assert.equal(decideIntegrationAction(p2, "L2").action, "merge");

	// No running integration: untouched.
	const p3 = makePlan();
	p3.integration = undefined;
	p3.phase = "COMPLETED";
	assert.equal(reconcileIntegrationRecord(p3, "L3"), false);
	assert.equal(p3.phase, "COMPLETED");
}

/**
 * Issue 7: the nanosecond stat cache must let host <-> layer verification (and the
 * wave drift check) skip `fs.readFileSync` for unchanged files, while still reading
 * and detecting a modified file (even with an identical byte size).
 */
function testStatCacheSkipsUnchangedHostReads() {
	const host = makeHost({
		"a.txt": "a-base\n",
		"b.txt": "b-base\n",
		"c.txt": "c-base\n",
		"d.txt": "d-base\n",
	});
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);

	const l1 = engine.importHostAsLayer("initial import");
	assert.equal(Object.keys(l1.tree).length, 4);

	// The stat cache must be persisted next to the store metadata, with ns timestamps.
	const storeRoot = engine.getMetrics().storeRoot;
	const statCachePath = path.join(storeRoot, "stat-cache.json");
	assert.ok(fs.existsSync(statCachePath), "stat-cache.json must be persisted in the LayerFS store");
	const cache = readHostJson(statCachePath);
	const cachedA = cache["a.txt"];
	assert.ok(cachedA, "the stat cache must contain a scanned file");
	assert.equal(cachedA.objectId, l1.tree["a.txt"].objectId);
	assert.equal(typeof cachedA.dev, "string");
	assert.equal(typeof cachedA.ino, "string");
	assert.equal(typeof cachedA.size, "number");
	assert.equal(typeof cachedA.mode, "number");
	assert.equal(typeof cachedA.mtimeNs, "string");
	assert.equal(typeof cachedA.ctimeNs, "string");
	assert.match(cachedA.mtimeNs, /^\d+$/, "mtimeNs must be a nanosecond timestamp");
	assert.match(cachedA.ctimeNs, /^\d+$/, "ctimeNs must be a nanosecond timestamp");

	const spy = patchHostReads(host);
	try {
		// Full-tree verification of an untouched host must not re-read any file.
		spy.reset();
		const clean = engine.verifyHostMatchesLayer("L1");
		assert.equal(clean.matches, true);
		assert.deepEqual(spy.reads, [], `unchanged files must be served from the stat cache (reads: ${spy.reads.join(", ")})`);

		// The persisted cache must also be reusable by a fresh engine instance.
		const engine2 = new LayerFSEngine(host, engine.getProjectId());
		track(engine2, host);
		spy.reset();
		assert.equal(engine2.verifyHostMatchesLayer("L1").matches, true);
		assert.deepEqual(
			spy.reads,
			[],
			`a fresh engine instance must reuse the persisted stat cache (reads: ${spy.reads.join(", ")})`,
		);

		// Same byte size, different content: cache must be invalidated + content re-read.
		fs.writeFileSync(path.join(host, "b.txt"), "b-BASE\n", "utf-8");
		assert.equal(fs.statSync(path.join(host, "b.txt")).size, l1.tree["b.txt"].size);
		spy.reset();
		const drift = engine.verifyHostMatchesLayer("L1");
		assert.equal(drift.matches, false, "an equal-size content change must be detected as drift");
		assert.ok(
			drift.mismatches.some((m) => m.startsWith("b.txt")),
			`expected a b.txt mismatch, got: ${drift.mismatches.join("; ")}`,
		);
		assert.ok(spy.reads.includes("b.txt"), "the modified file must be read from disk");
		assert.deepEqual(
			spy.reads.filter((r) => r !== "b.txt"),
			[],
			"untouched files must not be re-read when only one file drifted",
		);

		// Publish the drift as L2 so the wave base matches the host.
		const l2 = engine.importHostAsLayer("wave 0 import", { expectedParentLayerId: "L1" });
		assert.equal(l2.layerId, "L2");

		const b1 = engine.forkBranch("task-t1", "L2");
		const ws = engine.mountWorkspace("task-t1");
		fs.writeFileSync(path.join(ws.workspacePath, "a.txt"), "a-branch\n", "utf-8");
		engine.commitWorkspace("task-t1", "edit a.txt", b1.headCommitId);

		spy.reset();
		const merged = engine.mergeAndPublishWave(["task-t1"], {
			allowAutoThreeWayLineMerge: true,
			message: "wave 1",
			expectedBaseLayerId: "L2",
		});
		assert.equal(merged.ok, true, merged.error);
		assert.deepEqual(
			spy.reads.filter((r) => ["b.txt", "c.txt", "d.txt"].includes(r)),
			[],
			`unchanged files must not be re-read by the merge drift check (reads: ${spy.reads.join(", ")})`,
		);
		assert.deepEqual(merged.hostDrift, [], "unchanged host files must not be reported as drift");
		assert.equal(readHost(host, "a.txt"), "a-branch\n");
		assert.equal(merged.hostMatchesLayer, true);
	} finally {
		spy.restore();
	}
}

/**
 * Issue 7: a path deleted by the merged tree must be verified as ABSENT on the host
 * when an explicit `onlyPaths` list is verified after apply.
 */
function testVerifyDetectsLeftBehindDeletedPath() {
	const host = makeHost({ "keep.txt": "keep\n", "gone.txt": "gone\n" });
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);

	engine.importHostAsLayer("initial import");
	const b1 = engine.forkBranch("task-t1", "L1");
	const ws = engine.mountWorkspace("task-t1");
	fs.rmSync(path.join(ws.workspacePath, "gone.txt"));
	engine.commitWorkspace("task-t1", "delete gone.txt", b1.headCommitId);

	// Simulate a host that keeps/recreates the file: block the delta deletion.
	const unblock = patchRmSyncBlocked([path.join(host, "gone.txt")]);
	let merged: ReturnType<LayerFSEngine["mergeAndPublishWave"]>;
	try {
		merged = engine.mergeAndPublishWave(["task-t1"], {
			allowAutoThreeWayLineMerge: true,
			message: "delete wave",
		});
	} finally {
		unblock();
	}

	assert.equal(merged.ok, false, "merge must refuse when a path deleted by the merge still exists on the host");
	assert.match(
		merged.error ?? "",
		/gone\.txt: expected deleted file to be absent/,
		`expected the deleted-path verification to trip, got: ${merged.error}`,
	);
	assert.equal(engine.getHeadLayerId(), "L1", "no layer may be published when the post-apply verification fails");
	assert.equal(readHost(host, "gone.txt"), "gone\n", "host must be restored to its pre-apply state");
	assert.equal(readHost(host, "keep.txt"), "keep\n");
}

/**
 * Issue 8: `includeHostEdits` must merge approved branch work and direct host edits
 * (add / modify / delete / disjoint line edits) into one layer, and rolling that layer
 * back must restore the host completely to the base layer.
 */
function testIncludeHostEditsMergeAndRollback() {
	const sharedBase = "line1\nline2\nline3\nline4\nline5\nline6\n";
	const host = makeHost({
		"a.txt": "a-base\n",
		"b.txt": "b-base\n",
		"d.txt": "d-base\n",
		"shared.txt": sharedBase,
		"untouched.txt": "untouched\n",
	});
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);

	const l1 = engine.importHostAsLayer("initial import");
	assert.equal(l1.layerId, "L1");
	assert.equal(
		fs.existsSync(path.join(engine.getMetrics().storeRoot, "host-snapshots", "L1.json")),
		false,
		"the root layer has no parent and needs no pre-image snapshot",
	);

	// Approved branch work: modify a.txt + the tail of shared.txt.
	const b1 = engine.forkBranch("task-t1", "L1");
	const ws = engine.mountWorkspace("task-t1");
	fs.writeFileSync(path.join(ws.workspacePath, "a.txt"), "a-branch\n", "utf-8");
	fs.writeFileSync(
		path.join(ws.workspacePath, "shared.txt"),
		sharedBase.replace("line6\n", "line6-branch\n"),
		"utf-8",
	);
	engine.commitWorkspace("task-t1", "branch work", b1.headCommitId);

	// Direct host edits: modify b.txt, add c.txt, delete d.txt, edit the head of shared.txt.
	fs.writeFileSync(path.join(host, "b.txt"), "b-host\n", "utf-8");
	fs.writeFileSync(path.join(host, "c.txt"), "c-host\n", "utf-8");
	fs.rmSync(path.join(host, "d.txt"));
	fs.writeFileSync(
		path.join(host, "shared.txt"),
		sharedBase.replace("line1\n", "line1-host\n"),
		"utf-8",
	);

	const merged = engine.mergeAndPublishWave(["task-t1"], {
		allowAutoThreeWayLineMerge: true,
		message: "wave 1 + host edits",
		includeHostEdits: true,
	});
	assert.equal(merged.ok, true, merged.error);
	assert.equal(merged.publishedLayerId, "L2");
	assert.equal(merged.baseLayerId, "L1");
	assert.equal(merged.treeRegressionWarning, undefined, "the merged tree keeps the file count of L1");
	assert.equal(engine.loadLayer("L2").parentLayerId, "L1");

	// Branch edit + host edits are all merged into the published layer and the host.
	assert.equal(readHost(host, "a.txt"), "a-branch\n");
	assert.equal(readHost(host, "b.txt"), "b-host\n");
	assert.equal(readHost(host, "c.txt"), "c-host\n");
	assert.equal(readHost(host, "d.txt"), undefined, "host deletion must be applied by the merge");
	assert.equal(readHost(host, "untouched.txt"), "untouched\n");
	const mergedShared = readHost(host, "shared.txt") ?? "";
	assert.match(mergedShared, /line1-host\n/, "host line edit must be part of the merged file");
	assert.match(mergedShared, /line6-branch\n/, "branch line edit must be part of the merged file");
	assert.notEqual(
		engine.getLayerTree("L2")["shared.txt"].objectId,
		engine.getLayerTree("L1")["shared.txt"].objectId,
		"the published layer must contain the 3-way merged shared.txt",
	);
	assert.equal(merged.hostMatchesLayer, true);
	assert.deepEqual(merged.hostDrift, []);

	// The persisted snapshot must be a tree-diff pre-image of the BASE layer.
	const snapshotPath = path.join(engine.getMetrics().storeRoot, "host-snapshots", "L2.json");
	assert.ok(fs.existsSync(snapshotPath), "L2 must persist a host pre-image snapshot");
	const snapshot = readHostJson(snapshotPath);
	assert.equal(snapshot.parentLayerId, "L1");
	assert.equal(snapshot.files["a.txt"].existed, true);
	assert.equal(snapshot.files["d.txt"].existed, true, "deleted host files must be restorable");
	assert.equal(snapshot.files["c.txt"].existed, false, "host-added files must be removed on rollback");

	// Rolling back L2 must restore the host byte-for-byte to L1.
	const rollback = engine.rollbackPublishedLayer("L2");
	assert.equal(rollback.ok, true, rollback.message);
	assert.equal(rollback.restoredLayerId, "L1");
	assert.equal(rollback.hostMatchesLayer, true, `host must match L1 after rollback: ${rollback.message}`);
	assert.equal(engine.getHeadLayerId(), "L1");
	assert.equal(readHost(host, "a.txt"), "a-base\n");
	assert.equal(readHost(host, "b.txt"), "b-base\n");
	assert.equal(readHost(host, "c.txt"), undefined, "host-added file must be removed by the rollback");
	assert.equal(readHost(host, "d.txt"), "d-base\n", "host-deleted file must be restored by the rollback");
	assert.equal(readHost(host, "shared.txt"), sharedBase);
	assert.equal(engine.verifyHostMatchesLayer("L1").matches, true);
}

/** Issue 8: host edits participate in the normal conflict detection + regression warning. */
function testIncludeHostEditsConflictsAndRegression() {
	// (a) conflicting branch <-> host edits on the same file must be reported, host untouched.
	const hostA = makeHost({ "conflict.txt": "base\n", "keep.txt": "keep\n" });
	const engineA = new LayerFSEngine(hostA, nextProjectId());
	track(engineA, hostA);
	engineA.importHostAsLayer("initial import");
	const b1 = engineA.forkBranch("task-t1", "L1");
	const ws = engineA.mountWorkspace("task-t1");
	fs.writeFileSync(path.join(ws.workspacePath, "conflict.txt"), "branch\n", "utf-8");
	engineA.commitWorkspace("task-t1", "branch edit", b1.headCommitId);
	fs.writeFileSync(path.join(hostA, "conflict.txt"), "host\n", "utf-8");

	const conflictMerge = engineA.mergeAndPublishWave(["task-t1"], {
		allowAutoThreeWayLineMerge: true,
		message: "conflicting wave",
		includeHostEdits: true,
	});
	assert.equal(conflictMerge.ok, false, "branch and host edits on the same lines must conflict");
	assert.deepEqual(conflictMerge.mergedFiles, []);
	assert.ok(
		conflictMerge.conflicts.some(
			(c) => c.path === "conflict.txt" && c.branches.includes("task-t1") && c.branches.includes("<host>"),
		),
		`expected a task-t1/<host> conflict, got: ${JSON.stringify(conflictMerge.conflicts)}`,
	);
	assert.equal(engineA.getHeadLayerId(), "L1", "no layer may be published on conflict");
	assert.equal(readHost(hostA, "conflict.txt"), "host\n", "host edit must survive a refused merge");

	// (b) a host deletion that shrinks the tree must surface a treeRegressionWarning.
	const hostB = makeHost({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
	const engineB = new LayerFSEngine(hostB, nextProjectId());
	track(engineB, hostB);
	engineB.importHostAsLayer("initial import");
	const b2 = engineB.forkBranch("task-t2", "L1");
	const ws2 = engineB.mountWorkspace("task-t2");
	fs.writeFileSync(path.join(ws2.workspacePath, "a.txt"), "a-branch\n", "utf-8");
	engineB.commitWorkspace("task-t2", "branch edit", b2.headCommitId);
	fs.rmSync(path.join(hostB, "c.txt"));

	const shrinkMerge = engineB.mergeAndPublishWave(["task-t2"], {
		allowAutoThreeWayLineMerge: true,
		message: "shrink wave",
		includeHostEdits: true,
	});
	assert.equal(shrinkMerge.ok, true, shrinkMerge.error);
	assert.match(shrinkMerge.treeRegressionWarning ?? "", /drops 1 file/);
	assert.match(
		engineB.loadLayer(shrinkMerge.publishedLayerId ?? "").treeRegressionWarning ?? "",
		/drops 1 file/,
		"the warning must also be stored on the published LayerRecord",
	);
	assert.equal(engineB.getHeadLayerId(), "L2");
	assert.equal(readHost(hostB, "c.txt"), undefined);
	assert.equal(readHost(hostB, "a.txt"), "a-branch\n");

	// (c) host-only edits must merge even when no branch is part of the wave.
	const hostC = makeHost({ "only.txt": "v1\n" });
	const engineC = new LayerFSEngine(hostC, nextProjectId());
	track(engineC, hostC);
	engineC.importHostAsLayer("initial import");
	fs.writeFileSync(path.join(hostC, "only.txt"), "v2\n", "utf-8");
	fs.writeFileSync(path.join(hostC, "extra.txt"), "extra\n", "utf-8");
	const hostOnlyMerge = engineC.mergeAndPublishWave([], {
		allowAutoThreeWayLineMerge: true,
		message: "host-only wave",
		includeHostEdits: true,
	});
	assert.equal(hostOnlyMerge.ok, true, hostOnlyMerge.error);
	assert.equal(hostOnlyMerge.publishedLayerId, "L2");
	assert.equal(hostOnlyMerge.baseLayerId, "L1");
	assert.ok(hostOnlyMerge.mergedFiles.some((f) => f.path === "only.txt" && f.fromBranches.includes("<host>")));
	assert.equal(readHost(hostC, "only.txt"), "v2\n");
	assert.equal(readHost(hostC, "extra.txt"), "extra\n");
	assert.equal(engineC.rollbackPublishedLayer("L2").ok, true);
	assert.equal(readHost(hostC, "only.txt"), "v1\n");
	assert.equal(readHost(hostC, "extra.txt"), undefined);
}

/**
 * Issue 8: every host import with a parent must persist a pre-image snapshot, and
 * multi-layer rollback must restore a whole chain back to `targetParentLayerId`.
 */
function testMultiLayerRollback() {
	const host = makeHost({
		"a.txt": "a1\n",
		"b.txt": "b1\n",
		"c.txt": "c1\n",
	});
	const engine = new LayerFSEngine(host, nextProjectId());
	track(engine, host);
	const storeRoot = engine.getMetrics().storeRoot;

	engine.importHostAsLayer("initial import"); // L1
	// L2: approved branch work.
	const b1 = engine.forkBranch("task-t1", "L1");
	const ws = engine.mountWorkspace("task-t1");
	fs.writeFileSync(path.join(ws.workspacePath, "a.txt"), "a2\n", "utf-8");
	engine.commitWorkspace("task-t1", "branch edit", b1.headCommitId);
	const l2 = engine.mergeAndPublishWave(["task-t1"], {
		allowAutoThreeWayLineMerge: true,
		message: "wave 1",
	});
	assert.equal(l2.ok, true, l2.error);
	assert.equal(l2.publishedLayerId, "L2");

	// L3: direct host edit imported as a layer (must persist a pre-image snapshot).
	fs.writeFileSync(path.join(host, "b.txt"), "b3\n", "utf-8");
	fs.writeFileSync(path.join(host, "e.txt"), "e3\n", "utf-8");
	const l3 = engine.importHostAsLayer("direct host edit", { expectedParentLayerId: "L2" });
	assert.equal(l3.layerId, "L3");
	assert.equal(l3.parentLayerId, "L2");

	const l3SnapshotPath = path.join(storeRoot, "host-snapshots", "L3.json");
	assert.ok(fs.existsSync(l3SnapshotPath), "importHostAsLayer must persist a pre-image snapshot when a parent exists");
	const l3Snapshot = readHostJson(l3SnapshotPath);
	assert.equal(l3Snapshot.parentLayerId, "L2");
	assert.equal(l3Snapshot.files["b.txt"].existed, true, "modified pre-image must be recorded");
	assert.equal(l3Snapshot.files["e.txt"].existed, false, "added files must be recorded as absent pre-images");
	assert.ok(fs.existsSync(path.join(storeRoot, "host-snapshots", "L2.json")), "L2 must also have a snapshot");

	// Upfront validation: unreachable target / missing snapshot must not touch the host.
	const hostBefore = listHostFiles(host).map((f) => `${f}:${readHost(host, f)}`).join("|");
	const unreachable = engine.rollbackPublishedLayer("L3", { targetParentLayerId: "L99" });
	assert.equal(unreachable.ok, false, "an unreachable targetParentLayerId must be refused");
	assert.equal(engine.getHeadLayerId(), "L3");
	assert.equal(
		listHostFiles(host).map((f) => `${f}:${readHost(host, f)}`).join("|"),
		hostBefore,
		"a refused chain rollback must leave the host untouched",
	);

	const l2SnapshotPath = path.join(storeRoot, "host-snapshots", "L2.json");
	const l2SnapshotRaw = fs.readFileSync(l2SnapshotPath, "utf-8");
	fs.rmSync(l2SnapshotPath);
	const missingSnapshot = engine.rollbackPublishedLayer("L3", { targetParentLayerId: "L1" });
	assert.equal(missingSnapshot.ok, false, "a missing snapshot in the chain must be refused");
	assert.equal(engine.getHeadLayerId(), "L3");
	assert.equal(
		listHostFiles(host).map((f) => `${f}:${readHost(host, f)}`).join("|"),
		hostBefore,
		"a chain rollback refused mid-validation must leave the host untouched",
	);
	fs.writeFileSync(l2SnapshotPath, l2SnapshotRaw, "utf-8");

	// Atomic multi-layer rollback: L3 -> L2 -> L1.
	const rollback = engine.rollbackPublishedLayer("L3", { targetParentLayerId: "L1" });
	assert.equal(rollback.ok, true, rollback.message);
	assert.equal(rollback.restoredLayerId, "L1");
	assert.equal(rollback.hostMatchesLayer, true, `host must match L1 after the chain rollback: ${rollback.message}`);
	assert.equal(engine.getHeadLayerId(), "L1");
	assert.equal(readHost(host, "a.txt"), "a1\n", "L2 branch change must be rolled back");
	assert.equal(readHost(host, "b.txt"), "b1\n", "L3 host edit must be rolled back");
	assert.equal(readHost(host, "c.txt"), "c1\n");
	assert.equal(readHost(host, "e.txt"), undefined, "L3-added file must be removed");
	assert.equal(engine.verifyHostMatchesLayer("L1").matches, true);

	// Single-layer rollback of a host import layer still works.
	fs.writeFileSync(path.join(host, "a.txt"), "a4\n", "utf-8");
	const l4 = engine.importHostAsLayer("second direct host edit", { expectedParentLayerId: "L1" });
	assert.equal(l4.layerId, "L4", "rolled-back layer ids are never recycled (audit trail)");
	assert.equal(l4.parentLayerId, "L1");
	const single = engine.rollbackPublishedLayer("L4");
	assert.equal(single.ok, true, single.message);
	assert.equal(single.restoredLayerId, "L1");
	assert.equal(single.hostMatchesLayer, true);
	assert.equal(readHost(host, "a.txt"), "a1\n");
}

async function runTests() {
	const tests: Array<[string, () => void | Promise<void>]> = [
		["untracked files imported + regression warning", testUntrackedImportAndRegressionWarning],
		["duplicate integrate refused, host unchanged (P0)", testDuplicateIntegrateIsRefused],
		["cross-branch additions + explicit deletion", testCrossBranchAdditionsAndExplicitDeletion],
		["host snapshot / verification / rollback / re-merge", testSnapshotVerifyAndRollback],
		["executable mode propagation", testExecutableModePropagation],
		["unrelated host drift reported, merge not aborted", testUnrelatedHostDriftIsReportedNotFatal],
		["TMPDIR, diagnostics, stray artifacts, abort, timeout", testWorkspaceCommandDiagnostics],
		["corrupt store metadata fails loudly", testCorruptMetadataFailsLoudly],
		["store bound to host source root", testStoreSourceRootBinding],
		["stat cache: unchanged host files not re-read, drift detected", testStatCacheSkipsUnchangedHostReads],
		["deleted path still on host fails post-apply verification", testVerifyDetectsLeftBehindDeletedPath],
		["includeHostEdits merges branch + host edits, rollback restores", testIncludeHostEditsMergeAndRollback],
		["includeHostEdits conflicts + tree regression warning", testIncludeHostEditsConflictsAndRegression],
		["multi-layer rollback to targetParentLayerId", testMultiLayerRollback],
		["integration state machine guards", testIntegrationStateMachine],
		["integration crash recovery", testIntegrationCrashRecovery],
	];

	let failed = 0;
	try {
		for (const [name, fn] of tests) {
			try {
				await fn();
				console.log(`  ✓ ${name}`);
			} catch (err) {
				failed += 1;
				console.error(`  ✗ ${name}`);
				console.error(err);
			}
		}
	} finally {
		cleanup();
	}

	if (failed > 0) {
		console.error(`\n${failed} REGRESSION TEST(S) FAILED`);
		process.exitCode = 1;
	} else {
		console.log("\nALL ORCHESTRATOR REGRESSION TESTS PASSED!");
	}
}

await runTests();
