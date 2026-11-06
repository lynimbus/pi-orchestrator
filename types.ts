import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type OrchestratorPhase =
	| "IDLE"
	| "PLANNING"
	| "WAVE_0"
	| "READY_TO_DISPATCH"
	| "DISPATCHING"
	| "REVIEWING"
	| "READY_TO_INTEGRATE"
	| "INTEGRATING"
	| "INTEGRATION_FAILED"
	| "COMPLETED";

export type TaskStatus =
	| "pending"
	| "running"
	| "gate_failed"
	| "awaiting_review"
	| "approved"
	| "rejected"
	| "escalated"
	| "merged";

export interface OrchestratorConfig {
	/** Master switch: when true, the lead-subagent TDD workflow is strictly enforced */
	enabled: boolean;
	/** Subagent model in "provider/modelId" format, or undefined to inherit lead agent's model */
	subagentModel?: string;
	/** Subagent thinking level, or undefined to inherit lead agent's thinking level */
	subagentThinkingLevel?: ThinkingLevel;
	/** Maximum parallel subagents per wave */
	maxConcurrency: number;
	/** Maximum automatic retry rounds per task before escalation */
	maxRetries: number;
	/** Ask user for confirmation when orch_plan registers a new plan (interactive UI mode) */
	requireHumanPlanApproval: boolean;
	/** Ask user for confirmation before final wave integration (interactive UI mode) */
	requireHumanFinalApproval: boolean;
	/** Allow 3-way non-overlapping line merge when two tasks touch different regions of the same file */
	allowAutoThreeWayLineMerge: boolean;
}

export interface RequiredTestCase {
	input: string;
	expected: string;
}

