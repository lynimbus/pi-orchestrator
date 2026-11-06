/**
 * Mechanical Verification Gate (Layer 1 Review)
 *
 * Performs deterministic, zero-LLM-token checks on every subagent's LayerFS workspace
 * before the Lead Agent is allowed to approve the task:
 * 1. File Scope Gate: no out-of-bounds edits or forbidden file touches
 * 2. Unit Test Presence Gate: accompanying unit tests must be added/updated with assertions
 * 3. Test Integrity Gate: blocks .only, .skip, disabled tests, or deleted assertions
 * 4. Independent Test Execution Gate: runs `spec.testCommand` inside the isolated workspace
 * 5. Structured Worker Report Parsing
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isTestFilePath, matchesAnyPattern } from "./layerfs-engine.ts";
import type {
	BranchDiffResult,
	MechanicalGateReport,
	TaskSpec,
	WorkerStructuredReport,
} from "./types.ts";

const TEST_SKIP_OR_ONLY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
	{ label: ".only() focus filter", regex: /\b(it|test|describe|context)\.only\s*\(/ },
	{ label: "fit/fdescribe focus filter", regex: /\b(fit|fdescribe)\s*\(/ },
	{ label: ".skip() disabled test", regex: /\b(it|test|describe|context)\.skip\s*\(/ },
	{ label: "xit/xdescribe disabled test", regex: /\b(xit|xdescribe|xtest)\s*\(/ },
	{ label: "pytest skip marker", regex: /@pytest\.mark\.skip\b/ },
	{ label: "Go t.Skip()", regex: /\bt\.Skip(Now|f)?\s*\(/ },
	{ label: "Rust #[ignore]", regex: /#\s*\[\s*ignore\b/ },
];

const ASSERTION_HINT_REGEX =
	/\b(expect|assert|assert_\w+|assertEquals|assertNotNull|require\.\w+|should|t\.(Fatal|Error|Fail)|!\s*\[\s*test\s*\]|@Test|def\s+test_|func\s+Test\w+|it\s*\(|test\s*\()/;

export async function runMechanicalVerificationGate(
	spec: TaskSpec,
	workspacePath: string,
	diff: BranchDiffResult,
	workerRawOutput: string,
	signal?: AbortSignal,
): Promise<{ gateReport: MechanicalGateReport; workerReport: WorkerStructuredReport }> {
	const workerReport = parseWorkerStructuredReport(workerRawOutput);

	// 1. File Scope Gate
	const combinedAllowed = [...spec.allowedFiles, ...spec.testFiles];
	const forbidden = spec.doNotTouch ?? [];
	const outOfScopeFiles: string[] = [];
	const touchedTestFiles: string[] = [];
	const touchedImplFiles: string[] = [];

	for (const f of diff.files) {
		const inForbidden = forbidden.length > 0 && matchesAnyPattern(f.path, forbidden);
		const inAllowed =
			combinedAllowed.length === 0 || matchesAnyPattern(f.path, combinedAllowed);

		if (inForbidden || !inAllowed) {
			outOfScopeFiles.push(f.path);
		}
		if (
			f.isTestFile ||
			(spec.testFiles.length > 0 && matchesAnyPattern(f.path, spec.testFiles)) ||
			isTestFilePath(f.path)
		) {
			touchedTestFiles.push(f.path);
		} else {
			touchedImplFiles.push(f.path);
		}
	}

	const fileScopePassed = outOfScopeFiles.length === 0 && diff.files.length > 0;
	const fileScopeDetails =
		diff.files.length === 0
			? "No files were changed in the workspace."
			: outOfScopeFiles.length === 0
				? `All ${diff.files.length} changed file(s) are within allowed scope.`
				: `Out-of-scope file modifications detected: ${outOfScopeFiles.join(", ")}`;

	// 2. Unit Test Presence Gate
	const addedTestLines = diff.files
		.filter((f) => touchedTestFiles.includes(f.path))
		.flatMap((f) =>
			f.unifiedDiff
				.split("\n")
				.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
				.map((line) => line.slice(1)),
		);

	const hasAssertionInAddedTestLines = addedTestLines.some((line) =>
		ASSERTION_HINT_REGEX.test(line),
	);
	const unitTestsPassed =
		touchedTestFiles.length > 0 && addedTestLines.length > 0 && hasAssertionInAddedTestLines;
	const unitTestsDetails =
		touchedTestFiles.length === 0
			? `No unit test files were created or updated (expected: ${spec.testFiles.join(", ") || "test files"}).`
			: !hasAssertionInAddedTestLines
				? `Test file(s) touched (${touchedTestFiles.join(", ")}) but no new test cases or assertions were found in added lines.`
				: `Updated ${touchedTestFiles.length} test file(s) (${touchedTestFiles.join(", ")}) with +${addedTestLines.length} added test lines.`;

	// 3. Test Integrity / Anti-Tampering Gate
	const tamperingWarnings: string[] = [];
	for (const line of addedTestLines) {
		for (const pattern of TEST_SKIP_OR_ONLY_PATTERNS) {
			if (pattern.regex.test(line)) {
				tamperingWarnings.push(`Added ${pattern.label}: "${line.trim().slice(0, 80)}"`);
			}
		}
	}

	// Check if existing assertions were deleted without replacement
	for (const f of diff.files) {
		if (!touchedTestFiles.includes(f.path)) continue;
		if (f.changeType === "deleted") {
			tamperingWarnings.push(`Test file "${f.path}" was deleted.`);
		}
	}

	const testIntegrityPassed = tamperingWarnings.length === 0;
	const testIntegrityDetails = testIntegrityPassed
		? "No test tampering (.only, .skip, or deleted test files) detected."
		: `Test integrity violations: ${tamperingWarnings.join("; ")}`;

	// 4. Independent Test Command Execution inside Workspace
	const testCmdResult = await executeWorkspaceCommand(
		spec.testCommand,
		workspacePath,
		signal,
		120_000,
		// Worker workspaces are ephemeral: remove junk files (e.g. a stray "-" file
		// produced by a misbehaving mock) so they cannot leak into later commits.
		{ cleanupStrayRootFiles: true },
	);
	const testExecPassed = testCmdResult.exitCode === 0;
	const testExecDetails = testExecPassed
		? `Command "${spec.testCommand}" exited 0 in ${testCmdResult.durationMs}ms.`
		: `Command "${spec.testCommand}" failed with exit code ${testCmdResult.exitCode} (${testCmdResult.durationMs}ms).`;

	// 5. Worker Status Gate
	const workerStatusPassed =
		workerReport.status === "DONE" || workerReport.status === "UNKNOWN";
	const workerStatusDetails =
		workerReport.status === "BLOCKED"
			? `Worker reported status: BLOCKED (${workerReport.summary})`
			: workerReport.status === "PARTIAL"
				? `Worker reported status: PARTIAL (${workerReport.summary})`
				: `Worker reported status: ${workerReport.status}`;

	const overallPassed =
		fileScopePassed &&
		unitTestsPassed &&
		testIntegrityPassed &&
		testExecPassed &&
		workerStatusPassed;

	return {
		gateReport: {
			passed: overallPassed,
			checks: {
				fileScope: {
					name: "File Scope Boundary",
					passed: fileScopePassed,
					details: fileScopeDetails,
				},
				unitTestsPresent: {
					name: "Accompanying Unit Tests",
					passed: unitTestsPassed,
					details: unitTestsDetails,
				},
				testIntegrity: {
					name: "Test Integrity (No .only/.skip)",
					passed: testIntegrityPassed,
					details: testIntegrityDetails,
				},
				testExecution: {
					name: "Independent Test Execution",
					passed: testExecPassed,
					details: testExecDetails,
				},
				workerStatus: {
					name: "Worker Completion Status",
					passed: workerStatusPassed,
					details: workerStatusDetails,
				},
			},
			testCommandResult: testCmdResult,
			outOfScopeFiles,
			touchedTestFiles,
			touchedImplFiles,
			tamperingWarnings,
		},
		workerReport,
	};
}

export interface CommandResult {
	command: string;
	exitCode: number;
	durationMs: number;
	outputTail: string;
	/** First lines, captured before the rolling tail buffer drops them */
	outputHead: string;
	/** Diagnostic lines matching failure signatures from the whole output */
	failureLines: string[];
	/** cwd + scratch directory summary (so a bad TMPDIR is visible in failure reports) */
	environment: string;
	/** Junk files created in the workspace root by the test command and removed */
	strayArtifacts: string[];
}

