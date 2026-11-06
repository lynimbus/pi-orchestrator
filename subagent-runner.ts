/**
 * Subagent Worker Spawner & Parallel Wave Executor
 *
 * Spawns isolated `pi` processes inside LayerFS branch workspaces,
 * applies the configured subagent model & thinking level, enforces file scope
 * inside the worker, commits workspace snapshots via CAS, and runs the
 * Mechanical Verification Gate.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LayerFSEngine } from "./layerfs-engine.ts";
import { superviseChildProcess } from "./process-runner.ts";
import type {
	TaskRecord,
	TaskSpec,
	UsageStats,
} from "./types.ts";
import { runMechanicalVerificationGate } from "./verifier.ts";
import { scratchDirs, scratchEnvironment } from "./workspace-env.ts";

export interface SubagentDispatchOptions {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	maxConcurrency: number;
	signal?: AbortSignal;
	onProgress?: () => void;
	/** Hard timeout for a single worker process (default 15 minutes) */
	workerTimeoutMs?: number;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: readonly TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;

	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});

	await Promise.all(workers);
	return results;
}

function buildWorkerSystemPrompt(spec: TaskSpec): string {
	const allowed = [...spec.allowedFiles, ...spec.testFiles];
	return `You are an isolated Subagent Worker executing atomic task ${spec.id} ("${spec.title}") inside an ephemeral LayerFS Branch Workspace.

STRICT WORKER RULES:
1. SCOPE BOUNDARY: You may ONLY create or modify files matching:
   ${allowed.map((p) => `- ${p}`).join("\n   ")}
   ${spec.doNotTouch?.length ? `FORBIDDEN files (never touch):\n   ${spec.doNotTouch.map((p) => `- ${p}`).join("\n   ")}` : ""}
   Any modification outside your allowed scope is automatically blocked and rejected by the Mechanical Gate.
2. MANDATORY TDD & UNIT TESTS:
   - Write or update unit tests in [${spec.testFiles.join(", ")}] FIRST (verify they fail or cover the contract), then implement the code to make them pass.
   - You MUST cover every required test case in the task specification (you may add more edge cases, never omit required ones).
   - NEVER use .only, .skip, xit, t.Skip, or delete existing assertions.
3. VERIFICATION:
   - Run the verification command before finishing: \`${spec.testCommand}\`
   - Ensure it exits with code 0.
4. NO ASSUMPTIONS SILENTLY HIDDEN:
   - If the requirement is genuinely impossible or contradictory, return \`status: BLOCKED\` and explain why.
5. FINAL RESPONSE FORMAT (MANDATORY):
   Your final message MUST follow this exact structure:

status: DONE | BLOCKED | PARTIAL
task: ${spec.id}

## 改动文件
- <path> (<short summary>)

## 新增测试
- <test name> —— <which acceptance criterion / test case it covers>

## 执行过的验证
$ ${spec.testCommand}
<exit code & brief output>

## 假设
- <any assumptions made, or 无>

## 偏离任务说明的地方
- <any deviations, or 无>

## 给主代理的提示 / 风险
- <any integration notes or edge-case risks, or 无>
`;
}

