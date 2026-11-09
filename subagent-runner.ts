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
	TaskRuntimeState,
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
	/**
	 * Prompt-cache retention for the worker (`PI_CACHE_RETENTION`).
	 * Unset falls back to `PI_ORCHESTRATOR_CACHE_RETENTION`, then to "short";
	 * an empty string disables the variable entirely.
	 */
	cacheRetention?: string;
	/**
	 * Resolved skill paths granted to this task's worker. The global `subagentSkills`
	 * config plus the task spec's own list, already resolved by the lead at dispatch
	 * time. Passed through as `--skill <path>` pairs, so retries stay byte-identical.
	 */
	skills?: string[];
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

/** Default prompt-cache retention injected into every worker process. */
export const DEFAULT_WORKER_CACHE_RETENTION = "short";

/** The session id a worker persists its conversation under, reused per attempt. */
export function workerSessionId(taskId: string): string {
	return `worker-${taskId}`;
}

/**
 * `workspaces/<task>/root` → `workspaces/<task>/sessions`.
 *
 * The sessions dir is a SIBLING of the workspace root: remounting wipes the root
 * but not its parent, so attempt #2 finds the same `<sessionId>.jsonl` and pi
 * resumes it by id without any extra flag.
 */
export function workerSessionDir(workspacePath: string): string {
	const trimmed = workspacePath.replace(/[\\/]+$/, "");
	if (!trimmed) return path.join(workspacePath, "sessions");
	return path.join(path.dirname(trimmed), "sessions");
}

export interface WorkerCliOptions {
	model?: string;
	thinkingLevel?: string;
	/** Resolved skill paths granted to the worker; each becomes one `--skill <path>` pair. */
	skills?: readonly string[];
}

export interface WorkerCliResult {
	/** Full pi CLI argument array; the prompt positional is pushed by the caller. */
	args: string[];
	/** Echoed back so the caller can `mkdir -p` it and record it on the task state. */
	sessionDir: string;
}

/**
 * PURE: builds the complete pi CLI argument array for a worker process.
 *
 * Never touches `fs` / `process`, so retries (attempt > 1) get byte-identical
 * args: the same `--session-dir` + `--session-id` make pi restore and append to
 * the existing jsonl session on its own.
 */
export function buildWorkerCliArgs(
	taskId: string,
	sessionDir: string,
	opts: WorkerCliOptions = {},
): WorkerCliResult {
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--session-dir",
		sessionDir,
		"--session-id",
		workerSessionId(taskId),
		"--tools",
		"read,write,edit,bash",
	];

	if (opts.model) {
		args.push("--model", opts.model);
	}
	if (opts.thinkingLevel) {
		args.push("--thinking", opts.thinkingLevel);
	}
	for (const skillPath of opts.skills ?? []) {
		args.push("--skill", skillPath);
	}

	return { args, sessionDir };
}

/**
 * Resolution order: explicit option → `PI_ORCHESTRATOR_CACHE_RETENTION` → "short".
 * An empty/blank resolved value means "do not set the variable at all".
 * PURE: the caller passes the env snapshot it wants consulted.
 */
export function resolveCacheRetention(
	explicit: string | undefined,
	env: Record<string, string | undefined> = {},
): string | undefined {
	const raw = explicit ?? env.PI_ORCHESTRATOR_CACHE_RETENTION ?? DEFAULT_WORKER_CACHE_RETENTION;
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

export interface WorkerSpawnEnvParams {
	baseEnv: Record<string, string | undefined>;
	taskId: string;
	allowedCombined: readonly string[];
	forbidden: readonly string[];
	/** `scratchEnvironment()` output (TMPDIR / TMP / TEMP / XDG_CACHE_HOME) */
	scratch: Record<string, string>;
	/** `options.cacheRetention`; undefined falls back to env, then "short". */
	cacheRetention?: string;
}

/**
 * PURE: the env handed to `spawn()` for a worker process.
 *
 * `undefined` values are stripped (spawn would coerce them to the string
 * "undefined") and `PI_CACHE_RETENTION` is only present when it resolves to a
 * non-empty value — an inherited value is therefore actively removed when the
 * caller asks for "no caching policy".
 */
export function buildWorkerSpawnEnv(params: WorkerSpawnEnvParams): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(params.baseEnv)) {
		if (typeof value === "string") env[key] = value;
	}

	env.PI_ORCHESTRATOR_WORKER = "1";
	env.PI_ORCHESTRATOR_TASK_ID = params.taskId;
	env.PI_ORCHESTRATOR_ALLOWED_FILES = JSON.stringify(params.allowedCombined);
	env.PI_ORCHESTRATOR_FORBIDDEN_FILES = JSON.stringify(params.forbidden);

	for (const [key, value] of Object.entries(params.scratch)) {
		if (typeof value === "string") env[key] = value;
	}

	const cacheRetention = resolveCacheRetention(params.cacheRetention, params.baseEnv);
	if (cacheRetention === undefined) {
		delete env.PI_CACHE_RETENTION;
	} else {
		env.PI_CACHE_RETENTION = cacheRetention;
	}

	return env;
}