const COMMAND_HEAD_LIMIT = 16 * 1024;
const COMMAND_TAIL_LIMIT = 64 * 1024;
const FAILURE_LINE_REGEX =
	/(\b(fail|failed|failure|fatal|error|panic|assert(ion)?|traceback|exception|aborted|not found|no such file|permission denied|mktemp|exit code|exit status|killed|timed out|cannot|unable to)\b|\u2717|\u274c|\[FAIL\]|FAILED|ERROR:)/i;
const FALSE_POSITIVE_LINE_REGEX =
	/(\b0\s+(failed|failures?|errors?)\b|all\s+.{0,24}\s+passed|no failures|passed\s*$)/i;

/**
 * The scratch directory handed to TMPDIR/XDG_CACHE_HOME MUST exist and be writable.
 * LayerFS workspaces create it, but the host workspace used by integration tests does
 * not -- which used to make plain `mktemp` fail with a bogus ENOENT.
 */
function ensureScratchDir(preferred: string, label: string): string {
	try {
		fs.mkdirSync(preferred, { recursive: true });
		fs.accessSync(preferred, fs.constants.W_OK);
		return preferred;
	} catch {
		return fs.mkdtempSync(path.join(os.tmpdir(), `orch-${label}-`));
	}
}

function rootFileSnapshot(dir: string): Set<string> {
	const names = new Set<string>();
	try {
		for (const name of fs.readdirSync(dir)) {
			try {
				const stat = fs.lstatSync(path.join(dir, name));
				if (stat.isFile() || stat.isSymbolicLink()) names.add(name);
			} catch {
				// ignore races on individual entries
			}
		}
	} catch {
		// workspace may not be readable -- nothing to compare
	}
	return names;
}

