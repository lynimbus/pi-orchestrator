/**
 * Granted-skill name resolution (pure).
 *
 * Stigmergy contract: subagent workers pick up skills from the shared environment on
 * their own. A spawned worker inherits the agent-dir skills and discovers project
 * skills inside its LayerFS workspace, so no pre-negotiation is needed. The lists
 * handled here only exist for what discovery cannot surface: skills marked
 * `disable-model-invocation: true` (invisible to the worker's own model) and skills
 * the lead wants granted up front. Resolution turns a configured entry into candidate
 * paths; the wiring layer (index.ts) picks the first candidate that exists and hands
 * it to the worker as one `pi --skill <path>` pair.
 *
 * Pure and dependency-free. No imports at all, same contract as tool-gate.ts, so
 * `node ./test-primitives.ts` loads it directly. Candidate paths are built with
 * forward slashes, which every supported fs.existsSync accepts.
 */

/**
 * Splits a comma/space separated list into trimmed, de-duplicated, non-empty entries.
 * The single parser behind /orch skills, --orch-skills and orchestrator.json arrays.
 */
export function parseSkillList(input: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of input.split(/[,\s]+/)) {
		const entry = raw.trim();
		if (!entry || seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

/** True when the entry is meant as a file path rather than a bare skill name. */
export function isPathLikeSkillEntry(entry: string): boolean {
	return entry.includes("/") || entry.includes("\\") || entry.endsWith(".md");
}

/** Forward-slash join for candidate paths; trailing separators on the root are trimmed. */
function joinSkillPath(root: string, name: string): string {
	const trimmedRoot = root.replace(/[\/]+$/, "");
	return trimmedRoot ? `${trimmedRoot}/${name}` : `/${name}`;
}

/**
 * Candidate paths for one configured skill entry, in priority order. A path-like
 * entry is used verbatim (the caller resolves it against the lead's cwd); a bare
 * name is probed as `<root>/<name>/SKILL.md` then `<root>/<name>` under each root
 * in order. Pure. Existence is the caller's concern.
 */
export function skillPathCandidates(entry: string, roots: readonly string[]): string[] {
	const trimmed = entry.trim();
	if (!trimmed) return [];
	if (isPathLikeSkillEntry(trimmed)) return [trimmed];
	const out: string[] = [];
	for (const root of roots) {
		out.push(joinSkillPath(joinSkillPath(root, trimmed), "SKILL.md"), joinSkillPath(root, trimmed));
	}
	return out;
}

/**
 * Union of the global grant list and one task's extra grant list: trimmed,
 * de-duplicated, first-seen order (global entries first). Pure merge. Resolution
 * happens later, at dispatch time, so a skill installed after planning still works.
 */
export function mergeSkillLists(
	base: readonly string[] | undefined,
	extra: readonly string[] | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of [...(base ?? []), ...(extra ?? [])]) {
		const trimmed = entry.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}
