/**
 * Unit tests for the dependency-free shared primitives:
 *
 * - path-patterns.ts   : normalizeRelPath / hasGlobWildcard / isTestFilePath /
 *                        matchGlobPattern / matchesAnyPattern
 * - workspace-env.ts   : scratchDirs / ensureScratchDirs / scratchEnvironment
 * - process-runner.ts  : superviseChildProcess (timeout, abort, SIGTERM->SIGKILL,
 *                        spawn error, exactly-once settlement)
 *
 * Everything here asserts an observable outcome: a returned value, a file that exists on
 * disk, a real child process' exit code, or a printed summary. The behavioral oracles cover
 * executeWorkspaceCommand (exit codes 0 / 3 / 124 / 130 / 127, TMPDIR injection,
 * CommandResult shape).
 *
 * Run with: node ./test-primitives.ts
 */

import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	hasGlobWildcard,
	isTestFilePath,
	matchGlobPattern,
	matchesAnyPattern,
	normalizeRelPath,
} from "./path-patterns.ts";
import { KILL_ESCALATION_MS, superviseChildProcess } from "./process-runner.ts";
import { executeWorkspaceCommand } from "./verifier.ts";
import { ensureScratchDirs, scratchDirs, scratchEnvironment } from "./workspace-env.ts";
import { createAsyncTestRunner } from "./test-kit.ts";

/** The one shared harness: pass/fail counting, printing and exit status. */
const runner = createAsyncTestRunner();
const testCase = runner.testCase;
const cleanupPaths: string[] = [];

function cleanup(): void {
	for (const target of cleanupPaths) {
		fs.rmSync(target, { recursive: true, force: true });
	}
	cleanupPaths.length = 0;
}