/** Human-readable report used whenever a command fails. Keeps head + failure lines + tail. */
export function formatCommandDiagnostics(result: CommandResult): string {
	return [
		`Command: \`${result.command}\``,
		`Exit code: ${result.exitCode} | Duration: ${result.durationMs}ms`,
		`Environment: ${result.environment}`,
		"",
		"### Failure signatures (extracted from the full output)",
		result.failureLines.length
			? result.failureLines.slice(0, 80).map((line) => `- ${line}`).join("\n")
			: "(no failure signatures matched)",
		"",
		"### Output head",
		"```",
		result.outputHead || "(no output)",
		"```",
		"",
		"### Output tail",
		"```",
		result.outputTail || "(no output)",
		"```",
		...(result.strayArtifacts.length
			? ["", "### Cleaned stray workspace-root artifacts", ...result.strayArtifacts.map((f) => `- ${f}`)]
			: []),
	].join("\n");
}

export async function executeWorkspaceCommand(
	command: string,
	workspacePath: string,
	signal?: AbortSignal,
	timeoutMs = 120_000,
	options: { cleanupStrayRootFiles?: boolean; scratchRoot?: string } = {},
): Promise<CommandResult> {
	const start = Date.now();
	// Integration tests run against the HOST workspace: keep scratch dirs outside
	// the repo so TMPDIR works without polluting the host working tree.
	const scratchRoot = options.scratchRoot ?? workspacePath;
	const tmpDir = ensureScratchDir(path.join(scratchRoot, ".tmp"), "tmp");
	const cacheDir = ensureScratchDir(path.join(scratchRoot, ".cache"), "cache");
	const environment = [
		`cwd=${workspacePath}`,
		`TMPDIR=${tmpDir}`,
		`XDG_CACHE_HOME=${cacheDir}`,
		"CI=1",
	].join(" | ");
	const rootFilesBefore = options.cleanupStrayRootFiles
		? rootFileSnapshot(workspacePath)
		: new Set<string>();

	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd: workspacePath,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				TMPDIR: tmpDir,
				TMP: tmpDir,
				TEMP: tmpDir,
				XDG_CACHE_HOME: cacheDir,
				CI: "1",
			},
		});

		let combined = "";
		let head = "";
		let pendingLine = "";
		const failureLines: string[] = [];
		const appendText = (text: string) => {
			combined += text;
			if (combined.length > COMMAND_TAIL_LIMIT) {
				combined = combined.slice(combined.length - COMMAND_TAIL_LIMIT);
			}
			if (head.length < COMMAND_HEAD_LIMIT) {
				head += text.slice(0, COMMAND_HEAD_LIMIT - head.length);
			}
			pendingLine += text;
			const parts = pendingLine.split("\n");
			pendingLine = parts.pop() ?? "";
			for (const line of parts) {
				const trimmed = line.trim();
				if (
					trimmed.length > 0 &&
					failureLines.length < 200 &&
					FAILURE_LINE_REGEX.test(trimmed) &&
					!FALSE_POSITIVE_LINE_REGEX.test(trimmed)
				) {
					failureLines.push(trimmed.slice(0, 400));
				}
			}
		};
		const appendChunk = (data: Buffer) => appendText(data.toString("utf-8"));

		proc.stdout.on("data", appendChunk);
		proc.stderr.on("data", appendChunk);

		let settled = false;
		// Declared before `finish` so an already-aborted signal cannot hit a TDZ error.
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let forcedExitCode: number | undefined;
		let onAbort: (() => void) | undefined;

		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			if (pendingLine.trim() && failureLines.length < 200) {
				const trimmed = pendingLine.trim();
				if (FAILURE_LINE_REGEX.test(trimmed) && !FALSE_POSITIVE_LINE_REGEX.test(trimmed)) {
					failureLines.push(trimmed.slice(0, 400));
				}
			}

			const strayArtifacts: string[] = [];
			if (options.cleanupStrayRootFiles) {
				for (const name of rootFileSnapshot(workspacePath)) {
					if (rootFilesBefore.has(name) || name.startsWith(".")) continue;
					const full = path.join(workspacePath, name);
					try {
						if (!fs.lstatSync(full).isFile()) continue;
						fs.rmSync(full, { force: true });
						strayArtifacts.push(name);
					} catch {
						// never let cleanup break test reporting
					}
				}
			}

			const lines = combined.trim().split("\n");
			resolve({
				command,
				exitCode,
				durationMs: Date.now() - start,
				outputTail: lines.slice(-40).join("\n") || "(no output)",
				outputHead: head.split("\n").slice(0, 40).join("\n") || "(no output)",
				failureLines,
				environment,
				strayArtifacts,
			});
		};

		// Terminate first, resolve on "close" -- never leave an orphan process behind.
		const terminate = (code: number, label: string) => {
			if (settled || forcedExitCode !== undefined) return;
			forcedExitCode = code;
			appendText(`\n[${label}]`);
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
			}, 2000);
		};

		timer = setTimeout(() => terminate(124, `Timeout after ${timeoutMs}ms: SIGTERM`), timeoutMs);

		if (signal) {
			onAbort = () => terminate(130, "Aborted by signal: SIGTERM");
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		proc.on("close", (code) => finish(forcedExitCode ?? code ?? 1));
		proc.on("error", (err) => {
			appendText(`\n[Process error: ${err.message}]`);
			finish(127);
		});
	});
}

