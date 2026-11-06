/**
 * Pi Orchestrator Extension
 *
 * Enforces a strict Lead-Subagent TDD & LayerFS-isolated workflow when enabled:
 * 1. Lead Agent decomposes the user request into atomic, independently verifiable tasks
 *    organized into topological dependency waves (`orch_plan`).
 * 2. Optional Wave 0: Lead Agent creates shared interfaces/types/stubs (`orch_wave0_commit`).
 * 3. Wave Dispatch (`orch_dispatch`): Spawns isolated Subagent Workers in parallel on
 *    ephemeral LayerFS Branches/Workspaces using the configured Subagent Model & Thinking Level.
 *    Each worker MUST write accompanying unit tests and pass the Mechanical Verification Gate.
 * 4. Lead Review (`orch_review`): Lead Agent reviews ONLY the implementation diff, unit test diff,
 *    and Mechanical Gate report. Cannot approve tasks that failed the Mechanical Gate.
 *    Rejected tasks are re-dispatched on the same LayerFS workspace (up to maxRetries).
 * 5. Wave Integration (`orch_integrate`): Performs a deterministic 3-Way Tree & Line Merge across
 *    all approved branches in the wave, publishes a new immutable Layer to the host repo,
 *    and runs the wave/integration test suite.
 *
 * Commands & Shortcuts:
 * - `/orch`            : Interactive configuration & status menu
 * - `/orch on|off`     : Enable / disable strict Orchestrator workflow
 * - `/orch model [id]` : Configure Subagent model (or `inherit`)
 * - `/orch thinking [level]` : Configure Subagent thinking level (or `inherit`)
 * - `/orch status`     : Show active plan, wave status & LayerFS store metrics
 * - `/orch reset`      : Reset active orchestration plan
 * - `Ctrl+Alt+O`       : Quick toggle Orchestrator mode ON/OFF
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { LayerFSEngine, matchesAnyPattern } from "./layerfs-engine.ts";
import {
	decideIntegrationAction,
	decideRetryIntegrationAction,
	decideRollbackIntegrationAction,
	reconcileIntegrationRecord,
} from "./integration-state.ts";
import {
	createEmptyUsageStats,
	mapWithConcurrencyLimit,
	runWaveTaskSubagent,
} from "./subagent-runner.ts";
import type {
	OrchestrationPlan,
	OrchestratorConfig,
	TaskRecord,
	TaskSpec,
	TaskStatus,
} from "./types.ts";
import {
	type CommandResult,
	computeDependencyWaves,
	executeWorkspaceCommand,
	formatCommandDiagnostics,
} from "./verifier.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const DEFAULT_CONFIG: OrchestratorConfig = {
	enabled: false,
	subagentModel: undefined,
	subagentThinkingLevel: undefined,
	maxConcurrency: 4,
	maxRetries: 2,
	requireHumanPlanApproval: false,
	requireHumanFinalApproval: false,
	allowAutoThreeWayLineMerge: true,
};

function getConfigFilePath(): string {
	return path.join(getAgentDir(), "orchestrator.json");
}

function loadConfig(): OrchestratorConfig {
	const filePath = getConfigFilePath();
	if (fs.existsSync(filePath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			return { ...DEFAULT_CONFIG, ...parsed };
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}
	return { ...DEFAULT_CONFIG };
}

function saveConfig(config: OrchestratorConfig): void {
	const filePath = getConfigFilePath();
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
}

function toRelPath(cwd: string, targetPath: string): string {
	const resolved = path.resolve(cwd, targetPath);
	const rel = path.relative(cwd, resolved);
	return rel.replace(/\\/g, "/");
}

/**
 * Worker-side guard when this extension loads inside a spawned Subagent Worker process.
 */
function setupSubagentWorkerMode(pi: ExtensionAPI): void {
	const taskId = process.env.PI_ORCHESTRATOR_TASK_ID || "worker";
	let allowedPatterns: string[] = [];
	let forbiddenPatterns: string[] = [];

	try {
		allowedPatterns = JSON.parse(process.env.PI_ORCHESTRATOR_ALLOWED_FILES || "[]");
	} catch {
		allowedPatterns = [];
	}
	try {
		forbiddenPatterns = JSON.parse(process.env.PI_ORCHESTRATOR_FORBIDDEN_FILES || "[]");
	} catch {
		forbiddenPatterns = [];
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as Record<string, any>;
			const rawPath = String(input.path || input.file_path || "");
			if (!rawPath) return;

			const relPath = toRelPath(ctx.cwd, rawPath);
			if (relPath.startsWith("..")) {
				return {
					block: true,
					reason: `[LayerFS Worker Scope Gate] Task ${taskId} cannot modify files outside its LayerFS workspace (${rawPath}).`,
				};
			}
			if (forbiddenPatterns.length > 0 && matchesAnyPattern(relPath, forbiddenPatterns)) {
				return {
					block: true,
					reason: `[LayerFS Worker Scope Gate] File "${relPath}" is in the forbidden doNotTouch list for task ${taskId}.`,
				};
			}
			if (allowedPatterns.length > 0 && !matchesAnyPattern(relPath, allowedPatterns)) {
				return {
					block: true,
					reason: `[LayerFS Worker Scope Gate] File "${relPath}" is outside allowed scope for task ${taskId}. Allowed patterns: ${allowedPatterns.join(", ")}`,
				};
			}
		}
	});
}