function superviseAndWait(
	proc: ReturnType<typeof spawn>,
	options: {
		timeoutMs: number;
		signal?: AbortSignal;
		onTerminate?: (label: string) => void;
		onProcessError?: (error: Error) => number;
	}
): Promise<{ code: number; codes: number[]; labels: string[] }> {
	const codes: number[] = [];
	const labels: string[] = [];
	return new Promise((resolve) => {
		superviseChildProcess(proc, {
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			onTerminate: (label) => {
				labels.push(label);
				options.onTerminate?.(label);
			},
			onProcessError: (error) => options.onProcessError?.(error) ?? 1,
			onFinish: (code) => {
				codes.push(code);
				resolve({ code, codes, labels });
			},
		});
	});
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function pathPatternTests(): Promise<void> {
	console.log("path-patterns.ts");

	await testCase("normalizeRelPath: './src///a.ts' -> 'src/a.ts'", () => {
		assert.equal(normalizeRelPath("./src///a.ts"), "src/a.ts");
	});

	await testCase("normalizeRelPath: strips trailing '/'", () => {
		assert.equal(normalizeRelPath("src/foo/"), "src/foo");
		assert.equal(normalizeRelPath("src/foo///"), "src/foo");
	});

	await testCase("normalizeRelPath: converts backslashes to '/'", () => {
		assert.equal(normalizeRelPath("a\\b\\c"), "a/b/c");
		assert.equal(normalizeRelPath(".\\a\\b"), "a/b");
	});

	await testCase("normalizeRelPath: strips repeated './' prefixes", () => {
		assert.equal(normalizeRelPath("././x"), "x");
		assert.equal(normalizeRelPath("./././y/z"), "y/z");
	});

	await testCase("hasGlobWildcard: '*' and '?' are wildcards, plain paths are not", () => {
		assert.equal(hasGlobWildcard("src/*.ts"), true);
		assert.equal(hasGlobWildcard("a?b"), true);
		assert.equal(hasGlobWildcard("src/a.ts"), false);
		assert.equal(hasGlobWildcard("src/**"), true);
	});

	await testCase("matchGlobPattern: 'src/a.ts' matches 'src/*.ts'", () => {
		assert.equal(matchGlobPattern("src/a.ts", "src/*.ts"), true);
	});

	await testCase("matchGlobPattern: 'src/a.ts' matches 'src/**' (recursive)", () => {
		assert.equal(matchGlobPattern("src/a.ts", "src/**"), true);
		assert.equal(matchGlobPattern("src/deep/a.ts", "src/**"), true);
	});

	await testCase("matchGlobPattern: 'src/a.ts' matches 'src/' (directory prefix)", () => {
		assert.equal(matchGlobPattern("src/a.ts", "src/"), true);
		assert.equal(matchGlobPattern("src/a.ts", "src"), true);
	});

	await testCase("matchGlobPattern: 'src/a.ts' does not match 'src/*.js'", () => {
		assert.equal(matchGlobPattern("src/a.ts", "src/*.js"), false);
	});

	await testCase("matchGlobPattern: backslash path 'src\\a.ts' matches 'src/*.ts'", () => {
		assert.equal(matchGlobPattern("src\\a.ts", "src/*.ts"), true);
		assert.equal(matchGlobPattern("src/a.ts", "src\\*.ts"), true);
	});

	await testCase("matchGlobPattern: '**/*.spec.ts' matches deep spec file", () => {
		assert.equal(matchGlobPattern("a/b/x.spec.ts", "**/*.spec.ts"), true);
		assert.equal(matchGlobPattern("x.spec.ts", "**/*.spec.ts"), true);
		assert.equal(matchGlobPattern("a/b/x.test.ts", "**/*.spec.ts"), false);
	});

	await testCase("matchesAnyPattern: any matching pattern wins", () => {
		assert.equal(matchesAnyPattern("src/a.ts", ["src/*.js", "src/*.ts"]), true);
		assert.equal(matchesAnyPattern("src/a.ts", ["lib/*.js", "src/*.js"]), false);
		assert.equal(matchesAnyPattern("src/a.ts", []), false);
	});

	// The file-scope gate passes an allow/forbid pattern LIST: an empty list must allow
	// nothing (no accidental "everything is allowed"), and a non-matching earlier entry must
	// never shadow a later matching one.
	await testCase(
		"matchesAnyPattern: empty list denies, a later pattern still wins over an earlier miss",
		() => {
			assert.equal(matchesAnyPattern("src/a.ts", []), false);
			assert.equal(matchesAnyPattern("docs/a.md", ["docs/", "src/"]), true);
			assert.equal(matchesAnyPattern("src/a.ts", ["docs/", "src/"]), true);
			assert.equal(matchesAnyPattern("lib/a.ts", ["docs/", "src/"]), false);
		},
	);

	// `**/` must be optional (a file directly under src/) as well as multi-segment.
	await testCase("matchGlobPattern: 'src/**/*.ts' matches zero and one intermediate dirs", () => {
		assert.equal(matchGlobPattern("src/b.ts", "src/**/*.ts"), true);
		assert.equal(matchGlobPattern("src/a/b.ts", "src/**/*.ts"), true);
		assert.equal(matchGlobPattern("src/a/b.js", "src/**/*.ts"), false);
	});

	// `?` is exactly one path character: it must not swallow a suffix or a '/'.
	await testCase("matchGlobPattern: '?' matches exactly one non-separator character", () => {
		assert.equal(matchGlobPattern("src/ab", "src/a?"), true);
		assert.equal(matchGlobPattern("src/abc", "src/a?"), false);
		assert.equal(matchGlobPattern("src/a/b", "src/a?"), false);
	});

	await testCase("isTestFilePath: recognizes test/spec conventions", () => {
		for (const candidate of [
			"tests/a.ts",
			"__tests__/a.ts",
			"x.test.ts",
			"foo_test.py",
			"test_foo.ts",
			"src/deep/x.spec.ts",
		]) {
			assert.equal(isTestFilePath(candidate), true, `expected test file: ${candidate}`);
		}
	});

	await testCase("isTestFilePath: leaves ordinary source files alone", () => {
		for (const candidate of ["src/a.ts", "testkit.ts", "src/testkit.ts", "contest.ts"]) {
			assert.equal(isTestFilePath(candidate), false, `expected non-test file: ${candidate}`);
		}
	});
}

async function workspaceEnvTests(): Promise<void> {
	console.log("workspace-env.ts");

	await testCase("scratchDirs('root') -> {tmpDir:'root/.tmp',cacheDir:'root/.cache'}", () => {
		assert.deepEqual(scratchDirs("root"), {
			tmpDir: path.join("root", ".tmp"),
			cacheDir: path.join("root", ".cache"),
		});
	});

	await testCase("scratchEnvironment maps TMPDIR/TMP/TEMP/XDG_CACHE_HOME", () => {
		const dirs = scratchDirs("root");
		assert.deepEqual(scratchEnvironment(dirs), {
			TMPDIR: dirs.tmpDir,
			TMP: dirs.tmpDir,
			TEMP: dirs.tmpDir,
			XDG_CACHE_HOME: dirs.cacheDir,
		});
		// CI=1 is a caller policy, never implied by the environment map
		assert.equal("CI" in scratchEnvironment(dirs), false);
	});

	await testCase("ensureScratchDirs creates both scratch dirs on disk", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-primitives-"));
		cleanupPaths.push(root);
		const dirs = ensureScratchDirs(root);
		assert.equal(dirs.tmpDir, path.join(root, ".tmp"));
		assert.equal(dirs.cacheDir, path.join(root, ".cache"));
		assert.ok(fs.statSync(dirs.tmpDir).isDirectory(), "tmp dir must exist");
		assert.ok(fs.statSync(dirs.cacheDir).isDirectory(), "cache dir must exist");
		assert.equal(scratchDirs(root).tmpDir, dirs.tmpDir);
	});

	await testCase(
		"ensureScratchDirs falls back to os.tmpdir() when <root>/.tmp is a regular file",
		() => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-primitives-"));
			cleanupPaths.push(root);
			const blockedTmpDir = path.join(root, ".tmp");
			fs.writeFileSync(blockedTmpDir, "x");

			const dirs = ensureScratchDirs(root);

			assert.notEqual(
				dirs.tmpDir,
				blockedTmpDir,
				"tmpDir must not reuse a path that is occupied by a regular file",
			);
			cleanupPaths.push(dirs.tmpDir);
			assert.ok(
				fs.statSync(dirs.tmpDir).isDirectory(),
				"the fallback tmpDir must exist and be a real directory",
			);
			assert.equal(
				fs.realpathSync(dirs.tmpDir).startsWith(fs.realpathSync(os.tmpdir())),
				true,
				"the fallback tmpDir must live inside os.tmpdir()",
			);
			assert.equal(dirs.cacheDir, path.join(root, ".cache"));
			assert.ok(fs.statSync(dirs.cacheDir).isDirectory(), "cache dir must still be created under root");
		},
	);
}