export interface TaskSpec {
	id: string;
	title: string;
	description: string;
	dependsOn: string[];
	/** Relative file paths or globs allowed to be created/modified (implementation + tests) */
	allowedFiles: string[];
	/** Specific test file paths or globs that MUST be created/updated */
	testFiles: string[];
	/** Shell command to execute the unit tests for this task */
	testCommand: string;
	/** Exact function/type signatures and error semantics agreed before dispatch */
	interfaceContract: string;
	/** Bullet list of acceptance criteria */
	acceptanceCriteria: string[];
	/** Mandatory test cases defined by the lead agent (worker may add more, never remove) */
	requiredTestCases: RequiredTestCase[];
	/** Optional explicit forbidden paths or patterns */
	doNotTouch?: string[];
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface FileChangeEntry {
	path: string;
	changeType: "added" | "modified" | "deleted";
	baseObjectId?: string;
	headObjectId?: string;
	isTestFile: boolean;
	linesAdded: number;
	linesRemoved: number;
	unifiedDiff: string;
}

export interface BranchDiffResult {
	branchName: string;
	baseLayerId: string;
	headCommitId: string;
	files: FileChangeEntry[];
	implUnifiedDiff: string;
	testUnifiedDiff: string;
	fullUnifiedDiff: string;
	totalLinesAdded: number;
	totalLinesRemoved: number;
}

export interface MechanicalGateCheck {
	name: string;
	passed: boolean;
	details: string;
}

export interface MechanicalGateReport {
	passed: boolean;
	checks: {
		fileScope: MechanicalGateCheck;
		unitTestsPresent: MechanicalGateCheck;
		testIntegrity: MechanicalGateCheck;
		testExecution: MechanicalGateCheck;
		workerStatus: MechanicalGateCheck;
	};
	testCommandResult: {
		command: string;
		exitCode: number;
		durationMs: number;
		outputTail: string;
		/** First lines of the command output (never truncated away by the rolling tail buffer) */
		outputHead?: string;
		/** Lines matching known failure signatures, extracted from the whole output */
		failureLines?: string[];
		/** Human-readable environment summary, e.g. TMPDIR / XDG_CACHE_HOME / cwd */
		environment?: string;
		/** Files created in the workspace root by the test command and cleaned up afterwards */
		strayArtifacts?: string[];
	};
	outOfScopeFiles: string[];
	touchedTestFiles: string[];
	touchedImplFiles: string[];
	tamperingWarnings: string[];
}

export interface WorkerStructuredReport {
	status: "DONE" | "BLOCKED" | "PARTIAL" | "UNKNOWN";
	summary: string;
	addedTests: string[];
	assumptions: string[];
	deviations: string[];
	risks: string[];
	rawOutput: string;
}

export interface ReviewEntry {
	attempt: number;
	decision: "approve" | "reject" | "escalate";
	feedback: string;
	checklistVerified: boolean;
	timestamp: number;
}

export interface TaskRuntimeState {
	id: string;
	wave: number;
	status: TaskStatus;
	attempts: number;
	branchName: string;
	workspacePath?: string;
	baseLayerId?: string;
	headCommitId?: string;
	diff?: BranchDiffResult;
	gateReport?: MechanicalGateReport;
	workerReport?: WorkerStructuredReport;
	reviewHistory: ReviewEntry[];
	usage: UsageStats;
	modelUsed?: string;
	thinkingUsed?: string;
	lastError?: string;
	recentActivity?: string[];
}

export interface TaskRecord {
	spec: TaskSpec;
	state: TaskRuntimeState;
}

/**
 * Durable record of a wave integration attempt.
 *
 * This is the single source of truth used to make `orch_integrate` idempotent:
 * once a wave has published a Layer, a second `orch_integrate` must never merge
 * the same (now stale) branches again.
 */
export interface IntegrationRecord {
	status: "running" | "merge_failed" | "failed" | "passed";
	waveIndex: number;
	startedAt: number;
	updatedAt: number;
	attempts: number;
	/** Set as soon as the LayerFS merge publishes a layer (even if tests later fail) */
	publishedLayerId?: string;
	/** Parent of the published layer; used by `orch_rollback_integration` */
	parentLayerId?: string;
	hostMatchesLayer?: boolean;
	hostMismatches?: string[];
	/** Non-fatal drift on layer paths not touched by this wave */
	hostDrift?: string[];
	testCommand?: string;
	testExitCode?: number;
	testDurationMs?: number;
	testDiagnostics?: string;
	lastError?: string;
	/** Task statuses before `markWaveMerged`, used by `orch_rollback_integration` */
	taskStatusesBeforeMerge?: Record<string, TaskStatus>;
}

export interface OrchestrationPlan {
	planId: string;
	goal: string;
	createdAt: number;
	phase: OrchestratorPhase;
	wave0Files: string[];
	wave0Completed: boolean;
	integrationTestCommand: string;
	waves: string[][];
	currentWaveIndex: number;
	baseLayerId: string;
	projectId: string;
	tasks: Record<string, TaskRecord>;
	/** Integration state of the current wave (undefined until the first integrate call) */
	integration?: IntegrationRecord;
}

export interface MergeConflictItem {
	path: string;
	branches: string[];
	reason: string;
	baseObjectId?: string;
	branchObjectIds: Record<string, string | undefined>;
	conflictPreview?: string;
}

export interface WaveMergeResult {
	ok: boolean;
	/** Machine-readable refusal reason (stale branch, unexplained deletion, ...) */
	error?: string;
	publishedLayerId?: string;
	/** Layer the branches were forked from / that the merge was applied on top of */
	baseLayerId?: string;
	/** Result of the strict host <-> published layer check on the applied delta */
	hostMatchesLayer?: boolean;
	hostMismatches?: string[];
	/** Non-fatal drift on layer paths that this wave did not touch (reported only) */
	hostDrift?: string[];
	/** Id of the host pre-image snapshot usable by `rollbackPublishedLayer` */
	rollbackSnapshotId?: string;
	/** Set when the published wave layer loses files relative to its parent layer */
	treeRegressionWarning?: string;
	mergedFiles: Array<{
		path: string;
		changeType: "added" | "modified" | "deleted";
		fromBranches: string[];
		autoMergedLines?: boolean;
	}>;
	conflicts: MergeConflictItem[];
	storeMetrics: StoreMetrics;
}

export interface StoreMetrics {
	storeRoot: string;
	layerCount: number;
	branchCount: number;
	commitCount: number;
	objectCount: number;
	logicalBytes: number;
	storedBytes: number;
	savedBytes: number;
	dedupRatio: number;
	headLayerId?: string;
}
