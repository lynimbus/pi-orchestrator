/**
 * Child-process supervision shared by the mechanical verifier and the subagent runner.
 *
 * Owns exactly one policy: settle exactly once, SIGTERM first, unconditional
 * SIGKILL escalation afterwards, forced exit codes for timeout (124) and abort
 * (130). `proc.killed` is already true right after the first kill(), so it must
 * never be used as the guard (that used to leave hung workers alive forever).
 */

import type { ChildProcess } from "node:child_process";

export const KILL_ESCALATION_MS = 3000;

export interface SupervisedProcessOptions {
	/** Hard deadline in ms before the supervisor forces exit code 124. */
	timeoutMs: number;
	signal?: AbortSignal;
	/** Called once, with a human-readable reason, right before SIGTERM. */
	onTerminate(label: string): void;
	/** Maps a spawn/runtime error to the exit code reported to `onFinish`. */
	onProcessError(error: Error): number;
	/** Called exactly once when the supervisor settles. */
	onFinish(code: number): void;
}

export function superviseChildProcess(proc: ChildProcess, options: SupervisedProcessOptions): void {
	let settled = false;
	let forcedExitCode: number | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	const finish = (code: number) => {
		if (settled) return;
		settled = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (killTimer) clearTimeout(killTimer);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
		options.onFinish(code);
	};

	const terminate = (code: number, label: string) => {
		if (settled || forcedExitCode !== undefined) return;
		forcedExitCode = code;
		options.onTerminate(label);
		try {
			proc.kill("SIGTERM");
		} catch {
			finish(code);
			return;
		}
		killTimer = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				finish(code);
			}
		}, KILL_ESCALATION_MS);
	};

	const onAbort = () => terminate(130, "Aborted by signal: SIGTERM");

	proc.on("close", (code) => finish(forcedExitCode ?? code ?? 1));
	proc.on("error", (err) => finish(options.onProcessError(err)));

	timeoutTimer = setTimeout(
		() => terminate(124, `Timeout after ${options.timeoutMs}ms: SIGTERM`),
		options.timeoutMs,
	);

	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}
}