export default function orchestratorExtension(pi: ExtensionAPI): void {
	// If running inside a child Subagent Worker process, activate lightweight worker scope guard only.
	if (process.env.PI_ORCHESTRATOR_WORKER === "1") {
		setupSubagentWorkerMode(pi);
		return;
	}

	let config: OrchestratorConfig = loadConfig();
	let activePlan: OrchestrationPlan | null = null;
	let autoContinueNudgeCount = 0;

	// Register CLI flags
	pi.registerFlag("orch", {
		description: "Start with strict Lead-Subagent TDD Orchestrator workflow enabled",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("orch-model", {
		description: "Default model for Orchestrator subagents (provider/modelId)",
		type: "string",
	});
	pi.registerFlag("orch-thinking", {
		description: "Default thinking level for Orchestrator subagents (off|minimal|low|medium|high|xhigh)",
		type: "string",
	});

	function getEngine(cwd: string): LayerFSEngine {
		return new LayerFSEngine(cwd, activePlan?.projectId);
	}

	interface StatusDiagnostics {
		hostVerification?: {
			matches: boolean;
			mismatches: string[];
			checked: number;
			layerId: string;
		};
		headFileCount?: number;
		parentFileCount?: number;
		treeRegression?: boolean;
	}

	/** Cheap, non-throwing consistency diagnostics for `/orch status`. */
	function collectStatusDiagnostics(engine: LayerFSEngine): StatusDiagnostics {
		const diag: StatusDiagnostics = {};
		try {
			const headLayerId = engine.getHeadLayerId();
			if (!headLayerId) return diag;
			diag.headFileCount = Object.keys(engine.getLayerTree(headLayerId)).length;
			const headLayer = engine.loadLayer(headLayerId);
			if (headLayer.parentLayerId) {
				diag.parentFileCount = Object.keys(
					engine.getLayerTree(headLayer.parentLayerId),
				).length;
				diag.treeRegression = diag.headFileCount < diag.parentFileCount;
			}
			if (activePlan) diag.hostVerification = engine.verifyHostMatchesLayer(headLayerId);
		} catch {
			// status reporting must never fail the tool call
		}
		return diag;
	}

	function resolveEffectiveSubagentModel(ctx: ExtensionContext): string | undefined {
		if (config.subagentModel && config.subagentModel !== "inherit") {
			return config.subagentModel;
		}
		if (ctx.model) {
			return `${ctx.model.provider}/${ctx.model.id}`;
		}
		return undefined;
	}

	function resolveEffectiveSubagentThinking(ctx: ExtensionContext): ThinkingLevel | undefined {
		if (config.subagentThinkingLevel) {
			return config.subagentThinkingLevel;
		}
		const lvl = ctx.thinkingLevel as ThinkingLevel | undefined;
		if (lvl && THINKING_LEVELS.includes(lvl)) {
			return lvl;
		}
		return undefined;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		if (!config.enabled) {
			ctx.ui.setStatus("orchestrator", undefined);
			ctx.ui.setWidget("orchestrator", undefined);
			return;
		}

		const modelLabel = config.subagentModel || "inherit";
		const thinkLabel = config.subagentThinkingLevel || "inherit";
		const phaseLabel = activePlan
			? `${activePlan.phase} (W${activePlan.currentWaveIndex + 1}/${activePlan.waves.length})`
			: "READY";

		ctx.ui.setStatus(
			"orchestrator",
			ctx.ui.theme.fg("accent", `⚡Orch[${phaseLabel}]`) +
				ctx.ui.theme.fg("dim", ` sub:${modelLabel}@${thinkLabel}`),
		);

		if (activePlan && activePlan.phase !== "COMPLETED") {
			const lines: string[] = [];
			lines.push(
				ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`⚡ Orchestrator Plan: ${activePlan.goal}`)) +
					ctx.ui.theme.fg("dim", `  [Base Layer: ${activePlan.baseLayerId} | Phase: ${activePlan.phase}]`),
			);
			if (activePlan.integration) {
				lines.push(
					ctx.ui.theme.fg("dim", `  Integration: ${activePlan.integration.status} | Layer: ${activePlan.integration.publishedLayerId ?? "(none)"} | test exit: ${activePlan.integration.testExitCode ?? "unknown"}`),
				);
			}

			for (let wIdx = 0; wIdx < activePlan.waves.length; wIdx++) {
				const waveIds = activePlan.waves[wIdx];
				const isCurrent = wIdx === activePlan.currentWaveIndex;
				const prefix = isCurrent ? "▶" : wIdx < activePlan.currentWaveIndex ? "✓" : " ";
				const taskBadges = waveIds.map((id) => {
					const st = activePlan!.tasks[id].state.status;
					const icon =
						st === "merged" || st === "approved"
							? "✓"
							: st === "running"
								? "⟳"
								: st === "awaiting_review"
									? "👁"
									: st === "gate_failed" || st === "rejected"
										? "✗"
										: st === "escalated"
											? "⚠"
											: "○";
					return `${icon} ${id}`;
				});
				lines.push(
					ctx.ui.theme.fg(isCurrent ? "warning" : "muted", `  ${prefix} Wave ${wIdx + 1}: `) +
						taskBadges.join("  "),
				);
			}
			ctx.ui.setWidget("orchestrator", lines);
		} else {
			ctx.ui.setWidget("orchestrator", undefined);
		}
	}

	function persistState(): void {
		saveConfig(config);
		pi.appendEntry("orchestrator-state", {
			config,
			activePlan,
		});
	}

	// =========================================================================
	// Orchestration Tools for the Lead Agent
	// =========================================================================

	const TaskSpecSchema = Type.Object({
		id: Type.String({ description: "Short unique task ID, e.g. 'T1', 'T2'" }),
		title: Type.String({ description: "Concise one-line title of the atomic task" }),
		description: Type.String({ description: "Self-contained context and implementation instructions for the worker" }),
		dependsOn: Type.Optional(
			Type.Array(Type.String(), { description: "Task IDs this task depends on (empty for Wave 1)" }),
		),
		allowedFiles: Type.Array(Type.String(), {
			description: "Relative file paths or globs the worker is allowed to create or modify",
		}),
		testFiles: Type.Array(Type.String(), {
			description: "Unit test file paths that the worker MUST create or update",
		}),
		testCommand: Type.String({
			description: "Exact shell command to run the unit tests for this task (must exit 0 on pass)",
		}),
		interfaceContract: Type.String({
			description: "Exact function/class/CLI signatures, input/output types, and error semantics",
		}),
		acceptanceCriteria: Type.Array(Type.String(), {
			description: "Verifiable acceptance criteria checklist",
		}),
		requiredTestCases: Type.Array(
			Type.Object({
				input: Type.String({ description: "Test scenario or input" }),
				expected: Type.String({ description: "Expected output or behavior" }),
			}),
			{ description: "Mandatory unit test cases the worker must cover" },
		),
		doNotTouch: Type.Optional(
			Type.Array(Type.String(), { description: "Files or globs the worker must never modify" }),
		),
	});

	pi.registerTool({
		name: "orch_plan",
		label: "Orchestrator: Register Plan",
		description:
			"Register a decomposed multi-wave task plan and initialize the LayerFS base Layer. Required before dispatching subagents or editing Wave 0 shared files.",
		promptSnippet:
			"Decompose a request into atomic tasks with unit test specs and register the execution plan",
		promptGuidelines: [
			"When Orchestrator Mode is active, always call orch_plan before attempting any code modifications.",
			"Ensure every task in orch_plan specifies explicit allowedFiles, testFiles, testCommand, interfaceContract, and requiredTestCases.",
		],
		parameters: Type.Object({
			goal: Type.String({ description: "Overall user goal being orchestrated" }),
			wave0Files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional shared interface/type/stub files that the Lead Agent will create/edit in Wave 0 before dispatching Wave 1 subagents. Leave empty to skip Wave 0.",
				}),
			),
			integrationTestCommand: Type.String({
				description: "Full project/integration test command to run after merging each wave",
			}),
			tasks: Type.Array(TaskSpecSchema, {
				description: "Atomic tasks to be executed by isolated subagents",
				minItems: 1,
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Registering a second plan while one is active silently discards the old
			// plan state (and re-imports a possibly changed host tree). Refuse instead.
			if (activePlan && activePlan.phase !== "COMPLETED") {
				return {
					content: [
						{
							type: "text",
							text: [
								`⛔ A plan is already active (phase ${activePlan.phase}, Wave ${activePlan.currentWaveIndex + 1}/${activePlan.waves.length}).`,
								"Calling `orch_plan` again would abandon it and can lose already published work.",
								"Finish the current plan, or use `/orch reset` (and verify the host tree) before registering a new one.",
							].join("\n"),
						},
					],
					isError: true,
				};
			}
			const normalizedTasks: TaskSpec[] = params.tasks.map((t) => ({
				id: t.id.trim(),
				title: t.title.trim(),
				description: t.description,
				dependsOn: t.dependsOn ?? [],
				allowedFiles: t.allowedFiles,
				testFiles: t.testFiles,
				testCommand: t.testCommand,
				interfaceContract: t.interfaceContract,
				acceptanceCriteria: t.acceptanceCriteria,
				requiredTestCases: t.requiredTestCases,
				doNotTouch: t.doNotTouch,
			}));

			for (const t of normalizedTasks) {
				if (t.testFiles.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Plan rejected: Task "${t.id}" has empty testFiles. Every subagent task MUST write accompanying unit tests.`,
							},
						],
						isError: true,
					};
				}
				if (t.requiredTestCases.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Plan rejected: Task "${t.id}" has no requiredTestCases. The Lead Agent must specify mandatory test cases upfront.`,
							},
						],
						isError: true,
					};
				}
			}

			const { waves, error } = computeDependencyWaves(normalizedTasks);
			if (error) {
				return {
					content: [{ type: "text", text: `Plan topological error: ${error}` }],
					isError: true,
				};
			}

			if (config.requireHumanPlanApproval && ctx.hasUI) {
				const waveSummary = waves
					.map((w, i) => `Wave ${i + 1}: ${w.join(", ")}`)
					.join(" | ");
				const ok = await ctx.ui.confirm(
					"Confirm Orchestration Plan?",
					`${ normalizedTasks.length } tasks across ${waves.length} wave(s) (${waveSummary})`,
				);
				if (!ok) {
					return {
						content: [
							{
								type: "text",
								text: "User declined the orchestration plan. Ask the user how they would like to adjust the task breakdown.",
							},
						],
						isError: true,
					};
				}
			}

			const engine = new LayerFSEngine(ctx.cwd);
			const baseLayer = engine.importHostAsLayer(`Initial plan import: ${params.goal}`);

			const wave0Files = params.wave0Files ?? [];
			const hasWave0 = wave0Files.length > 0;

			const taskRecords: Record<string, TaskRecord> = {};
			for (let wIdx = 0; wIdx < waves.length; wIdx++) {
				for (const id of waves[wIdx]) {
					const spec = normalizedTasks.find((t) => t.id === id)!;
					taskRecords[id] = {
						spec,
						state: {
							id,
							wave: wIdx + 1,
							status: "pending",
							attempts: 0,
							branchName: `task-${id.toLowerCase()}`,
							baseLayerId: baseLayer.layerId,
							reviewHistory: [],
							usage: createEmptyUsageStats(),
						},
					};
				}
			}

			activePlan = {
				planId: `plan-${Date.now()}`,
				goal: params.goal,
				createdAt: Date.now(),
				phase: hasWave0 ? "WAVE_0" : "READY_TO_DISPATCH",
				wave0Files,
				wave0Completed: !hasWave0,
				integrationTestCommand: params.integrationTestCommand,
				waves,
				currentWaveIndex: 0,
				baseLayerId: baseLayer.layerId,
				projectId: engine.getProjectId(),
				tasks: taskRecords,
			};

			autoContinueNudgeCount = 0;
			persistState();
			updateUI(ctx);

			const waveLines = waves.map(
				(w, i) =>
					`- **Wave ${i + 1}**: ${w
						.map((id) => `\`${id}\` (${taskRecords[id].spec.title})`)
						.join(", ")}`,
			);

			const nextInstruction = hasWave0
				? `Next step: You are now in **WAVE_0**. Edit only your declared Wave 0 shared files (${wave0Files.join(", ")}), then call \`orch_wave0_commit\` to snapshot Layer L2 and unlock Wave 1.`
				: `Next step: Call \`orch_dispatch\` to execute Wave 1 (${waves[0].join(", ")}) in parallel across isolated LayerFS workspaces.`;

			return {
				content: [
					{
						type: "text",
						text: [
							`✓ Orchestration Plan Registered (${normalizedTasks.length} tasks, ${waves.length} wave(s))`,
							`- LayerFS Base Layer: \`${baseLayer.layerId}\` (${Object.keys(baseLayer.tree).length} files scanned from the host working tree, including untracked files)`,
							baseLayer.treeRegressionWarning ? `⚠ ${baseLayer.treeRegressionWarning}` : "",
							...waveLines,
							"",
							nextInstruction,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: { plan: activePlan },
			};
		},
	});

	pi.registerTool({
		name: "orch_wave0_commit",
		label: "Orchestrator: Commit Wave 0",
		description:
			"Publish Wave 0 shared interfaces/types/stubs as a new immutable LayerFS Layer and transition to READY_TO_DISPATCH for Wave 1.",
		parameters: Type.Object({
			message: Type.String({ description: "Commit message describing Wave 0 shared interfaces/stubs" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan. Call orch_plan first." }],
					isError: true,
				};
			}
			if (activePlan.phase !== "WAVE_0") {
				return {
					content: [
						{
							type: "text",
							text: `Current phase is ${activePlan.phase}, not WAVE_0. Call orch_dispatch to run the current wave.`,
						},
					],
					isError: true,
				};
			}

			const engine = getEngine(ctx.cwd);
			let newLayer;
			try {
				newLayer = engine.importHostAsLayer(`Wave 0: ${params.message}`, {
					expectedParentLayerId: activePlan.baseLayerId,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `✗ Wave 0 commit refused: ${err instanceof Error ? err.message : String(err)}. Use \`/orch reset\` if the store diverged.`,
						},
					],
					isError: true,
				};
			}
			activePlan.baseLayerId = newLayer.layerId;
			activePlan.wave0Completed = true;
			activePlan.phase = "READY_TO_DISPATCH";

			for (const record of Object.values(activePlan.tasks)) {
				record.state.baseLayerId = newLayer.layerId;
			}

			persistState();
			updateUI(ctx);

			return {
				content: [
					{
						type: "text",
						text: [
							`✓ Wave 0 committed as LayerFS Layer \`${newLayer.layerId}\` (${Object.keys(newLayer.tree).length} files).`,
							newLayer.treeRegressionWarning ? `⚠ ${newLayer.treeRegressionWarning}` : "",
							`Next step: Call \`orch_dispatch\` to run Wave 1 (${activePlan.waves[0].join(", ")}).`,
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "orch_dispatch",
		label: "Orchestrator: Dispatch Wave Subagents",
		description:
			"Dispatch pending or rejected tasks in the current wave to parallel Subagent Workers inside isolated LayerFS workspaces, run Mechanical Verification Gates, and return diffs + unit test results for Lead Agent review.",
		promptSnippet:
			"Dispatch current wave tasks to parallel LayerFS-isolated subagents and run mechanical verification gates",
		parameters: Type.Object({
			taskIds: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Optional subset of task IDs in the current wave to dispatch. Defaults to all pending/rejected/gate_failed tasks in the current wave.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan. Call orch_plan first." }],
					isError: true,
				};
			}
			if (activePlan.phase === "WAVE_0") {
				return {
					content: [
						{
							type: "text",
							text: "Wave 0 is not yet committed. Finish editing wave0Files and call orch_wave0_commit first.",
						},
					],
					isError: true,
				};
			}
			if (activePlan.phase !== "READY_TO_DISPATCH") {
				return {
					content: [
						{
							type: "text",
							text: `Cannot dispatch in phase ${activePlan.phase}. Approve/reject the current wave with \`orch_review\` first, or use \`orch_retry_integration\` / \`orch_rollback_integration\` after a merge.`,
						},
					],
					isError: true,
				};
			}

			const currentWaveIds = activePlan.waves[activePlan.currentWaveIndex] ?? [];
			const targetIds = (params.taskIds?.length ? params.taskIds : currentWaveIds).filter((id) => {
				if (!currentWaveIds.includes(id)) return false;
				const st = activePlan!.tasks[id]?.state.status;
				return st === "pending" || st === "rejected" || st === "gate_failed";
			});

			if (targetIds.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No pending or rejected tasks to dispatch in Wave ${activePlan.currentWaveIndex + 1} (${currentWaveIds.join(", ")}). Check orch_review or orch_integrate.`,
						},
					],
				};
			}

			activePlan.phase = "DISPATCHING";
			updateUI(ctx);

			const engine = getEngine(ctx.cwd);
			const effectiveModel = resolveEffectiveSubagentModel(ctx);
			const effectiveThinking = resolveEffectiveSubagentThinking(ctx);

			const emitProgress = () => {
				updateUI(ctx);
				if (!onUpdate) return;
				const lines = targetIds.map((id) => {
					const rec = activePlan!.tasks[id];
					const lastAct =
						rec.state.recentActivity?.[rec.state.recentActivity.length - 1] || "starting...";
					return `[${id}] (${rec.state.status}, attempt #${rec.state.attempts}, turns=${rec.state.usage.turns}): ${lastAct}`;
				});
				onUpdate({
					content: [
						{
							type: "text",
							text: `Running Wave ${activePlan!.currentWaveIndex + 1} subagents (model=${effectiveModel || "default"}, thinking=${effectiveThinking || "default"}):\n${lines.join("\n")}`,
						},
					],
					details: {
						wave: activePlan!.currentWaveIndex + 1,
						tasks: targetIds.map((id) => activePlan!.tasks[id]),
					},
				});
			};

			await mapWithConcurrencyLimit(targetIds, config.maxConcurrency, async (id) => {
				const record = activePlan!.tasks[id];
				await runWaveTaskSubagent(engine, record, {
					model: effectiveModel,
					thinkingLevel: effectiveThinking,
					maxConcurrency: config.maxConcurrency,
					signal,
					onProgress: emitProgress,
				});
			});

			activePlan.phase = "REVIEWING";
			persistState();
			updateUI(ctx);

			// Build the Lead Agent Review Packet: ONLY diffs, unit tests, and mechanical gate results!
			const packetSections: string[] = [];
			packetSections.push(
				`# Wave ${activePlan.currentWaveIndex + 1} Review Packet (Subagent Model: \`${effectiveModel || "default"}\`, Thinking: \`${effectiveThinking || "default"}\`)`,
			);
			packetSections.push(
				`As Lead Agent, review ONLY the implementation diffs, accompanying unit test diffs, and Mechanical Gate results below, then call \`orch_review\` with your decisions.`,
			);

			for (const id of targetIds) {
				const { spec, state } = activePlan.tasks[id];
				const gate = state.gateReport;
				const diff = state.diff;
				const report = state.workerReport;

				const gateSummary = gate
					? [
							`- **Overall Mechanical Gate**: ${gate.passed ? "✅ PASSED" : "❌ FAILED (Cannot be approved until fixed or escalated)"}`,
							`  - File Scope: ${gate.checks.fileScope.passed ? "✓" : "✗"} ${gate.checks.fileScope.details}`,
							`  - Unit Tests Present: ${gate.checks.unitTestsPresent.passed ? "✓" : "✗"} ${gate.checks.unitTestsPresent.details}`,
							`  - Test Integrity: ${gate.checks.testIntegrity.passed ? "✓" : "✗"} ${gate.checks.testIntegrity.details}`,
							`  - Test Execution (\`${spec.testCommand}\`): ${gate.checks.testExecution.passed ? "✓" : "✗"} ${gate.checks.testExecution.details}`,
							`  - Worker Status: ${gate.checks.workerStatus.passed ? "✓" : "✗"} ${gate.checks.workerStatus.details}`,
						].join("\n")
					: "- Mechanical Gate did not run.";

				const implDiffText = truncateDiffBlock(
					diff?.implUnifiedDiff || "(no implementation file changes)",
					18_000,
				);
				const testDiffText = truncateDiffBlock(
					diff?.testUnifiedDiff || "(no unit test file changes)",
					18_000,
				);

				packetSections.push(
					[
						`---`,
						`## Task \`${id}\`: ${spec.title} (Attempt #${state.attempts}/${config.maxRetries + 1}, LayerFS Branch \`${state.branchName}@${state.headCommitId}\`)`,
						`### 1. Mechanical Gate Checklist`,
						gateSummary,
						"",
						`### 2. Test Runner Output`,
						`- Environment: ${gate?.testCommandResult.environment ?? "(unknown)"}`,
						gate?.testCommandResult.failureLines?.length
							? `- Failure signatures: ${gate.testCommandResult.failureLines.slice(0, 12).join(" | ")}`
							: "",
						`- Cleaned stray root artifacts: ${gate?.testCommandResult.strayArtifacts?.length ? gate.testCommandResult.strayArtifacts.join(", ") : "none"}`,
						"**Head**",
						"```",
						gate?.testCommandResult.outputHead || "(no output)",
						"```",
						"**Tail**",
						"```",
						gate?.testCommandResult.outputTail || "(no output)",
						"```",
						"",
						`### 3. Worker Assumptions, Deviations & Risks`,
						`- **Assumptions**: ${report?.assumptions.length ? report.assumptions.join("; ") : "None"}`,
						`- **Deviations**: ${report?.deviations.length ? report.deviations.join("; ") : "None"}`,
						`- **Risks**: ${report?.risks.length ? report.risks.join("; ") : "None"}`,
						"",
						`### 4. Acceptance Criteria to Verify`,
						...spec.acceptanceCriteria.map((c, i) => `${i + 1}. [ ] ${c}`),
						"",
						`### 5. Accompanying Unit Test Diff (${diff?.files.filter((f) => f.isTestFile).length ?? 0} file(s))`,
						"```diff",
						testDiffText,
						"```",
						"",
						`### 6. Implementation Diff (${diff?.files.filter((f) => !f.isTestFile).length ?? 0} file(s))`,
						"```diff",
						implDiffText,
						"```",
					].join("\n"),
				);
			}

			packetSections.push(
				`\n**Next step**: Call \`orch_review\` with your decision (\`approve\`, \`reject\`, or \`escalate\`) for each task in Wave ${activePlan.currentWaveIndex + 1}.`,
			);

			return {
				content: [{ type: "text", text: packetSections.join("\n\n") }],
				details: {
					wave: activePlan.currentWaveIndex + 1,
					tasks: targetIds.map((id) => activePlan!.tasks[id]),
				},
			};
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as { wave?: number; tasks?: TaskRecord[] } | undefined;
			if (!details?.tasks) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "(done)", 0, 0);
			}
			const container = new Container();
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`Wave ${details.wave} Dispatch & Mechanical Gate Summary`)),
					0,
					0,
				),
			);
			for (const rec of details.tasks) {
				const passed = rec.state.gateReport?.passed;
				const badge = passed
					? theme.fg("success", "✓ GATE PASS")
					: theme.fg("error", "✗ GATE FAIL");
				const filesCount = rec.state.diff?.files.length ?? 0;
				const lineStats = rec.state.diff
					? `+${rec.state.diff.totalLinesAdded}/-${rec.state.diff.totalLinesRemoved}`
					: "+0/-0";
				container.addChild(
					new Text(
						`  ${badge} ${theme.bold(rec.spec.id)} (${rec.spec.title}) — ${filesCount} files (${lineStats}), attempt #${rec.state.attempts}, turns=${rec.state.usage.turns}`,
						0,
						0,
					),
				);
				if (expanded && rec.state.gateReport) {
					for (const chk of Object.values(rec.state.gateReport.checks)) {
						const icon = chk.passed ? theme.fg("success", "✓") : theme.fg("error", "✗");
						container.addChild(
							new Text(`      ${icon} ${chk.name}: ${ theme.fg("muted", chk.details) }`, 0, 0),
						);
					}
				}
			}
			return container;
		},
	});

	pi.registerTool({
		name: "orch_review",
		label: "Orchestrator: Review Wave Tasks",
		description:
			"Submit the Lead Agent's semantic review of each task's implementation diff and unit test diff. Tasks that failed the Mechanical Gate cannot be approved.",
		promptSnippet:
			"Approve, reject (with feedback for retry), or escalate wave tasks after reviewing diffs and unit tests",
		parameters: Type.Object({
			reviews: Type.Array(
				Type.Object({
					taskId: Type.String({ description: "Task ID being reviewed" }),
					decision: StringEnum(["approve", "reject", "escalate"] as const, {
						description:
							"'approve' if implementation & unit tests meet all criteria; 'reject' to send back to the worker on its LayerFS workspace; 'escalate' if maxRetries exceeded and Lead Agent must take over",
					}),
					checklistVerified: Type.Boolean({
						description:
							"True if you verified every acceptance criterion and required unit test case against the diff",
					}),
					feedback: Type.String({
						description:
							"Specific review notes. If rejecting, cite the exact acceptance criterion, missing test case, or bug to fix.",
					}),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan." }],
					isError: true,
				};
			}
			// Re-approving an already merged wave could flip the phase back to
			// READY_TO_INTEGRATE and open the door to a duplicate merge.
			// READY_TO_INTEGRATE is kept available so a task can still be rejected
			// (e.g. after a merge conflict) before any Layer has been published.
			// INTEGRATING / INTEGRATION_FAILED / COMPLETED are blocked: re-approving a
			// merged wave could flip the phase back and allow a duplicate merge.
			if (
				activePlan.phase !== "REVIEWING" &&
				activePlan.phase !== "READY_TO_DISPATCH" &&
				activePlan.phase !== "READY_TO_INTEGRATE"
			) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot review tasks in phase ${activePlan.phase}. Reviews are only accepted while a wave is REVIEWING, READY_TO_DISPATCH or READY_TO_INTEGRATE.`,
						},
					],
					isError: true,
				};
			}

			const currentWaveIds = activePlan.waves[activePlan.currentWaveIndex] ?? [];
			const messages: string[] = [];
			let hasErrors = false;

			for (const rev of params.reviews) {
				const record = activePlan.tasks[rev.taskId];
				if (!record || !currentWaveIds.includes(rev.taskId)) {
					messages.push(`✗ Task "${rev.taskId}" is not in current Wave ${activePlan.currentWaveIndex + 1}.`);
					hasErrors = true;
					continue;
				}

				if (rev.decision === "approve") {
					if (!record.state.gateReport?.passed) {
						messages.push(
							`✗ Cannot approve task "${rev.taskId}": Mechanical Gate FAILED. You must either 'reject' it (so the worker fixes it) or 'escalate' it if retries are exhausted.`,
						);
						hasErrors = true;
						continue;
					}
					if (!rev.checklistVerified) {
						messages.push(
							`✗ Cannot approve task "${rev.taskId}" with checklistVerified=false.`,
						);
						hasErrors = true;
						continue;
					}
					record.state.status = "approved";
					record.state.reviewHistory.push({
						attempt: record.state.attempts,
						decision: "approve",
						feedback: rev.feedback,
						checklistVerified: rev.checklistVerified,
						timestamp: Date.now(),
					});
					messages.push(`✓ Task "${rev.taskId}" APPROVED.`);
				} else if (rev.decision === "reject") {
					record.state.reviewHistory.push({
						attempt: record.state.attempts,
						decision: "reject",
						feedback: rev.feedback,
						checklistVerified: rev.checklistVerified,
						timestamp: Date.now(),
					});
					if (record.state.attempts > config.maxRetries) {
						record.state.status = "escalated";
						messages.push(
							`⚠ Task "${rev.taskId}" reached retry limit (${record.state.attempts} attempts > maxRetries=${config.maxRetries}). Automatically ESCALATED: you may now edit its allowedFiles (${record.spec.allowedFiles.join(", ")}) directly or re-plan.`,
						);
					} else {
						record.state.status = "rejected";
						messages.push(
							`↺ Task "${rev.taskId}" REJECTED (Attempt #${record.state.attempts}/${config.maxRetries + 1}). Call \`orch_dispatch\` to re-run it on its existing LayerFS workspace with your feedback.`,
						);
					}
				} else if (rev.decision === "escalate") {
					record.state.status = "escalated";
					record.state.reviewHistory.push({
						attempt: record.state.attempts,
						decision: "escalate",
						feedback: rev.feedback,
						checklistVerified: rev.checklistVerified,
						timestamp: Date.now(),
					});
					messages.push(
						`⚠ Task "${rev.taskId}" ESCALATED. Direct Lead Agent edits on [${[...record.spec.allowedFiles, ...record.spec.testFiles].join(", ")}] are now unlocked.`,
					);
				}
			}

			const allWaveSettled = currentWaveIds.every((id) => {
				const st = activePlan!.tasks[id].state.status;
				return st === "approved" || st === "escalated";
			});

			const anyRejected = currentWaveIds.some((id) => {
				const st = activePlan!.tasks[id].state.status;
				return st === "rejected" || st === "gate_failed" || st === "pending";
			});

			if (allWaveSettled) {
				activePlan.phase = "READY_TO_INTEGRATE";
				messages.push(
					`\n✓ All tasks in Wave ${activePlan.currentWaveIndex + 1} are ready! Call \`orch_integrate\` to perform the LayerFS 3-way merge, publish the new Layer, and run the integration test suite.`,
				);
			} else if (anyRejected) {
				activePlan.phase = "READY_TO_DISPATCH";
				messages.push(
					`\nNext step: Call \`orch_dispatch\` to re-run the rejected/pending task(s) in Wave ${activePlan.currentWaveIndex + 1}.`,
				);
			}

			persistState();
			updateUI(ctx);

			return {
				content: [{ type: "text", text: messages.join("\n") }],
				isError: hasErrors,
			};
		},
	});

	// =========================================================================
	// Integration state machine (idempotency, crash recovery, retry, rollback)
	// =========================================================================

	/** Reconcile a plan interrupted mid-integration (pure logic in integration-state.ts). */
	function reconcileIntegrationState(engine: LayerFSEngine, ctx: ExtensionContext): void {
		if (!activePlan) return;
		if (reconcileIntegrationRecord(activePlan, engine.getHeadLayerId())) {
			persistState();
			updateUI(ctx);
		}
	}

	/** Scratch dirs for host-side integration tests live in the LayerFS store, not the repo. */
	function integrationScratchRoot(engine: LayerFSEngine): string {
		return path.join(engine.getMetrics().storeRoot, "integration-scratch");
	}

	function markWaveMerged(publishedLayerId: string): void {
		const plan = activePlan!;
		const waveIds = plan.waves[plan.currentWaveIndex] ?? [];
		const before: Record<string, TaskStatus> = {};
		for (const id of waveIds) {
			before[id] = plan.tasks[id].state.status;
			plan.tasks[id].state.status = "merged";
		}
		plan.baseLayerId = publishedLayerId;
		if (plan.integration) plan.integration.taskStatusesBeforeMerge = before;
	}

	function finalizeWaveAfterPassingTests(
		result: CommandResult,
		ctx: ExtensionContext,
		viaRetry: boolean,
	): string {
		const plan = activePlan!;
		const waveIdx = plan.currentWaveIndex;
		const rec = plan.integration!;
		rec.status = "passed";
		rec.updatedAt = Date.now();
		rec.testCommand = result.command;
		rec.testExitCode = result.exitCode;
		rec.testDurationMs = result.durationMs;
		rec.testDiagnostics = undefined;
		rec.lastError = undefined;

		const metrics = getEngine(ctx.cwd).getMetrics();
		const metricsLine = `- LayerFS: ${metrics.layerCount} layers, ${metrics.objectCount} objects, dedup ${metrics.dedupRatio}x`;
		const hostLine = `- Published Layer: \`${rec.publishedLayerId ?? "(none)"}\` | Head: \`${metrics.headLayerId ?? "(none)"}\` | Host <-> Layer: ${rec.hostMatchesLayer === false ? "MISMATCH" : "MATCH"}`;

		if (waveIdx < plan.waves.length - 1) {
			const nextWave = waveIdx + 1;
			plan.currentWaveIndex = nextWave;
			plan.phase = "READY_TO_DISPATCH";
			for (const id of plan.waves[nextWave]) {
				plan.tasks[id].state.baseLayerId = plan.baseLayerId;
			}
			plan.integration = undefined;
			persistState();
			updateUI(ctx);
			return [
				`✓ Integration test \`${result.command}\` passed (${result.durationMs}ms)${viaRetry ? " on retry" : ""}.`,
				hostLine,
				metricsLine,
				"",
				`Wave ${waveIdx + 1} is merged. Next step: call \`orch_dispatch\` for Wave ${nextWave + 1} (${plan.waves[nextWave].join(", ")}).`,
			].join("\n");
		}

		plan.phase = "COMPLETED";
		persistState();
		updateUI(ctx);
		return [
			`🎉 Orchestration COMPLETE — all ${plan.waves.length} wave(s) integrated.`,
			`- Final integration test \`${result.command}\` passed (${result.durationMs}ms)${viaRetry ? " on retry" : ""}.`,
			hostLine,
			metricsLine,
		].join("\n");
	}

	pi.registerTool({
		name: "orch_integrate",
		label: "Orchestrator: Integrate & Merge Wave",
		description:
			"Perform a deterministic LayerFS 3-way merge of all approved branches in the current wave, publish a new immutable Layer to the host directory, and run the integration test command. Idempotent: a wave that already published a Layer cannot be merged again.",
		promptSnippet:
			"Merge approved wave branches via LayerFS 3-way merge, publish to the host workspace, and run integration tests (once per wave)",
		parameters: Type.Object({
			commitMessage: Type.String({
				description: "Summary message for the published LayerFS wave Layer",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan." }],
					isError: true,
				};
			}

			const engine = getEngine(ctx.cwd);
			reconcileIntegrationState(engine, ctx);
			const plan = activePlan!;
			const storeHead = engine.getHeadLayerId();

			// P0: never merge the same wave twice. The LayerFS head has already advanced
			// past the branches' fork base; re-merging would publish a rollback Layer.
			const decision = decideIntegrationAction(plan, storeHead);
			if (decision.action !== "merge") {
				const existing = plan.integration;
				return {
					content: [
						{
							type: "text",
							text: [
								decision.action === "no-op"
									? "⛔ NO merge was performed: this wave is already integrated."
									: "⛔ Integration blocked.",
								`- Reason: ${decision.reason}`,
								`- Published Layer: \`${existing?.publishedLayerId ?? "(none)"}\` | Store head: \`${storeHead}\``,
								`- Last test: \`${existing?.testCommand ?? plan.integrationTestCommand}\` → exit ${existing?.testExitCode ?? "unknown"}`,
								existing?.lastError ? `- Note: ${existing.lastError}` : "",
								"",
								"**Do NOT call `orch_integrate` again**: re-merging stale branches would publish a rollback layer and silently erase host changes.",
								"Next: `orch_retry_integration` (re-run tests ONLY), `orch_rollback_integration` (undo the merge), or `/orch reset` + a new plan for a real code fix.",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					isError: true,
				};
			}

			const waveIdx = plan.currentWaveIndex;
			const currentWaveIds = plan.waves[waveIdx] ?? [];
			const notReady = currentWaveIds.filter((id) => {
				const st = plan.tasks[id].state.status;
				return st !== "approved" && st !== "escalated";
			});
			if (notReady.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot integrate Wave ${waveIdx + 1}: tasks [${notReady.join(", ")}] are not yet approved or escalated.`,
						},
					],
					isError: true,
				};
			}

			const isFinalWave = waveIdx === plan.waves.length - 1;
			if (isFinalWave && config.requireHumanFinalApproval && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Publish Final Wave to Host Workspace?",
					`Merge Wave ${waveIdx + 1} (${currentWaveIds.join(", ")}) and run integration tests?`,
				);
				if (!ok) {
					return {
						content: [{ type: "text", text: "User cancelled final wave integration." }],
						isError: true,
					};
				}
			}

			const parentLayerId = plan.baseLayerId;

			// Persist "running" BEFORE publishing anything: a crash can then be recovered
			// by reconcileIntegrationState instead of allowing a duplicate merge.
			plan.phase = "INTEGRATING";
			plan.integration = {
				status: "running",
				waveIndex: waveIdx,
				startedAt: Date.now(),
				updatedAt: Date.now(),
				attempts: 1,
				parentLayerId,
				testCommand: plan.integrationTestCommand,
			};
			persistState();
			updateUI(ctx);

			const approvedBranches = currentWaveIds
				.filter((id) => plan.tasks[id].state.status === "approved")
				.map((id) => plan.tasks[id].state.branchName);
			const escalatedIds = currentWaveIds.filter(
				(id) => plan.tasks[id].state.status === "escalated",
			);

			let mergeResult;
			try {
				mergeResult = engine.mergeAndPublishWave(approvedBranches, {
					allowAutoThreeWayLineMerge: config.allowAutoThreeWayLineMerge,
					message: `Wave ${waveIdx + 1}: ${params.commitMessage}`,
					expectedBaseLayerId: parentLayerId,
					includeHostEdits: escalatedIds.length > 0,
				});
			} catch (err) {
				plan.phase = "READY_TO_INTEGRATE";
				plan.integration = {
					...plan.integration!,
					status: "merge_failed",
					lastError: err instanceof Error ? err.message : String(err),
					updatedAt: Date.now(),
				};
				persistState();
				updateUI(ctx);
				return {
					content: [
						{
							type: "text",
							text: `✗ LayerFS merge threw an error (no Layer published): ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			if (!mergeResult.ok) {
				plan.phase = "READY_TO_INTEGRATE";
				plan.integration = {
					...plan.integration!,
					status: "merge_failed",
					lastError: mergeResult.error ?? "Unresolved merge conflicts",
					updatedAt: Date.now(),
				};
				persistState();
				updateUI(ctx);
				const conflictText = mergeResult.conflicts
					.map(
						(c) =>
							`- **${c.path}** (touched by branches: ${c.branches.join(", ")}): ${c.reason}${
								c.conflictPreview ? `\n\`\`\`\n${c.conflictPreview}\n\`\`\`` : ""
							}`,
					)
					.join("\n");
				return {
					content: [
						{
							type: "text",
							text: [
								`✗ LayerFS 3-Way Merge Refused (no Layer published, host untouched):`,
								mergeResult.error ? `**Reason**: ${mergeResult.error}` : "",
								conflictText,
								"",
								`All branch workspaces remain intact. Use \`orch_review\` to reject one of the conflicting tasks, or escalate to resolve.`,
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					isError: true,
				};
			}

			const publishedLayerId = mergeResult.publishedLayerId!;
			// Escalated tasks are merged as direct host edits into the SAME wave layer
			// (with a full pre-image snapshot), so no extra, un-snapshotted layer is published.
			let reimportWarning = "";
			if (mergeResult.treeRegressionWarning) {
				reimportWarning = `\n⚠ ${mergeResult.treeRegressionWarning}`;
			}

			// Commit the wave state BEFORE running tests. Even if the test command fails
			// (or the process dies), plan and store remain consistent and no duplicate
			// merge is possible.
			markWaveMerged(publishedLayerId);
			plan.integration = {
				...plan.integration!,
				status: "running",
				publishedLayerId,
				hostMatchesLayer: mergeResult.hostMatchesLayer,
				hostMismatches: mergeResult.hostMismatches,
				hostDrift: mergeResult.hostDrift,
				updatedAt: Date.now(),
			};
			persistState();
			updateUI(ctx);

			const integrationResult = await executeWorkspaceCommand(
				plan.integrationTestCommand,
				ctx.cwd,
				signal,
				180_000,
				{ scratchRoot: integrationScratchRoot(engine) },
			);

			if (integrationResult.exitCode !== 0) {
				plan.integration = {
					...plan.integration!,
					status: "failed",
					updatedAt: Date.now(),
					testCommand: integrationResult.command,
					testExitCode: integrationResult.exitCode,
					testDurationMs: integrationResult.durationMs,
					testDiagnostics: formatCommandDiagnostics(integrationResult),
					lastError: `Integration test exited ${integrationResult.exitCode}`,
				};
				plan.phase = "INTEGRATION_FAILED";
				persistState();
				updateUI(ctx);
				return {
					content: [
						{
							type: "text",
							text: [
								`⚠ Wave ${waveIdx + 1} was MERGED and published as Layer \`${publishedLayerId}\` (host updated); the integration test FAILED with exit ${integrationResult.exitCode}.`,
								`- Host <-> Layer verification: ${mergeResult.hostMatchesLayer ? "MATCH" : `MISMATCH (${(mergeResult.hostMismatches ?? []).slice(0, 5).join(", ")})`}`,
								mergeResult.hostDrift?.length
									? `- ⚠ Pre-existing host drift on untouched paths: ${mergeResult.hostDrift.slice(0, 5).join(", ")}`
									: "",
								`- Rollback snapshot: \`${mergeResult.rollbackSnapshotId ?? "(none)"}\``,
								reimportWarning,
								"",
								formatCommandDiagnostics(integrationResult),
								"",
								"⛔ The plan is now `INTEGRATION_FAILED`. **Never call `orch_integrate` again for this wave.**",
								"Next: `orch_retry_integration` (re-run tests ONLY), `orch_rollback_integration` (undo the merge), or `/orch reset` + a new plan to fix the code.",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text:
							finalizeWaveAfterPassingTests(integrationResult, ctx, false) + reimportWarning,
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "orch_retry_integration",
		label: "Orchestrator: Retry Integration Tests Only",
		description:
			"Re-run the integration test command for a wave whose Layer was already published. NEVER re-merges branches, NEVER publishes another Layer, and NEVER modifies the host tree.",
		promptSnippet:
			"Retry only the integration test command after a failed integration (no merge, no publish)",
		parameters: Type.Object({
			command: Type.Optional(
				Type.String({ description: "Optional override of the integration test command for this retry" }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan." }],
					isError: true,
				};
			}
			const engine = getEngine(ctx.cwd);
			reconcileIntegrationState(engine, ctx);
			const plan = activePlan!;
			const retryDecision = decideRetryIntegrationAction(plan, engine.getHeadLayerId());
			if (!retryDecision.allowed) {
				return {
					content: [
						{
							type: "text",
							text: `⛔ Cannot retry integration: ${retryDecision.reason} Use \`orch_integrate\` first, or \`/orch reset\` for a new plan.`,
						},
					],
					isError: true,
				};
			}
			const rec = plan.integration!;

			const hostCheck = engine.verifyHostMatchesLayer(rec.publishedLayerId);
			const command = params.command?.trim() || plan.integrationTestCommand;
			const result = await executeWorkspaceCommand(command, ctx.cwd, signal, 180_000, {
				scratchRoot: integrationScratchRoot(engine),
			});
			rec.attempts += 1;
			rec.updatedAt = Date.now();
			rec.testCommand = result.command;
			rec.testExitCode = result.exitCode;
			rec.testDurationMs = result.durationMs;
			rec.hostMatchesLayer = hostCheck.matches;
			rec.hostMismatches = hostCheck.matches ? [] : hostCheck.mismatches;
			rec.hostDrift = hostCheck.matches ? [] : hostCheck.mismatches;

			if (result.exitCode !== 0) {
				rec.status = "failed";
				rec.testDiagnostics = formatCommandDiagnostics(result);
				rec.lastError = `Integration test retry #${rec.attempts} exited ${result.exitCode}`;
				plan.phase = "INTEGRATION_FAILED";
				persistState();
				updateUI(ctx);
				return {
					content: [
						{
							type: "text",
							text: [
								`⚠ Integration test retry #${rec.attempts} FAILED (exit ${result.exitCode}). No merge or publish was performed.`,
								`- Published Layer: \`${rec.publishedLayerId}\` (unchanged)`,
								`- Host <-> Layer: ${hostCheck.matches ? "MATCH" : `MISMATCH (${hostCheck.mismatches.slice(0, 5).join(", ")})`}`,
								"",
								formatCommandDiagnostics(result),
								"",
								"Next: `orch_retry_integration` again, `orch_rollback_integration`, or `/orch reset` + a new plan.",
							].join("\n"),
						},
					],
					isError: true,
				};
			}

			rec.testDiagnostics = undefined;
			return {
				content: [
					{ type: "text", text: finalizeWaveAfterPassingTests(result, ctx, true) },
				],
			};
		},
	});

	pi.registerTool({
		name: "orch_rollback_integration",
		label: "Orchestrator: Roll Back Last Published Wave",
		description:
			"Restore the host working tree from the pre-integration snapshot, reset the LayerFS head to the parent Layer, and reopen the wave so it can be re-integrated or re-dispatched.",
		promptSnippet:
			"One-click rollback of the last published wave using the host pre-image snapshot",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!activePlan) {
				return {
					content: [{ type: "text", text: "No active orchestration plan." }],
					isError: true,
				};
			}
			const engine = getEngine(ctx.cwd);
			const plan = activePlan!;
			const rollbackDecision = decideRollbackIntegrationAction(
				plan,
				engine.getHeadLayerId(),
			);
			if (!rollbackDecision.allowed) {
				return {
					content: [
						{
							type: "text",
							text: `⛔ Cannot roll back: ${rollbackDecision.reason} Use \`/orch reset\` if you need a fresh plan.`,
						},
					],
					isError: true,
				};
			}
			const rec = plan.integration!;

			const rollback = engine.rollbackPublishedLayer(rec.publishedLayerId, { targetParentLayerId: rec.parentLayerId });
			if (!rollback.ok || !rollback.restoredLayerId) {
				return {
					content: [{ type: "text", text: `✗ Rollback refused: ${rollback.message}` }],
					isError: true,
				};
			}

			for (const id of plan.waves[rec.waveIndex] ?? []) {
				const previous = rec.taskStatusesBeforeMerge?.[id];
				plan.tasks[id].state.status = previous === "escalated" ? "escalated" : "approved";
			}
			plan.baseLayerId = rollback.restoredLayerId;
			plan.currentWaveIndex = rec.waveIndex;
			plan.phase = "READY_TO_INTEGRATE";
			plan.integration = undefined;
			persistState();
			updateUI(ctx);

			return {
				content: [
					{
						type: "text",
						text: [
							`✓ ${rollback.message}`,
							`- Host <-> Layer after rollback: ${rollback.hostMatchesLayer ? "MATCH" : "MISMATCH"}`,
							`- Wave ${rec.waveIndex + 1} reopened as \`READY_TO_INTEGRATE\`; tasks are approved again.`,
							"",
							"Next: `orch_integrate` to re-merge from the parent Layer, or `orch_review` + `orch_dispatch` to revise the work first.",
						].join("\n"),
					},
				],
			};
		},
	});

	pi.registerTool({
		name: "orch_status",
		label: "Orchestrator: Status & Store Metrics",
		description: "Inspect current Orchestrator configuration, active plan wave progress, and LayerFS deduplication metrics.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const engine = getEngine(ctx.cwd);
			const metrics = engine.getMetrics();
			return {
				content: [
					{
						type: "text",
						text: formatOrchestratorStatusReport(
							config,
							activePlan,
							metrics,
							ctx,
							collectStatusDiagnostics(engine),
						),
					},
				],
			};
		},
	});

	// =========================================================================
	// Hard Enforcement Hooks (Lead Agent)
	// =========================================================================

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config.enabled) return;
		if (event.messageType !== "user") return;

		const effectiveModel = resolveEffectiveSubagentModel(ctx) || "inherit";
		const effectiveThinking = resolveEffectiveSubagentThinking(ctx) || "inherit";

		const planSummary = activePlan
			? `Active Plan: "${activePlan.goal}" | Phase: ${activePlan.phase} | Wave: ${activePlan.currentWaveIndex + 1}/${activePlan.waves.length} | Base Layer: ${activePlan.baseLayerId}` +
				(activePlan.integration
					? ` | Integration: ${activePlan.integration.status} (Layer ${activePlan.integration.publishedLayerId ?? "none"})`
					: "")
			: "No active plan registered yet (Phase: IDLE).";

		return {
			message: {
				customType: "orchestrator-workflow-enforcement",
				content: `[ORCHESTRATOR MODE ACTIVE — STRICT LEAD-SUBAGENT TDD WORKFLOW ENFORCED]
Subagent Model: ${effectiveModel} | Subagent Thinking Level: ${effectiveThinking}
${planSummary}

MANDATORY WORKFLOW RULES (Mechanically Enforced by Tool Gates):
1. DECOMPOSE FIRST: You are the Lead Agent. You CANNOT directly edit or write implementation files. For any coding/modification task, first inspect the codebase with read-only tools, then call \`orch_plan\` to decompose the task into atomic, non-overlapping subtasks with explicit \`allowedFiles\`, \`testFiles\`, \`testCommand\`, \`interfaceContract\`, \`acceptanceCriteria\`, and \`requiredTestCases\`.
2. WAVE 0 (OPTIONAL): If tasks share common types/interfaces/stubs, declare those files in \`wave0Files\` in \`orch_plan\`, edit only those files during \`WAVE_0\`, and commit them with \`orch_wave0_commit\`.
3. PARALLEL LAYERFS DISPATCH: Call \`orch_dispatch\` to run the current wave's tasks in parallel. Each subagent runs in an isolated LayerFS Branch Workspace, writes unit tests + implementation, and undergoes the Mechanical Verification Gate.
4. DIFF & TEST REVIEW ONLY: Do NOT re-read the whole codebase after dispatch. Review ONLY the implementation diff, accompanying unit test diff, and Mechanical Gate report returned by \`orch_dispatch\`, then submit your decisions via \`orch_review\`.
5. MERGE & INTEGRATE (ONCE PER WAVE): Once all tasks in the wave are approved, call \`orch_integrate\` ONCE to perform the LayerFS 3-way merge, publish the new Layer, and run the integration test suite. If the integration test fails, the wave is already merged: NEVER call \`orch_integrate\` again (it would publish a rollback Layer and erase the host changes). Use \`orch_retry_integration\` (tests only), \`orch_rollback_integration\` (undo the merge), or \`/orch reset\` + a new plan.`,
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled) return;

		// Enforce Lead Agent write/edit restrictions
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as Record<string, any>;
			const rawPath = String(input.path || input.file_path || "");
			const relPath = toRelPath(ctx.cwd, rawPath);

			if (!activePlan || activePlan.phase === "COMPLETED") {
				return {
					block: true,
					reason:
						"[Orchestrator Gate] Direct file edits by the Lead Agent are blocked when Orchestrator Mode is ON. First register a task breakdown with `orch_plan`, then dispatch Subagent Workers via `orch_dispatch`.",
				};
			}

			if (activePlan.phase === "WAVE_0") {
				if (matchesAnyPattern(relPath, activePlan.wave0Files)) {
					return;
				}
				return {
					block: true,
					reason: `[Orchestrator Gate] During WAVE_0, the Lead Agent may only edit declared wave0Files (${activePlan.wave0Files.join(", ")}). File "${relPath}" is not in wave0Files.`,
				};
			}

			// Allow direct edit ONLY if the file belongs to an ESCALATED task in the current wave
			const currentWaveIds = activePlan.waves[activePlan.currentWaveIndex] ?? [];
			const escalatedTask = currentWaveIds
				.map((id) => activePlan!.tasks[id])
				.find(
					(rec) =>
						rec.state.status === "escalated" &&
						matchesAnyPattern(relPath, [...rec.spec.allowedFiles, ...rec.spec.testFiles]),
				);

			if (escalatedTask) {
				return;
			}

			return {
				block: true,
				reason: `[Orchestrator Gate] Direct Lead Agent modification of "${relPath}" is blocked in phase ${activePlan.phase}. Subagent Workers must implement tasks and unit tests via \`orch_dispatch\`. (Direct Lead edits are only permitted during WAVE_0 on wave0Files, or on tasks marked 'escalated' via \`orch_review\`).`,
			};
		}
	});

	// Prevent Lead Agent from stopping mid-plan when waves remain unfinished
	pi.on("agent_before_settle", async (_event, _ctx) => {
		if (!config.enabled || !activePlan) return;
		if (activePlan.phase === "COMPLETED") {
			autoContinueNudgeCount = 0;
			return;
		}
		if (autoContinueNudgeCount >= 3) {
			return;
		}
		autoContinueNudgeCount += 1;

		let nextActionHint = "";
		switch (activePlan.phase) {
			case "WAVE_0":
				nextActionHint =
					"Finish editing wave0Files and call `orch_wave0_commit`, or call `orch_dispatch` if ready.";
				break;
			case "READY_TO_DISPATCH":
				nextActionHint = `Call \`orch_dispatch\` to execute Wave ${activePlan.currentWaveIndex + 1}.`;
				break;
			case "REVIEWING":
				nextActionHint = `Call \`orch_review\` to approve, reject, or escalate the completed tasks in Wave ${activePlan.currentWaveIndex + 1}.`;
				break;
			case "READY_TO_INTEGRATE":
				nextActionHint = `Call \`orch_integrate\` ONCE to merge Wave ${activePlan.currentWaveIndex + 1} and run the integration test suite.`;
				break;
			case "INTEGRATING":
				nextActionHint = `Integration for Wave ${activePlan.currentWaveIndex + 1} is still in progress; wait for the result.`;
				break;
			case "INTEGRATION_FAILED":
				nextActionHint = `Wave ${activePlan.currentWaveIndex + 1} is already merged but its integration test failed. Do NOT call \`orch_integrate\` again. Use \`orch_retry_integration\` to re-run tests, \`orch_rollback_integration\` to undo the merge, or \`/orch reset\` + a new plan.`;
				break;
			default:
				return;
		}

		return {
			entries: [
				{
					type: "custom_message",
					customType: "orchestrator-continuation",
					content: `[Orchestrator Workflow Reminder] Plan "${activePlan.goal}" is currently in phase ${activePlan.phase} (Wave ${activePlan.currentWaveIndex + 1}/${activePlan.waves.length}). Do not stop until all waves are integrated. Next required action: ${nextActionHint}`,
					display: false,
				},
			],
			continue: true,
		};
	});

	// =========================================================================
	// Interactive Commands & Shortcuts (/orch and Ctrl+Alt+O)
	// =========================================================================

	pi.registerShortcut("ctrl+alt+o", {
		description: "Toggle Orchestrator Mode ON/OFF",
		handler: async (ctx) => {
			config.enabled = !config.enabled;
			if (!config.enabled) {
				activePlan = null;
			}
			persistState();
			updateUI(ctx);
			ctx.ui.notify(
				config.enabled
					? `⚡ Orchestrator Mode ENABLED (subagent model: ${config.subagentModel || "inherit"}, thinking: ${config.subagentThinkingLevel || "inherit"})`
					: "Orchestrator Mode DISABLED",
				"info",
			);
		},
	});

	pi.registerCommand("orch", {
		description:
			"Configure or toggle the Lead-Subagent TDD Orchestrator (/orch [on|off|toggle|model|thinking|status|reset])",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] || "").toLowerCase();

			if (sub === "on" || sub === "enable") {
				config.enabled = true;
				persistState();
				updateUI(ctx);
				ctx.ui.notify(
					`⚡ Orchestrator Mode ENABLED (subagent model: ${config.subagentModel || "inherit"}, thinking: ${config.subagentThinkingLevel || "inherit"})`,
					"info",
				);
				return;
			}

			if (sub === "off" || sub === "disable") {
				config.enabled = false;
				activePlan = null;
				persistState();
				updateUI(ctx);
				ctx.ui.notify("Orchestrator Mode DISABLED", "info");
				return;
			}

			if (sub === "toggle") {
				config.enabled = !config.enabled;
				if (!config.enabled) activePlan = null;
				persistState();
				updateUI(ctx);
				ctx.ui.notify(
					`Orchestrator Mode ${config.enabled ? "ENABLED" : "DISABLED"}`,
					"info",
				);
				return;
			}

			if (sub === "model") {
				const argModel = parts[1];
				if (argModel) {
					config.subagentModel =
						argModel === "inherit" || argModel === "default" ? undefined : argModel;
					persistState();
					updateUI(ctx);
					ctx.ui.notify(
						`Subagent model set to: ${config.subagentModel || "(inherit lead model)"}`,
						"info",
					);
					return;
				}
				await promptModelSelection(ctx);
				return;
			}

			if (sub === "thinking" || sub === "think") {
				const argThink = parts[1]?.toLowerCase();
				if (argThink) {
					if (argThink === "inherit" || argThink === "default") {
						config.subagentThinkingLevel = undefined;
					} else if (THINKING_LEVELS.includes(argThink as ThinkingLevel)) {
						config.subagentThinkingLevel = argThink as ThinkingLevel;
					} else {
						ctx.ui.notify(
							`Invalid thinking level "${argThink}". Choose from: ${THINKING_LEVELS.join(", ")}, or inherit`,
							"warning",
						);
						return;
					}
					persistState();
					updateUI(ctx);
					ctx.ui.notify(
						`Subagent thinking level set to: ${config.subagentThinkingLevel || "(inherit lead thinking)"}`,
						"info",
					);
					return;
				}
				await promptThinkingSelection(ctx);
				return;
			}

			if (sub === "reset" || sub === "clear") {
				activePlan = null;
				autoContinueNudgeCount = 0;
				persistState();
				updateUI(ctx);
				ctx.ui.notify("Active orchestration plan reset.", "info");
				return;
			}

			if (sub === "status") {
				const engine = getEngine(ctx.cwd);
				const report = formatOrchestratorStatusReport(
					config,
					activePlan,
					engine.getMetrics(),
					ctx,
					collectStatusDiagnostics(engine),
				);
				ctx.ui.notify(report, "info");
				return;
			}

			// Interactive Menu when `/orch` is called without arguments
			await openInteractiveOrchMenu(ctx);
		},
	});

	async function promptModelSelection(ctx: ExtensionContext): Promise<void> {
		const options: string[] = ["(inherit lead model)"];
		const seen = new Set<string>();

		// Prefer scoped models if configured, then all available models from modelRegistry
		if (ctx.scopedModels && ctx.scopedModels.length > 0) {
			for (const entry of ctx.scopedModels) {
				const id = `${entry.model.provider}/${entry.model.id}`;
				if (!seen.has(id)) {
					seen.add(id);
					options.push(id);
				}
			}
		}

		try {
			const available = ctx.modelRegistry.getAvailable();
			for (const m of available) {
				const id = `${m.provider}/${m.id}`;
				if (!seen.has(id)) {
					seen.add(id);
					options.push(id);
				}
			}
		} catch {
			// Ignore if modelRegistry is unavailable
		}

		options.push("(enter custom provider/modelId...)");

		const choice = await ctx.ui.select(
			`Select Subagent Model (current: ${config.subagentModel || "inherit"})`,
			options,
		);
		if (!choice) return;

		if (choice === "(inherit lead model)") {
			config.subagentModel = undefined;
		} else if (choice === "(enter custom provider/modelId...)") {
			const custom = await ctx.ui.input(
				"Enter Subagent Model (provider/modelId)",
				config.subagentModel || "",
			);
			if (custom !== undefined) {
				config.subagentModel = custom.trim() || undefined;
			}
		} else {
			config.subagentModel = choice;
		}

		persistState();
		updateUI(ctx);
		ctx.ui.notify(
			`Subagent model set to: ${config.subagentModel || "(inherit lead model)"}`,
			"info",
		);
	}

	async function promptThinkingSelection(ctx: ExtensionContext): Promise<void> {
		const options = [
			"(inherit lead thinking)",
			...THINKING_LEVELS.map((lvl) =>
				lvl === config.subagentThinkingLevel ? `${lvl} (current)` : lvl,
			),
		];

		const choice = await ctx.ui.select(
			`Select Subagent Thinking Level (current: ${config.subagentThinkingLevel || "inherit"})`,
			options,
		);
		if (!choice) return;

		if (choice === "(inherit lead thinking)") {
			config.subagentThinkingLevel = undefined;
		} else {
			const clean = choice.replace(" (current)", "").trim() as ThinkingLevel;
			config.subagentThinkingLevel = clean;
		}

		persistState();
		updateUI(ctx);
		ctx.ui.notify(
			`Subagent thinking level set to: ${config.subagentThinkingLevel || "(inherit lead thinking)"}`,
			"info",
		);
	}

	async function openInteractiveOrchMenu(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;

		const menuItems = [
			`1. Toggle Orchestrator Workflow [Currently: ${config.enabled ? "ON ⚡" : "OFF"}]`,
			`2. Subagent Model [Currently: ${config.subagentModel || "(inherit lead model)"}]`,
			`3. Subagent Thinking Level [Currently: ${config.subagentThinkingLevel || "(inherit lead thinking)"}]`,
			`4. Max Parallel Subagents [Currently: ${config.maxConcurrency}]`,
			`5. Max Retries per Task [Currently: ${config.maxRetries}]`,
			`6. Confirm Plan Before Dispatch [Currently: ${config.requireHumanPlanApproval ? "ON" : "OFF"}]`,
			`7. Confirm Before Final Integration [Currently: ${config.requireHumanFinalApproval ? "ON" : "OFF"}]`,
			`8. Show Status & LayerFS Store Metrics`,
			`9. Reset Active Orchestration Plan`,
		];

		const selected = await ctx.ui.select("⚡ Pi Orchestrator Settings", menuItems);
		if (!selected) return;

		if (selected.startsWith("1.")) {
			config.enabled = !config.enabled;
			if (!config.enabled) activePlan = null;
			persistState();
			updateUI(ctx);
			ctx.ui.notify(
				`Orchestrator Workflow ${config.enabled ? "ENABLED ⚡" : "DISABLED"}`,
				"info",
			);
		} else if (selected.startsWith("2.")) {
			await promptModelSelection(ctx);
		} else if (selected.startsWith("3.")) {
			await promptThinkingSelection(ctx);
		} else if (selected.startsWith("4.")) {
			const val = await ctx.ui.input(
				"Max Parallel Subagents (1-8)",
				String(config.maxConcurrency),
			);
			if (val) {
				const num = Number.parseInt(val, 10);
				if (num >= 1 && num <= 8) {
					config.maxConcurrency = num;
					persistState();
					ctx.ui.notify(`Max parallel subagents set to ${num}`, "info");
				}
			}
		} else if (selected.startsWith("5.")) {
			const val = await ctx.ui.input(
				"Max Retries per Task before Escalation (0-5)",
				String(config.maxRetries),
			);
			if (val !== undefined) {
				const num = Number.parseInt(val, 10);
				if (num >= 0 && num <= 5) {
					config.maxRetries = num;
					persistState();
					ctx.ui.notify(`Max retries per task set to ${num}`, "info");
				}
			}
		} else if (selected.startsWith("6.")) {
			config.requireHumanPlanApproval = !config.requireHumanPlanApproval;
			persistState();
			ctx.ui.notify(
				`Confirm Plan Before Dispatch: ${config.requireHumanPlanApproval ? "ON" : "OFF"}`,
				"info",
			);
		} else if (selected.startsWith("7.")) {
			config.requireHumanFinalApproval = !config.requireHumanFinalApproval;
			persistState();
			ctx.ui.notify(
				`Confirm Before Final Integration: ${config.requireHumanFinalApproval ? "ON" : "OFF"}`,
				"info",
			);
		} else if (selected.startsWith("8.")) {
			const engine = getEngine(ctx.cwd);
			const report = formatOrchestratorStatusReport(
				config,
				activePlan,
				engine.getMetrics(),
				ctx,
				collectStatusDiagnostics(engine),
			);
			ctx.ui.notify(report, "info");
		} else if (selected.startsWith("9.")) {
			activePlan = null;
			autoContinueNudgeCount = 0;
			persistState();
			updateUI(ctx);
			ctx.ui.notify("Active orchestration plan reset.", "info");
		}
	}

	// =========================================================================
	// Session Lifecycle Restoration
	// =========================================================================

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();

		if (pi.getFlag("orch") === true) {
			config.enabled = true;
		}
		const flagModel = pi.getFlag("orch-model");
		if (typeof flagModel === "string" && flagModel.trim()) {
			config.subagentModel = flagModel.trim();
		}
		const flagThinking = pi.getFlag("orch-thinking");
		if (
			typeof flagThinking === "string" &&
			THINKING_LEVELS.includes(flagThinking.trim() as ThinkingLevel)
		) {
			config.subagentThinkingLevel = flagThinking.trim() as ThinkingLevel;
		}

		// Restore activePlan from session entries if resuming a session
		const entries = ctx.sessionManager.getEntries();
		const lastEntry = entries
			.filter((e: any) => e.type === "custom" && e.customType === "orchestrator-state")
			.pop() as { data?: { config?: OrchestratorConfig; activePlan?: OrchestrationPlan | null } } | undefined;

		if (lastEntry?.data?.activePlan) {
			activePlan = lastEntry.data.activePlan;
		}

		saveConfig(config);
		updateUI(ctx);
	});
}

