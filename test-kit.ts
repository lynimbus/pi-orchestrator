/**
 * The ONE shared test harness for this repo.
 *
 * Every suite (`test-waves.ts`, `test-packaging-manifest.ts`,
 * `test-packaging-docs.ts`, `test-primitives.ts`) delegates pass/fail counting,
 * line printing and the exit status to this module, so a runner bug is fixed in
 * one place instead of four diverging copies.
 *
 * Design constraints:
 * - no project imports (only node builtins, and none are needed here);
 * - a throwing test case is CAPTURED as a failure and never rethrown;
 * - `finish()` is the only place that writes `process.exitCode`, and calling it
 *   twice must not double-print the summary.
 */

interface TestFailure {
	name: string;
	acceptance?: string;
	error: unknown;
}

export interface SyncTestRunner {
	testCase(name: string, fn: () => void, acceptance?: string): void;
	finish(): void;
}

export interface AsyncTestRunner {
	testCase(name: string, fn: () => void | Promise<void>, acceptance?: string): Promise<void>;
	finish(): void;
}

interface HarnessState {
	passed: number;
	failures: TestFailure[];
	finished: boolean;
}

function createHarnessState(): HarnessState {
	return { passed: 0, failures: [], finished: false };
}

function printPass(name: string): void {
	console.log(`  ok   ${name}`);
}

function acceptanceSuffix(acceptance: string | undefined): string {
	return acceptance === undefined ? "" : `（${acceptance}）`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeErrorDetail(error: unknown): string {
	return error instanceof Error ? error.stack ?? error.message : String(error);
}

function reportFailure(state: HarnessState, failure: TestFailure): void {
	state.failures.push(failure);
	console.error(`  FAIL ${failure.name}${acceptanceSuffix(failure.acceptance)}`);
	console.error(describeError(failure.error));
}

/**
 * Prints the summary exactly once and settles `process.exitCode`
 * (1 on any failure, 0 otherwise). Never throws.
 */
function finishHarness(state: HarnessState): void {
	if (state.finished) return;
	state.finished = true;

	console.log("");
	if (state.failures.length > 0) {
		console.error(`${state.failures.length} test(s) failed, ${state.passed} passed.`);
		for (const failure of state.failures) {
			console.error(`\n--- ${failure.name} ---`);
			console.error(describeErrorDetail(failure.error));
		}
		process.exitCode = 1;
		return;
	}
	console.log(`All ${state.passed} test(s) passed.`);
	process.exitCode = 0;
}

export function createSyncTestRunner(): SyncTestRunner {
	const state = createHarnessState();

	return {
		testCase(name: string, fn: () => void, acceptance?: string): void {
			try {
				fn();
				state.passed++;
				printPass(name);
			} catch (error) {
				reportFailure(state, { name, acceptance, error });
			}
		},
		finish(): void {
			finishHarness(state);
		},
	};
}

export function createAsyncTestRunner(): AsyncTestRunner {
	const state = createHarnessState();

	return {
		async testCase(
			name: string,
			fn: () => void | Promise<void>,
			acceptance?: string,
		): Promise<void> {
			try {
				await fn();
				state.passed++;
				printPass(name);
			} catch (error) {
				reportFailure(state, { name, acceptance, error });
			}
		},
		finish(): void {
			finishHarness(state);
		},
	};
}