async function processRunnerTests(): Promise<void> {
	console.log("process-runner.ts");

	// The supervisor exists to force-terminate only when it must: a child that exits on its own,
	// well before the deadline, must never receive onTerminate or a signal.
	await testCase(
		"superviseChildProcess never force-terminates a child that exits before the timeout",
		async () => {
			const proc = spawn(process.execPath, ["-e", "process.exit(5)"]);
			let terminateCalls = 0;
			const finishes: number[] = [];
			const code = await new Promise<number>((resolve) => {
				superviseChildProcess(proc, {
					timeoutMs: 5000,
					onTerminate: () => {
						terminateCalls += 1;
					},
					onProcessError: () => 1,
					onFinish: (value) => {
						finishes.push(value);
						resolve(value);
					},
				});
			});
			assert.equal(code, 5, "onFinish must report the child's own exit code");
			assert.deepEqual(finishes, [5], "onFinish must fire exactly once with 5");
			assert.equal(terminateCalls, 0, "an on-time exit must never trigger onTerminate");
			assert.equal(proc.killed, false, "an on-time exit must never be signalled");
			assert.equal(proc.signalCode, null, "an on-time exit must not die by signal");
		},
	);

	await testCase("superviseChildProcess resolves with the natural exit code (7)", async () => {
		const proc = spawn(process.execPath, ["-e", "process.exit(7)"]);
		const result = await superviseAndWait(proc, { timeoutMs: 30_000 });
		assert.equal(result.code, 7);
		assert.equal(result.codes.length, 1, "onFinish must be called exactly once");
		assert.deepEqual(result.labels, [], "no termination label for a natural exit");
	});

	await testCase(
		"superviseChildProcess kills a hung process on timeout: code 124 + SIGTERM label",
		async () => {
			const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
			const result = await superviseAndWait(proc, { timeoutMs: 150 });
			assert.equal(result.code, 124);
			assert.equal(result.codes.length, 1, "onFinish must be called exactly once");
			assert.equal(result.labels.length, 1, "onTerminate must be called exactly once");
			assert.match(result.labels[0], /SIGTERM/, `label must mention SIGTERM (actual: ${result.labels[0]})`);
			assert.match(result.labels[0], /150ms/);
		},
	);

	await testCase(
		"superviseChildProcess escalates to SIGKILL when the child ignores SIGTERM",
		async () => {
			// The child installs a no-op SIGTERM handler, so only SIGKILL can end it.
			const proc = spawn(process.execPath, [
				"-e",
				'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
			]);
			let terminateCalls = 0;
			const finishes: number[] = [];
			let escalationGuard: ReturnType<typeof setTimeout> | undefined;
			const settled = new Promise<number>((resolve) => {
				superviseChildProcess(proc, {
					timeoutMs: 150,
					onTerminate: () => {
						terminateCalls += 1;
					},
					onProcessError: () => 1,
					onFinish: (code) => {
						finishes.push(code);
						resolve(code);
					},
				});
			});
			const guard = new Promise<never>((_resolve, reject) => {
				escalationGuard = setTimeout(() => {
					reject(
						new Error(
							`onFinish must fire within KILL_ESCALATION_MS (${KILL_ESCALATION_MS}ms) + 2000ms of the timeout`,
						),
					);
				}, KILL_ESCALATION_MS + 2000);
			});
			try {
				const code = await Promise.race([settled, guard]);
				assert.equal(code, 124, "the forced timeout code must survive SIGKILL escalation");
				assert.equal(terminateCalls, 1, "onTerminate must be called exactly once");
				assert.deepEqual(finishes, [124], "onFinish must fire exactly once with 124");
			} finally {
				if (escalationGuard) clearTimeout(escalationGuard);
				// SIGKILL cannot be ignored: this only reaps a child a failed assertion left behind.
				try {
					proc.kill("SIGKILL");
				} catch {}
			}
		},
	);

	await testCase("superviseChildProcess aborts an already-aborted signal with 130", async () => {
		const controller = new AbortController();
		controller.abort();
		const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
		const result = await superviseAndWait(proc, {
			timeoutMs: 30_000,
			signal: controller.signal,
		});
		assert.equal(result.code, 130);
		assert.equal(result.codes.length, 1, "onFinish must be called exactly once");
		assert.equal(result.labels.length, 1);
		assert.match(result.labels[0], /SIGTERM/);
	});

	await testCase("superviseChildProcess aborts a running process with 130", async () => {
		const controller = new AbortController();
		const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
		const settled = superviseAndWait(proc, { timeoutMs: 30_000, signal: controller.signal });
		setTimeout(() => controller.abort(), 40);
		const result = await settled;
		assert.equal(result.code, 130);
		assert.equal(result.codes.length, 1, "onFinish must be called exactly once");
	});

	await testCase(
		"superviseChildProcess settles exactly once when timeout and abort both fire",
		async () => {
			const controller = new AbortController();
			const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
			let finishCount = 0;
			const result = await new Promise<number>((resolve) => {
				superviseChildProcess(proc, {
					timeoutMs: 60,
					signal: controller.signal,
					onTerminate: () => {},
					onProcessError: () => 1,
					onFinish: (code) => {
						finishCount += 1;
						resolve(code);
					},
				});
				// fires after the timeout already forced the exit code
				setTimeout(() => controller.abort(), 90);
			});
			await delay(150);
			assert.equal(finishCount, 1, "onFinish must be idempotent across timeout + abort");
			assert.equal(result, 124);
		},
	);

	await testCase("superviseChildProcess routes spawn errors through onProcessError", async () => {
		const proc = spawn("/definitely/not/a/binary/orch");
		let seen: Error | undefined;
		const result = await superviseAndWait(proc, {
			timeoutMs: 30_000,
			onProcessError: (error) => {
				seen = error;
				return 127;
			},
		});
		assert.equal(result.code, 127);
		assert.equal(result.codes.length, 1, "onFinish must be called exactly once");
		assert.ok(seen instanceof Error, "onProcessError must receive the spawn error");
	});
}

