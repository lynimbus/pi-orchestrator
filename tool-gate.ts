/**
 * The orchestrator tool-availability gate.
 *
 * Owns the decisions that keep the eight `orch_*` tools out of reach while orchestrator
 * mode is OFF. The bug it exists for: pi activated the registered tools unconditionally,
 * so a session with `"enabled": false` still declared every orch tool (and the leaked
 * "Orchestrator Mode is active" prompt guidelines) and pi executed `orch_status` when the
 * model called it.
 *
 * Two consumers, one source of truth:
 * - `orchestratorToolGate` for the authoritative `tool_call` check, which also covers
 *   `ctx.executeTool()` and codemode calls that declaration-hiding cannot reach;
 * - `declaredToolsForRun` for `before_agent_start`, pruning `selectedTools` so the tools
 *   and their prompt guidelines are never declared for a disabled run.
 *
 * Pure and dependency-free: no imports at all, so `node ./test-tool-gate.ts` loads it.
 */

export const ORCHESTRATOR_TOOL_NAMES: readonly string[] = [
	"orch_plan",
	"orch_wave0_commit",
	"orch_dispatch",
	"orch_review",
	"orch_integrate",
	"orch_retry_integration",
	"orch_rollback_integration",
	"orch_status",
];

const ORCHESTRATOR_TOOL_NAME_SET: ReadonlySet<string> = new Set(ORCHESTRATOR_TOOL_NAMES);

export function isOrchestratorTool(name: unknown): boolean {
	return typeof name === "string" && ORCHESTRATOR_TOOL_NAME_SET.has(name);
}

export interface OrchestratorToolBlock {
	block: true;
	reason: string;
}

export function orchestratorToolGate(
	toolName: unknown,
	enabled: boolean,
): OrchestratorToolBlock | undefined {
	if (enabled || !isOrchestratorTool(toolName)) return undefined;

	return {
		block: true,
		reason: `Orchestrator mode is OFF for this session, so ${String(toolName)} is not available. Run /orch on to enable the Lead-Subagent workflow.`,
	};
}

export function declaredToolsForRun(selectedTools: readonly string[], enabled: boolean): string[] {
	if (enabled) return [...selectedTools];

	return selectedTools.filter((name) => !isOrchestratorTool(name));
}