function buildWorkerTaskPrompt(record: TaskRecord): string {
	const { spec, state } = record;
	const requiredCasesTable =
		spec.requiredTestCases.length > 0
			? [
					"| 输入 / 场景 (Input) | 期望结果 (Expected) |",
					"|---|---|",
					...spec.requiredTestCases.map((tc) => `| ${tc.input} | ${tc.expected} |`),
				].join("\n")
			: "- Cover normal path, boundary conditions, and error cases.";

	const criteriaList = spec.acceptanceCriteria
		.map((c, idx) => `${idx + 1}. ${c}`)
		.join("\n");

	let retrySection = "";
	if (state.attempts > 1) {
		const lastReview = state.reviewHistory[state.reviewHistory.length - 1];
		const gateFailures = state.gateReport
			? Object.values(state.gateReport.checks)
					.filter((c) => !c.passed)
					.map((c) => `- [GATE FAILED] ${c.name}: ${c.details}`)
					.join("\n")
			: "";

		retrySection = `
================================================================
⚠️ RETRY ATTEMPT #${state.attempts} — PREVIOUS ATTEMPT WAS REJECTED
================================================================
Your LayerFS workspace already contains your files from Attempt #${state.attempts - 1}.
Inspect the current files, fix the issues below, re-run \`${spec.testCommand}\`, and report back.

${lastReview ? `### Lead Agent Rejection Feedback:\n${lastReview.feedback}\n` : ""}
${gateFailures ? `### Mechanical Gate Failures from Previous Attempt:\n${gateFailures}\n` : ""}
${state.gateReport?.testCommandResult && state.gateReport.testCommandResult.exitCode !== 0 ? `### Previous Test Command Output:\n\`\`\`\n${state.gateReport.testCommandResult.outputTail}\n\`\`\`\n` : ""}
================================================================
`;
	}

	return `# 任务 ${spec.id}: ${spec.title}
${retrySection}
## 背景与目标
${spec.description}

## 允许改动的文件 (Allowed Files)
### 实现与允许范围:
${spec.allowedFiles.map((f) => `- \`${f}\``).join("\n")}
### 必须编写/更新的单元测试文件:
${spec.testFiles.map((f) => `- \`${f}\``).join("\n")}
${spec.doNotTouch?.length ? `### 严禁修改的文件:\n${spec.doNotTouch.map((f) => `- \`${f}\``).join("\n")}` : ""}

## 接口约定 (不得擅自破坏签名)
\`\`\`
${spec.interfaceContract}
\`\`\`

## 验收标准 (Acceptance Criteria)
${criteriaList}

## 必须覆盖的单元测试用例 (可补充，不可删减)
${requiredCasesTable}

## 验证命令 (Verification Command)
\`${spec.testCommand}\`

请先编写/更新单元测试，再完成实现，确保验证命令运行通过，并按规定格式输出最终报告。`;
}