// Behavioral oracles: executeWorkspaceCommand

async function commandRunnerOracleTests(): Promise<void> {
	console.log("executeWorkspaceCommand oracles");

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-primitives-cmd-"));
	cleanupPaths.push(cwd);

	await testCase("executeWorkspaceCommand captures stdout with exit code 0", async () => {
		const result = await executeWorkspaceCommand(
			`node -e 'process.stdout.write("hello")'`,
			cwd,
		);
		assert.equal(result.exitCode, 0);
		assert.match(result.outputTail, /hello/);
		assert.equal(result.command, `node -e 'process.stdout.write("hello")'`);
	});

	await testCase("executeWorkspaceCommand passes a natural exit code (3) through", async () => {
		const result = await executeWorkspaceCommand(`node -e 'process.exit(3)'`, cwd);
		assert.equal(result.exitCode, 3);
	});

	await testCase("executeWorkspaceCommand times out with 124 + SIGTERM", async () => {
		const started = Date.now();
		const result = await executeWorkspaceCommand("sleep 30", cwd, undefined, 200);
		assert.equal(result.exitCode, 124);
		assert.match(result.outputTail, /SIGTERM/);
		assert.ok(Date.now() - started < 10_000, "the timeout must actually kill the child");
	});

	await testCase("executeWorkspaceCommand aborts an already-aborted signal with 130", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await executeWorkspaceCommand("sleep 30", cwd, controller.signal);
		assert.equal(result.exitCode, 130);
	});

	await testCase("executeWorkspaceCommand injects a .tmp TMPDIR into the child env", async () => {
		const result = await executeWorkspaceCommand(
			`node -e 'console.log(process.env.TMPDIR)'`,
			cwd,
		);
		assert.equal(result.exitCode, 0);
		assert.match(result.outputTail, /\.tmp/);
		assert.match(result.environment, /^cwd=.* \| TMPDIR=.* \| XDG_CACHE_HOME=.* \| CI=1$/);
	});

	await testCase("executeWorkspaceCommand keeps the exact CommandResult shape", async () => {
		const result = await executeWorkspaceCommand("exit 0", cwd);
		assert.deepEqual(Object.keys(result).sort(), [
			"command",
			"durationMs",
			"environment",
			"exitCode",
			"failureLines",
			"outputHead",
			"outputTail",
			"strayArtifacts",
		]);
		assert.equal(typeof result.durationMs, "number");
		assert.ok(Array.isArray(result.failureLines));
		assert.ok(Array.isArray(result.strayArtifacts));
	});
}