interface SessionFileCandidate {
	path: string;
	mtimeMs: number;
}

const SESSION_FILE_SUFFIX = ".jsonl";
const SESSION_DIR_MAX_DEPTH = 4;

/**
 * `worker-<taskId>.jsonl`, or a pi-prefixed variant such as
 * `<timestamp>_worker-<taskId>.jsonl`. Sibling task ids (`worker-t5-b`) must NOT
 * match `worker-t5`.
 */
function isWorkerSessionStem(stem: string, sessionId: string): boolean {
	if (stem === sessionId) return true;
	if (stem.length <= sessionId.length || !stem.endsWith(sessionId)) return false;
	const head = stem.slice(0, stem.length - sessionId.length);
	return head.endsWith("_") || head.endsWith("-");
}

function collectWorkerSessionFiles(
	dir: string,
	sessionId: string,
	depth: number,
	out: SessionFileCandidate[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (depth > 0) collectWorkerSessionFiles(full, sessionId, depth - 1, out);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(SESSION_FILE_SUFFIX)) continue;
		const stem = entry.name.slice(0, -SESSION_FILE_SUFFIX.length);
		if (!isWorkerSessionStem(stem, sessionId)) continue;
		try {
			out.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
		} catch {
			// A file that vanishes mid-scan is simply not a candidate.
		}
	}
}

/**
 * Newest `worker-<taskId>.jsonl` under `sessionDir`, or `undefined`.
 * Never throws: a missing dir, a permission error or an empty dir all mean
 * "no session file to record yet".
 */
export function resolveWorkerSessionFile(sessionDir: string, taskId: string): string | undefined {
	const candidates: SessionFileCandidate[] = [];
	try {
		collectWorkerSessionFiles(sessionDir, workerSessionId(taskId), SESSION_DIR_MAX_DEPTH, candidates);
	} catch {
		return undefined;
	}
	if (candidates.length === 0) return undefined;
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
	return candidates[0].path;
}

/**
 * Records the worker's actual session jsonl on the task state (best effort).
 * Missing file → `undefined` (a stale value from an earlier attempt is cleared),
 * never a throw.
 */
export function attachWorkerSessionFile(
	state: Pick<TaskRuntimeState, "workerSessionFile">,
	sessionDir: string,
	taskId: string,
): string | undefined {
	const file = resolveWorkerSessionFile(sessionDir, taskId);
	state.workerSessionFile = file;
	return file;
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

	// Persist the worker conversation as a sibling of the (remountable) workspace
	// root, so attempt > 1 resumes the SAME jsonl instead of starting cold.
	const sessionDir = workerSessionDir(wsInfo.workspacePath);
	try {
		fs.mkdirSync(sessionDir, { recursive: true });
	} catch {
		// A missing sessions dir only costs cross-attempt resume; pi still runs.
	}
	state.recentActivity = [
		...(state.recentActivity ?? []),
		state.attempts > 1
			? `Resuming worker session ${workerSessionId(spec.id)} from ${sessionDir} (attempt ${state.attempts}).`
			: `Persisting worker session ${workerSessionId(spec.id)} to ${sessionDir} (attempt ${state.attempts}).`,
	];

	const sysPrompt = buildWorkerSystemPrompt(spec);
	const userPrompt = buildWorkerTaskPrompt(record);
	const tmpPrompt = await writeTempSystemPrompt(spec.id, sysPrompt);

	const workerCli = buildWorkerCliArgs(spec.id, sessionDir, {
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		skills: options.skills,
	});
	const cliArgs = workerCli.args;
	// The system prompt file is a runtime artifact, so it is appended here rather
	// than inside the pure CLI builder; the prompt positional stays last.
	cliArgs.push("--append-system-prompt", tmpPrompt.filePath);
	cliArgs.push(userPrompt);

	const allowedCombined = [...spec.allowedFiles, ...spec.testFiles];
	let lastAssistantText = "";
	let stderrBuf = "";
	const workerTimeoutMs = options.workerTimeoutMs ?? 15 * 60 * 1000;
	// Best effort only: the jsonl may not exist before pi starts or after a crash.
	const captureWorkerSessionFile = () => attachWorkerSessionFile(state, sessionDir, spec.id);

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(cliArgs);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: wsInfo.workspacePath,
				stdio: ["ignore", "pipe", "pipe"],
				env: buildWorkerSpawnEnv({
					baseEnv: process.env,
					taskId: spec.id,
					allowedCombined,
					forbidden: spec.doNotTouch ?? [],
					scratch: scratchEnvironment(wsInfo),
					cacheRetention: options.cacheRetention,
				}),
			});

			captureWorkerSessionFile();

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

		// Authoritative capture: by now pi has flushed/appended the session jsonl.
		captureWorkerSessionFile();

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