export function parseWorkerStructuredReport(rawOutput: string): WorkerStructuredReport {
	const text = rawOutput.trim();
	let status: WorkerStructuredReport["status"] = "UNKNOWN";

	const statusMatch = text.match(/^\s*(?:[-*]\s*)?status\s*:\s*(DONE|BLOCKED|PARTIAL)\b/im);
	if (statusMatch) {
		status = statusMatch[1].toUpperCase() as WorkerStructuredReport["status"];
	} else if (/\bstatus:\s*DONE\b/i.test(text)) {
		status = "DONE";
	} else if (/\bstatus:\s*BLOCKED\b/i.test(text)) {
		status = "BLOCKED";
	} else if (/\bstatus:\s*PARTIAL\b/i.test(text)) {
		status = "PARTIAL";
	}

	const extractSectionBullets = (headers: string[]): string[] => {
		const headerPattern = headers.join("|");
		const regex = new RegExp(
			`(?:^|\\n)##+\\s*(?:${headerPattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##+\\s|$)`,
			"i",
		);
		const m = text.match(regex);
		if (!m) return [];
		return m[1]
			.split("\n")
			.map((l) => l.replace(/^\s*[-*0-9.)]+\s*/, "").trim())
			.filter((l) => l.length > 0 && !/^(none|n\/a|无)$/i.test(l));
	};

	const addedTests = extractSectionBullets([
		"新增测试",
		"Added Tests",
		"Unit Tests",
		"Tests Added",
	]);
	const assumptions = extractSectionBullets(["假设", "Assumptions"]);
	const deviations = extractSectionBullets([
		"偏离任务说明的地方",
		"偏离",
		"Deviations",
	]);
	const risks = extractSectionBullets([
		"给主代理的提示\\s*\\/\\s*风险",
		"风险",
		"Risks",
		"Notes",
	]);

	const summaryLines = text
		.split("\n")
		.filter((l) => l.trim().length > 0 && !l.startsWith("#") && !/^status\s*:/i.test(l))
		.slice(0, 3);

	return {
		status,
		summary: summaryLines.join(" ").slice(0, 300) || "(no summary)",
		addedTests,
		assumptions,
		deviations,
		risks,
		rawOutput: text,
	};
}