function truncateDiffBlock(diff: string, maxChars: number): string {
	if (diff.length <= maxChars) return diff;
	return `${diff.slice(0, maxChars)}\n... [Diff truncated at ${maxChars} chars]`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

interface StatusReportDiagnostics {
	hostVerification?: {
		matches: boolean;
		mismatches: string[];
		checked: number;
		layerId: string;
	};
	headFileCount?: number;
	parentFileCount?: number;
	treeRegression?: boolean;
}

function formatOrchestratorStatusReport(
	config: OrchestratorConfig,
	plan: OrchestrationPlan | null,
	metrics: ReturnType<LayerFSEngine["getMetrics"]>,
	ctx: ExtensionContext,
	diag?: StatusReportDiagnostics,
): string {
	const leadModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
	const lines: string[] = [
		`⚡ Pi Orchestrator Status`,
		`- Workflow Switch: ${config.enabled ? "ENABLED (Strict Enforcement)" : "DISABLED"}`,
		`- Lead Agent Model: ${leadModel} (thinking: ${ctx.thinkingLevel || "default"})`,
		`- Subagent Model: ${config.subagentModel || `(inherit: ${leadModel})`}`,
		`- Subagent Thinking: ${config.subagentThinkingLevel || `(inherit: ${ctx.thinkingLevel || "default"})`}`,
		`- Concurrency: ${config.maxConcurrency} | Max Retries: ${config.maxRetries}`,
		`- LayerFS Store: ${metrics.storeRoot}`,
		`  Layers: ${metrics.layerCount} | Branches: ${metrics.branchCount} | Commits: ${metrics.commitCount} | Objects: ${metrics.objectCount}`,
		`  Logical: ${formatBytes(metrics.logicalBytes)} | Stored: ${formatBytes(metrics.storedBytes)} | Dedup: ${metrics.dedupRatio}x (${formatBytes(metrics.savedBytes)} saved)`,
	];

	if (diag) {
		lines.push(
			`- Last Published / Head Layer: \`${metrics.headLayerId || "(none)"}\` (${diag.headFileCount ?? 0} files)`,
		);
		if (diag.parentFileCount !== undefined) {
			lines.push(
				`  Parent Layer: ${diag.parentFileCount} files` +
					(diag.treeRegression
						? "  ⚠ TREE REGRESSION: head layer has FEWER files than its parent (possible rollback / lost changes)"
						: ""),
			);
		}
		if (diag.hostVerification) {
			const hv = diag.hostVerification;
			lines.push(
				`  Host <-> Layer: ${hv.matches ? "MATCH" : `MISMATCH (${hv.mismatches.slice(0, 5).join(", ")})`} (${hv.checked} files checked)`,
			);
		}
	}

	if (!plan) {
		lines.push(`- Active Plan: None`);
	} else {
		lines.push(
			`- Active Plan: "${plan.goal}" (Phase: ${plan.phase}, Wave ${plan.currentWaveIndex + 1}/${plan.waves.length}, Base Layer: ${plan.baseLayerId})`,
		);
		for (let i = 0; i < plan.waves.length; i++) {
			const taskSummaries = plan.waves[i].map((id) => {
				const rec = plan.tasks[id];
				return `${id}[${rec.state.status}, tries=${rec.state.attempts}]`;
			});
			lines.push(`  Wave ${i + 1}: ${taskSummaries.join(", ")}`);
		}
		if (plan.integration) {
			const it = plan.integration;
			lines.push(
				`- Integration: ${it.status} (Wave ${it.waveIndex + 1}) | Layer \`${it.publishedLayerId ?? "(none)"}\` | test exit ${it.testExitCode ?? "unknown"} | attempts ${it.attempts}`,
			);
			if (it.lastError) lines.push(`  Last error: ${it.lastError}`);
			if (it.testCommand) lines.push(`  Last test command: \`${it.testCommand}\``);
			if (!it.hostMatchesLayer && it.hostMismatches?.length) {
				lines.push(`  ⚠ Host <-> Layer mismatch on merged paths: ${it.hostMismatches.slice(0, 5).join(", ")}`);
			}
			if (it.hostDrift?.length) {
				lines.push(`  ⚠ Host <-> Layer drift on untouched paths: ${it.hostDrift.slice(0, 5).join(", ")}`);
			}
		}
	}

	return lines.join("\n");
}