async function writeTempSystemPrompt(taskId: string, content: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orch-worker-"));
	const safeId = taskId.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `worker-${safeId}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

export async function runWaveTaskSubagent(
	engine: LayerFSEngine,
	record: TaskRecord,
	options: SubagentDispatchOptions,
): Promise<void> {
	const { spec, state } = record;
	state.status = "running";
	state.attempts += 1;
	state.modelUsed = options.model ?? "(inherit)";
	state.thinkingUsed = options.thinkingLevel ?? "(inherit)";
	state.recentActivity = [`Mounting LayerFS workspace for ${state.branchName}...`];
	options.onProgress?.();

	let wsInfo: {
		workspacePath: string;
		tmpDir: string;
		cacheDir: string;
		headCommitId: string;
		baseLayerId: string;
	};

	if (state.attempts === 1 || !state.headCommitId) {
		engine.forkBranch(state.branchName, state.baseLayerId);
		wsInfo = engine.mountWorkspace(state.branchName);
	} else if (state.workspacePath && fs.existsSync(state.workspacePath)) {
		wsInfo = {
			workspacePath: state.workspacePath,
			...scratchDirs(state.workspacePath),
			headCommitId: state.headCommitId,
			baseLayerId: state.baseLayerId!,
		};
	} else {
		wsInfo = engine.mountWorkspace(state.branchName);
	}

	state.workspacePath = wsInfo.workspacePath;
	state.baseLayerId = wsInfo.baseLayerId;

	const sysPrompt = buildWorkerSystemPrompt(spec);
	const userPrompt = buildWorkerTaskPrompt(record);
	const tmpPrompt = await writeTempSystemPrompt(spec.id, sysPrompt);

	const cliArgs: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		"read,write,edit,bash",
		"--append-system-prompt",
		tmpPrompt.filePath,
	];

	if (options.model) {
		cliArgs.push("--model", options.model);
	}
	if (options.thinkingLevel) {
		cliArgs.push("--thinking", options.thinkingLevel);
	}
	cliArgs.push(userPrompt);

	const allowedCombined = [...spec.allowedFiles, ...spec.testFiles];
	let lastAssistantText = "";
	let stderrBuf = "";
	const workerTimeoutMs = options.workerTimeoutMs ?? 15 * 60 * 1000;

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(cliArgs);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: wsInfo.workspacePath,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_ORCHESTRATOR_WORKER: "1",
					PI_ORCHESTRATOR_TASK_ID: spec.id,
					PI_ORCHESTRATOR_ALLOWED_FILES: JSON.stringify(allowedCombined),
					PI_ORCHESTRATOR_FORBIDDEN_FILES: JSON.stringify(spec.doNotTouch ?? []),
					...scratchEnvironment(wsInfo),
				},
			});

			let stdoutLineBuf = "";

			const processJsonLine = (line: string) => {
				if (!line.trim()) return;
				let evt: any;
				try {
					evt = JSON.parse(line);
				} catch {
					return;
				}

				if (evt.type === "message_end" && evt.message) {
					const msg = evt.message;
					if (msg.role === "assistant") {
						state.usage.turns += 1;
						if (msg.usage) {
							state.usage.input += msg.usage.input || 0;
							state.usage.output += msg.usage.output || 0;
							state.usage.cacheRead += msg.usage.cacheRead || 0;
							state.usage.cacheWrite += msg.usage.cacheWrite || 0;
							state.usage.cost += msg.usage.cost?.total || 0;
							state.usage.contextTokens = msg.usage.totalTokens || state.usage.contextTokens;
						}
						if (msg.model) {
							state.modelUsed = msg.model;
						}
						if (Array.isArray(msg.content)) {
							for (const part of msg.content) {
								if (part.type === "text" && part.text) {
									lastAssistantText = part.text;
								} else if (part.type === "toolCall") {
									const summary = summarizeWorkerToolCall(part.name, part.arguments || {});
									state.recentActivity = [...(state.recentActivity ?? []).slice(-5), summary];
								}
							}
						}
						options.onProgress?.();
					}
				}
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				stdoutLineBuf += chunk.toString("utf-8");
				// Cap a pathological single-line (no newline) JSON stream.
				if (stdoutLineBuf.length > 256 * 1024) {
					stdoutLineBuf = stdoutLineBuf.slice(-64 * 1024);
				}
				const lines = stdoutLineBuf.split("\n");
				stdoutLineBuf = lines.pop() || "";
				for (const l of lines) processJsonLine(l);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				stderrBuf += chunk.toString("utf-8");
				if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384);
			});

			// Timeout (124) / abort (130) / spawn error (1) policy lives in process-runner.ts.
			superviseChildProcess(proc, {
				timeoutMs: workerTimeoutMs,
				signal: options.signal,
				onTerminate: (label) => {
					stderrBuf += `\n[${label}]`;
				},
				onProcessError: () => 1,
				onFinish: (code: number) => {
					if (stdoutLineBuf.trim()) processJsonLine(stdoutLineBuf);
					resolve(code);
				},
			});
		});

		if (exitCode !== 0 && !lastAssistantText) {
			state.lastError =
				exitCode === 124
					? `Subagent timed out after ${workerTimeoutMs}ms`
					: stderrBuf.trim() || `Subagent exited with code ${exitCode}`;
		}

		state.recentActivity = [...(state.recentActivity ?? []).slice(-5), "Committing LayerFS snapshot & running Mechanical Gate..."];
		options.onProgress?.();

		const commit = engine.commitWorkspace(
			state.branchName,
			`Task ${spec.id} attempt #${state.attempts}`,
			wsInfo.headCommitId,
		);
		state.headCommitId = commit.commitId;

		const diff = engine.diffBranch(state.branchName, spec.testFiles);
		state.diff = diff;

		const { gateReport, workerReport } = await runMechanicalVerificationGate(
			spec,
			wsInfo.workspacePath,
			diff,
			lastAssistantText || stderrBuf || "(no output)",
			options.signal,
		);
		state.gateReport = gateReport;
		state.workerReport = workerReport;

		if (gateReport.passed) {
			state.status = "awaiting_review";
			state.recentActivity = [...(state.recentActivity ?? []).slice(-5), "✓ Mechanical Gate passed; awaiting Lead Agent review"];
		} else {
			state.status = "gate_failed";
			state.recentActivity = [...(state.recentActivity ?? []).slice(-5), "✗ Mechanical Gate failed"];
		}
		options.onProgress?.();
	} finally {
		try {
			await fs.promises.rm(tmpPrompt.dir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

function summarizeWorkerToolCall(name: string, args: Record<string, any>): string {
	if (name === "bash") {
		const cmd = String(args.command || "").replace(/\s+/g, " ").trim();
		return `$ ${cmd.length > 55 ? `${cmd.slice(0, 52)}...` : cmd}`;
	}
	if (name === "write" || name === "edit" || name === "read") {
		const p = String(args.path || args.file_path || "");
		return `${name} ${p}`;
	}
	return `${name}()`;
}

export function createEmptyUsageStats(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}
