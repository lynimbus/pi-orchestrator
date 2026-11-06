import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type OrchestratorPhase =
	| "IDLE"
	| "PLANNING"
	| "WAVE_0"
	| "READY_TO_DISPATCH"
	| "DISPATCHING"
	| "REVIEWING"
	| "READY_TO_INTEGRATE"
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
	publishedLayerId?: string;
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
}