async function sharedHarnessTests(): Promise<void> {
	console.log("shared test harness (test-kit.ts)");

	await testCase("required: async runner awaits cases, captures failures and finishes once", async () => {
		const sink: string[] = [];
		const originalLog = console.log;
		const originalError = console.error;
		const toSink = (...args: unknown[]): void => {
			sink.push(args.map((arg) => String(arg)).join(" "));
		};
		console.log = toSink as typeof console.log;
		console.error = toSink as typeof console.error;
		const savedExitCode = process.exitCode;
		Reflect.set(process, "exitCode", undefined);

		try {
			const probe = createAsyncTestRunner();
			let awaited = false;
			let escaped: unknown;
			try {
				await probe.testCase("probe: rejected case", async () => {
					awaited = true;
					await Promise.resolve();
					throw new Error("async boom");
				});
			} catch (err) {
				escaped = err;
			}
			assert.equal(awaited, true, "the async runner must await the case body");
			assert.equal(escaped, undefined, "a rejecting case must be captured, never rethrown");
			assert.equal(process.exitCode, undefined, "only finish() may settle the exit status");

			await probe.testCase("probe: async green case", async () => {});
			probe.finish();
			assert.equal(process.exitCode, 1, "finish() must set process.exitCode = 1 on any failure");

			const failedOutput = sink.join("\n");
			assert.match(failedOutput, /  FAIL probe: rejected case/);
			assert.match(failedOutput, /async boom/);
			assert.match(failedOutput, /1 test\(s\) failed, 1 passed\./);
			assert.match(failedOutput, /--- probe: rejected case ---/);

			const settledAt = sink.length;
			probe.finish();
			assert.equal(settledAt, sink.length, "a second finish() must be a no-op");

			const healthy = createAsyncTestRunner();
			await healthy.testCase("probe: async green suite", async () => {}, "验收 1");
			healthy.finish();
			assert.equal(process.exitCode, 0, "finish() must set process.exitCode = 0 when nothing failed");
			assert.match(sink.join("\n"), /All 1 test\(s\) passed\./);
		} finally {
			console.log = originalLog;
			console.error = originalError;
			Reflect.set(process, "exitCode", savedExitCode);
		}
	});
}

async function main(): Promise<void> {
	try {
		await pathPatternTests();
		await workspaceEnvTests();
		await processRunnerTests();
		await commandRunnerOracleTests();
		await sharedHarnessTests();
	} finally {
		cleanup();
	}

	runner.finish();
}

await main();
