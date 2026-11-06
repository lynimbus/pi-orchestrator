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

export async function executeWorkspaceCommand(
	command: string,
	workspacePath: string,
	signal?: AbortSignal,
	timeoutMs = 120_000,
): Promise<{
	command: string;
	exitCode: number;
	durationMs: number;
	outputTail: string;
}> {
	const start = Date.now();
	const tmpDir = path.join(workspacePath, ".tmp");
	const cacheDir = path.join(workspacePath, ".cache");

	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			cwd: workspacePath,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				TMPDIR: tmpDir,
				XDG_CACHE_HOME: cacheDir,
				CI: "1",
			},
		});

		let combined = "";
		const maxBuffer = 64 * 1024;
		const appendChunk = (data: Buffer) => {
			combined += data.toString("utf-8");
			if (combined.length > maxBuffer) {
				combined = combined.slice(combined.length - maxBuffer);
			}
		};

		proc.stdout.on("data", appendChunk);
		proc.stderr.on("data", appendChunk);

		let settled = false;
		const finish = (exitCode: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const lines = combined.trim().split("\n");
			const tail = lines.slice(-40).join("\n");
			resolve({
				command,
				exitCode,
				durationMs: Date.now() - start,
				outputTail: tail || "(no output)",
			});
		};

		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 2000);
			combined += `\n[Timeout after ${timeoutMs}ms]`;
			finish(124);
		}, timeoutMs);

		if (signal) {
			const onAbort = () => {
				proc.kill("SIGTERM");
				combined += "\n[Aborted by signal]";
				finish(130);
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("close", (code) => finish(code ?? 1));
		proc.on("error", (err) => {
			combined += `\n[Process error: ${err.message}]`;
			finish(1);
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
