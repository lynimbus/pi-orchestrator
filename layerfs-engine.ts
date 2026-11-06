/**
 * LayerFS-Architecture Workspace & Branch Engine for Pi Orchestrator
 *
 * Implements the core LayerFS model (https://github.com/Ephemeral-AI-Lab/layerfs):
 * - Durable LayerStackStore:
 *   - LayerStacks: linear sequences of immutable published Layers (L0, L1, ...)
 *   - Branches: named writable lines forked from a base Layer in O(1) without copying trees
 *   - Commits: immutable Branch snapshots committed via Compare-And-Swap (CAS) on the Branch head
 *   - Canonical Objects: globally deduplicated by authenticated SHA-256 ObjectId
 * - Ephemeral Workspaces:
 *   - Projected writable view of a single Branch head
 *   - Private `.tmp/` and `.cache/` scratch directories (bound to TMPDIR and XDG_CACHE_HOME)
 *     that are never captured in Commits or published Layers
 *   - O(1) shared read-only dependency symlinks (`node_modules`, `.venv`, `target`, etc.)
 *   - Secret & VCS internal filtering (`.git`, `.jj`, `.env*` secrets, private keys)
 * - Deterministic 3-Way Tree & Line Merge across parallel wave Branches with structured conflict reporting
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BranchDiffResult,
	FileChangeEntry,
	MergeConflictItem,
	StoreMetrics,
	WaveMergeResult,
} from "./types.ts";

export interface TreeEntry {
	type: "file" | "symlink";
	objectId: string;
	mode: number;
	size: number;
	symlinkTarget?: string;
}

export type TreeManifest = Record<string, TreeEntry>;

export interface LayerRecord {
	layerId: string;
	parentLayerId?: string;
	createdAt: number;
	message: string;
	tree: TreeManifest;
}

export interface CommitRecord {
	commitId: string;
	branchName: string;
	baseLayerId: string;
	parentCommitId?: string;
	createdAt: number;
	message: string;
	tree: TreeManifest;
}

export interface BranchRecord {
	branchName: string;
	baseLayerId: string;
	headCommitId: string;
	workspacePath?: string;
	createdAt: number;
	updatedAt: number;
}

interface StoreMetadata {
	projectId: string;
	sourceRoot: string;
	headLayerId: string;
	layerSequence: number;
	commitSequence: number;
	logicalBytes: number;
	storedBytes: number;
	objectSizes: Record<string, number>;
	branches: Record<string, BranchRecord>;
}

/** Heavy dependency/build directories projected via O(1) symlink rather than tree copy */
const SHARED_DEPENDENCY_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".tox",
	"target",
	".gradle",
	".next",
	".nuxt",
]);

/** Directories never imported into LayerFS canonical store or workspaces */
const IGNORED_DIRS = new Set([
	".git",
	".jj",
	".hg",
	".svn",
	".tmp",
	".cache",
	".layerfs-orch",
]);

const TEST_FILE_PATTERNS = [
	/(^|\/)tests?\//i,
	/(^|\/)__tests__\//i,
	/\.(test|spec)\.[a-z0-9]+$/i,
	/_test\.[a-z0-9]+$/i,
	/^test_[^/]+\.[a-z0-9]+$/i,
];

export function isTestFilePath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, "/");
	return TEST_FILE_PATTERNS.some((re) => re.test(normalized));
}

function isSecretFileName(name: string): boolean {
	if (name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example") && !name.endsWith(".sample") && !name.endsWith(".template"))) {
		return true;
	}
	if (name === "id_rsa" || name === "id_ed25519" || name === "id_ecdsa") return true;
	if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12")) return true;
	return false;
}

export function matchGlobPattern(relPath: string, pattern: string): boolean {
	const cleanPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
	const cleanPattern = pattern.replace(/\\/g, "/").replace(/^\.\//, "");

	if (cleanPath === cleanPattern) return true;
	if (cleanPattern.endsWith("/") && cleanPath.startsWith(cleanPattern)) return true;
	if (!cleanPattern.includes("*") && !cleanPattern.includes("?")) {
		// Exact file or directory prefix match
		if (cleanPath.startsWith(`${cleanPattern}/`)) return true;
		return cleanPath === cleanPattern;
	}

	// Convert glob to regex
	let regexStr = "^";
	let i = 0;
	while (i < cleanPattern.length) {
		const c = cleanPattern[i];
		if (c === "*" && cleanPattern[i + 1] === "*") {
			if (cleanPattern[i + 2] === "/") {
				regexStr += "(?:.+/)?";
				i += 3;
				continue;
			}
			regexStr += ".*";
			i += 2;
			continue;
		}
		if (c === "*") {
			regexStr += "[^/]*";
			i++;
			continue;
		}
		if (c === "?") {
			regexStr += "[^/]";
			i++;
			continue;
		}
		if (".+^${}()|[]\\".includes(c)) {
			regexStr += `\\${c}`;
		} else {
			regexStr += c;
		}
		i++;
	}
	regexStr += "$";
	return new RegExp(regexStr).test(cleanPath);
}

export function matchesAnyPattern(relPath: string, patterns: string[]): boolean {
	return patterns.some((p) => matchGlobPattern(relPath, p));
}

export class LayerFSEngine {
	private readonly storeRoot: string;
	private readonly objectsDir: string;
	private readonly layersDir: string;
	private readonly commitsDir: string;
	private readonly workspacesDir: string;
	private readonly metaPath: string;
	private readonly projectId: string;
	private readonly sourceRoot: string;

	constructor(sourceRoot: string, projectId?: string) {
		this.sourceRoot = path.resolve(sourceRoot);
		const hash = crypto.createHash("sha256").update(this.sourceRoot).digest("hex").slice(0, 12);
		this.projectId = projectId || `${path.basename(this.sourceRoot)}-${hash}`;
		this.storeRoot = path.join(os.homedir(), ".pi", "agent", "orchestrator-layerfs", this.projectId);
		this.objectsDir = path.join(this.storeRoot, "objects");
		this.layersDir = path.join(this.storeRoot, "layers");
		this.commitsDir = path.join(this.storeRoot, "commits");
		this.workspacesDir = path.join(this.storeRoot, "workspaces");
		this.metaPath = path.join(this.storeRoot, "store-meta.json");
	}

	private ensureDirs(): void {
		for (const dir of [this.storeRoot, this.objectsDir, this.layersDir, this.commitsDir, this.workspacesDir]) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	private loadMeta(): StoreMetadata {
		this.ensureDirs();
		if (fs.existsSync(this.metaPath)) {
			try {
				return JSON.parse(fs.readFileSync(this.metaPath, "utf-8")) as StoreMetadata;
			} catch {
				// Fall through to fresh metadata
			}
		}
		return {
			projectId: this.projectId,
			sourceRoot: this.sourceRoot,
			headLayerId: "",
			layerSequence: 0,
			commitSequence: 0,
			logicalBytes: 0,
			storedBytes: 0,
			objectSizes: {},
			branches: {},
		};
	}

	private saveMeta(meta: StoreMetadata): void {
		this.ensureDirs();
		const tmp = `${this.metaPath}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
		fs.renameSync(tmp, this.metaPath);
	}

	private objectPath(objectId: string): string {
		const prefix = objectId.slice(0, 2);
		return path.join(this.objectsDir, prefix, objectId);
	}

	private writeCanonicalBlob(buf: Buffer, meta: StoreMetadata): string {
		const header = Buffer.from(`blob ${buf.byteLength}\0`, "utf-8");
		const objectId = crypto.createHash("sha256").update(header).update(buf).digest("hex");
		const target = this.objectPath(objectId);
		meta.logicalBytes += buf.byteLength;
		if (!fs.existsSync(target)) {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			const tmp = `${target}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 7)}`;
			fs.writeFileSync(tmp, buf, { mode: 0o444 });
			fs.renameSync(tmp, target);
			meta.storedBytes += buf.byteLength;
			meta.objectSizes[objectId] = buf.byteLength;
		}
		return objectId;
	}

	public readCanonicalBlob(objectId: string): Buffer {
		const target = this.objectPath(objectId);
		const buf = fs.readFileSync(target);
		const header = Buffer.from(`blob ${buf.byteLength}\0`, "utf-8");
		const actualId = crypto.createHash("sha256").update(header).update(buf).digest("hex");
		if (actualId !== objectId) {
			throw new Error(`LayerFS ObjectId integrity check failed for ${objectId} (got ${actualId})`);
		}
		return buf;
	}

	private scanTree(rootDir: string, meta: StoreMetadata): TreeManifest {
		const manifest: TreeManifest = {};

		const walk = (currentDir: string, relPrefix: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(currentDir, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));

			for (const entry of entries) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				if (SHARED_DEPENDENCY_DIRS.has(entry.name)) continue;
				if (isSecretFileName(entry.name)) continue;

				const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				const fullPath = path.join(currentDir, entry.name);

				let lstat: fs.Stats;
				try {
					lstat = fs.lstatSync(fullPath);
				} catch {
					continue;
				}

				if (lstat.isSymbolicLink()) {
					const linkTarget = fs.readlinkSync(fullPath);
					// Skip symlinks that point to shared dependency dirs we created
					if (SHARED_DEPENDENCY_DIRS.has(entry.name)) continue;
					const buf = Buffer.from(linkTarget, "utf-8");
					const objectId = this.writeCanonicalBlob(buf, meta);
					manifest[relPath] = {
						type: "symlink",
						objectId,
						mode: 0o120777,
						size: buf.byteLength,
						symlinkTarget: linkTarget,
					};
				} else if (lstat.isDirectory()) {
					walk(fullPath, relPath);
				} else if (lstat.isFile()) {
					const buf = fs.readFileSync(fullPath);
					const objectId = this.writeCanonicalBlob(buf, meta);
					const executable = (lstat.mode & 0o111) !== 0;
					manifest[relPath] = {
						type: "file",
						objectId,
						mode: executable ? 0o755 : 0o644,
						size: buf.byteLength,
					};
				}
			}
		};

		walk(rootDir, "");
		return manifest;
	}

	private saveLayer(layer: LayerRecord): void {
		const p = path.join(this.layersDir, `${layer.layerId}.json`);
		fs.writeFileSync(p, JSON.stringify(layer, null, 2), "utf-8");
	}

	public loadLayer(layerId: string): LayerRecord {
		const p = path.join(this.layersDir, `${layerId}.json`);
		return JSON.parse(fs.readFileSync(p, "utf-8")) as LayerRecord;
	}

	private saveCommit(commit: CommitRecord): void {
		const p = path.join(this.commitsDir, `${commit.commitId}.json`);
		fs.writeFileSync(p, JSON.stringify(commit, null, 2), "utf-8");
	}

	public loadCommit(commitId: string): CommitRecord {
		const p = path.join(this.commitsDir, `${commitId}.json`);
		return JSON.parse(fs.readFileSync(p, "utf-8")) as CommitRecord;
	}

	/**
	 * Imports the current host directory state as a new immutable Layer in the LayerStack.
	 */
	public importHostAsLayer(message: string): LayerRecord {
		const meta = this.loadMeta();
		const tree = this.scanTree(this.sourceRoot, meta);
		meta.layerSequence += 1;
		const layerId = `L${meta.layerSequence}`;

		const layer: LayerRecord = {
			layerId,
			parentLayerId: meta.headLayerId || undefined,
			createdAt: Date.now(),
			message,
			tree,
		};
		this.saveLayer(layer);
		meta.headLayerId = layerId;

		// Also create an initial baseline commit for main reference
		meta.commitSequence += 1;
		const commitId = `C${meta.commitSequence}`;
		const baseCommit: CommitRecord = {
			commitId,
			branchName: "main",
			baseLayerId: layerId,
			createdAt: Date.now(),
			message: `Layer ${layerId}: ${message}`,
			tree,
		};
		this.saveCommit(baseCommit);
		meta.branches.main = {
			branchName: "main",
			baseLayerId: layerId,
			headCommitId: commitId,
			createdAt: meta.branches.main?.createdAt ?? Date.now(),
			updatedAt: Date.now(),
		};

		this.saveMeta(meta);
		return layer;
	}

	/**
	 * Forks a writable Branch from the specified base Layer (or current head Layer).
	 * O(1) metadata operation — zero file copies.
	 */
	public forkBranch(branchName: string, baseLayerId?: string): BranchRecord {
		const meta = this.loadMeta();
		const targetLayerId = baseLayerId || meta.headLayerId;
		if (!targetLayerId) {
			throw new Error("Cannot fork branch: no base Layer exists in LayerFS store");
		}
		const layer = this.loadLayer(targetLayerId);

		meta.commitSequence += 1;
		const commitId = `C${meta.commitSequence}`;
		const initialCommit: CommitRecord = {
			commitId,
			branchName,
			baseLayerId: targetLayerId,
			createdAt: Date.now(),
			message: `Fork branch ${branchName} from ${targetLayerId}`,
			tree: layer.tree,
		};
		this.saveCommit(initialCommit);

		const branch: BranchRecord = {
			branchName,
			baseLayerId: targetLayerId,
			headCommitId: commitId,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		meta.branches[branchName] = branch;
		this.saveMeta(meta);
		return branch;
	}

	/**
	 * Mounts an ephemeral Workspace for a Branch and returns its filesystem projection path
	 * along with isolated scratch directories (.tmp and .cache).
	 */
	public mountWorkspace(branchName: string): {
		workspacePath: string;
		tmpDir: string;
		cacheDir: string;
		headCommitId: string;
		baseLayerId: string;
	} {
		const meta = this.loadMeta();
		const branch = meta.branches[branchName];
		if (!branch) {
			throw new Error(`NoSuchBranch: ${branchName}`);
		}
		const commit = this.loadCommit(branch.headCommitId);
		const safeBranchDir = branchName.replace(/[^\w.-]+/g, "_");
		const wsRoot = path.join(this.workspacesDir, safeBranchDir, "root");
		const tmpDir = path.join(wsRoot, ".tmp");
		const cacheDir = path.join(wsRoot, ".cache");

		// Clean and project exact branch head tree
		if (fs.existsSync(wsRoot)) {
			fs.rmSync(wsRoot, { recursive: true, force: true });
		}
		fs.mkdirSync(wsRoot, { recursive: true });
		fs.mkdirSync(tmpDir, { recursive: true });
		fs.mkdirSync(cacheDir, { recursive: true });

		for (const [relPath, entry] of Object.entries(commit.tree)) {
			const destPath = path.join(wsRoot, relPath);
			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
				try {
					fs.symlinkSync(entry.symlinkTarget, destPath);
				} catch {
					// Ignore dangling symlink collision
				}
			} else {
				const buf = this.readCanonicalBlob(entry.objectId);
				fs.writeFileSync(destPath, buf, { mode: entry.mode });
			}
		}

		// Link shared read-only heavy dependency directories from host if present
		try {
			const hostEntries = fs.readdirSync(this.sourceRoot, { withFileTypes: true });
			for (const entry of hostEntries) {
				if (SHARED_DEPENDENCY_DIRS.has(entry.name)) {
					const hostDepPath = path.join(this.sourceRoot, entry.name);
					const wsDepPath = path.join(wsRoot, entry.name);
					if (!fs.existsSync(wsDepPath)) {
						try {
							fs.symlinkSync(hostDepPath, wsDepPath);
						} catch {
							// Best-effort symlink
						}
					}
				}
			}
		} catch {
			// Ignore if sourceRoot cannot be listed
		}

		branch.workspacePath = wsRoot;
		branch.updatedAt = Date.now();
		meta.branches[branchName] = branch;
		this.saveMeta(meta);

		return {
			workspacePath: wsRoot,
			tmpDir,
			cacheDir,
			headCommitId: branch.headCommitId,
			baseLayerId: branch.baseLayerId,
		};
	}

	/**
	 * Captures the Workspace's current state and publishes an immutable Commit on its Branch
	 * using Compare-And-Swap (CAS) against `expectedHeadCommitId`.
	 */
	public commitWorkspace(
		branchName: string,
		message: string,
		expectedHeadCommitId?: string,
	): CommitRecord {
		const meta = this.loadMeta();
		const branch = meta.branches[branchName];
		if (!branch) {
			throw new Error(`NoSuchBranch: ${branchName}`);
		}
		if (!branch.workspacePath || !fs.existsSync(branch.workspacePath)) {
			throw new Error(`NoSuchWorkspace: Branch ${branchName} has no mounted workspace`);
		}
		if (expectedHeadCommitId && branch.headCommitId !== expectedHeadCommitId) {
			throw new Error(
				`CAS Conflict on branch ${branchName}: expected head ${expectedHeadCommitId}, found ${branch.headCommitId}`,
			);
		}

		const tree = this.scanTree(branch.workspacePath, meta);
		meta.commitSequence += 1;
		const commitId = `C${meta.commitSequence}`;
		const commit: CommitRecord = {
			commitId,
			branchName,
			baseLayerId: branch.baseLayerId,
			parentCommitId: branch.headCommitId,
			createdAt: Date.now(),
			message,
			tree,
		};
		this.saveCommit(commit);

		branch.headCommitId = commitId;
		branch.updatedAt = Date.now();
		meta.branches[branchName] = branch;
		this.saveMeta(meta);
		return commit;
	}

	/**
	 * Computes a detailed unified diff between a Branch's current head Commit and its base Layer,
	 * automatically partitioning diffs into Implementation Diff and Unit Test Diff.
	 */
	public diffBranch(branchName: string, explicitTestPatterns: string[] = []): BranchDiffResult {
		const meta = this.loadMeta();
		const branch = meta.branches[branchName];
		if (!branch) {
			throw new Error(`NoSuchBranch: ${branchName}`);
		}
		const baseLayer = this.loadLayer(branch.baseLayerId);
		const headCommit = this.loadCommit(branch.headCommitId);

		const allPaths = new Set<string>([
			...Object.keys(baseLayer.tree),
			...Object.keys(headCommit.tree),
		]);
		const sortedPaths = Array.from(allPaths).sort();

		const files: FileChangeEntry[] = [];
		const implDiffParts: string[] = [];
		const testDiffParts: string[] = [];
		let totalLinesAdded = 0;
		let totalLinesRemoved = 0;

		for (const relPath of sortedPaths) {
			const baseEntry = baseLayer.tree[relPath];
			const headEntry = headCommit.tree[relPath];

			if (baseEntry && headEntry && baseEntry.objectId === headEntry.objectId) {
				continue;
			}

			const isTest =
				isTestFilePath(relPath) ||
				(explicitTestPatterns.length > 0 && matchesAnyPattern(relPath, explicitTestPatterns));

			let changeType: "added" | "modified" | "deleted";
			let baseText = "";
			let headText = "";

			if (!baseEntry && headEntry) {
				changeType = "added";
				headText = this.readTextSafe(headEntry.objectId);
			} else if (baseEntry && !headEntry) {
				changeType = "deleted";
				baseText = this.readTextSafe(baseEntry.objectId);
			} else {
				changeType = "modified";
				baseText = this.readTextSafe(baseEntry!.objectId);
				headText = this.readTextSafe(headEntry!.objectId);
			}

			const { unifiedDiff, added, removed } = createUnifiedFileDiff(
				relPath,
				baseText,
				headText,
				changeType,
			);

			totalLinesAdded += added;
			totalLinesRemoved += removed;

			files.push({
				path: relPath,
				changeType,
				baseObjectId: baseEntry?.objectId,
				headObjectId: headEntry?.objectId,
				isTestFile: isTest,
				linesAdded: added,
				linesRemoved: removed,
				unifiedDiff,
			});

			if (isTest) {
				testDiffParts.push(unifiedDiff);
			} else {
				implDiffParts.push(unifiedDiff);
			}
		}

		return {
			branchName,
			baseLayerId: branch.baseLayerId,
			headCommitId: branch.headCommitId,
			files,
			implUnifiedDiff: implDiffParts.join("\n"),
			testUnifiedDiff: testDiffParts.join("\n"),
			fullUnifiedDiff: [...implDiffParts, ...testDiffParts].join("\n"),
			totalLinesAdded,
			totalLinesRemoved,
		};
	}

	/**
	 * Performs a deterministic 3-Way Tree & Line Merge across multiple wave branches
	 * forked from the same base Layer, then publishes the result as a new immutable Layer
	 * and applies it atomically to the host working tree.
	 */
	public mergeAndPublishWave(
		branchNames: string[],
		options: { allowAutoThreeWayLineMerge: boolean; message: string },
	): WaveMergeResult {
		const meta = this.loadMeta();
		if (branchNames.length === 0) {
			return {
				ok: true,
				publishedLayerId: meta.headLayerId,
				mergedFiles: [],
				conflicts: [],
				storeMetrics: this.getMetrics(),
			};
		}

		const baseLayerId = meta.headLayerId;
		const baseLayer = this.loadLayer(baseLayerId);
		const mergedTree: TreeManifest = { ...baseLayer.tree };

		// Track per-path modifications across branches
		const pathTouchMap = new Map<
			string,
			Array<{
				branchName: string;
				entry: TreeEntry | undefined;
			}>
		>();

		for (const branchName of branchNames) {
			const branch = meta.branches[branchName];
			if (!branch) {
				throw new Error(`Cannot merge unknown branch: ${branchName}`);
			}
			const headCommit = this.loadCommit(branch.headCommitId);
			const candidatePaths = new Set<string>([
				...Object.keys(baseLayer.tree),
				...Object.keys(headCommit.tree),
			]);

			for (const relPath of candidatePaths) {
				const baseEntry = baseLayer.tree[relPath];
				const branchEntry = headCommit.tree[relPath];
				if (baseEntry?.objectId === branchEntry?.objectId) continue;

				const list = pathTouchMap.get(relPath) ?? [];
				list.push({ branchName, entry: branchEntry });
				pathTouchMap.set(relPath, list);
			}
		}

		const mergedFiles: WaveMergeResult["mergedFiles"] = [];
		const conflicts: MergeConflictItem[] = [];

		for (const [relPath, touches] of Array.from(pathTouchMap.entries()).sort((a, b) =>
			a[0].localeCompare(b[0]),
		)) {
			const baseEntry = baseLayer.tree[relPath];

			if (touches.length === 1) {
				const { branchName, entry } = touches[0];
				if (!entry) {
					delete mergedTree[relPath];
					mergedFiles.push({
						path: relPath,
						changeType: "deleted",
						fromBranches: [branchName],
					});
				} else {
					mergedTree[relPath] = entry;
					mergedFiles.push({
						path: relPath,
						changeType: baseEntry ? "modified" : "added",
						fromBranches: [branchName],
					});
				}
				continue;
			}

			// Multiple branches touched the same path
			const uniqueObjectIds = new Set(touches.map((t) => t.entry?.objectId ?? "DELETED"));
			if (uniqueObjectIds.size === 1) {
				// Convergent identical change across branches! Deduplicates cleanly.
				const firstEntry = touches[0].entry;
				if (!firstEntry) {
					delete mergedTree[relPath];
					mergedFiles.push({
						path: relPath,
						changeType: "deleted",
						fromBranches: touches.map((t) => t.branchName),
					});
				} else {
					mergedTree[relPath] = firstEntry;
					mergedFiles.push({
						path: relPath,
						changeType: baseEntry ? "modified" : "added",
						fromBranches: touches.map((t) => t.branchName),
					});
				}
				continue;
			}

			// Check if 3-way line merge is possible (all touches are regular text files and baseEntry exists)
			const allRegularFiles =
				Boolean(baseEntry && baseEntry.type === "file") &&
				touches.every((t) => t.entry && t.entry.type === "file");

			if (options.allowAutoThreeWayLineMerge && allRegularFiles && baseEntry) {
				const baseText = this.readTextSafe(baseEntry.objectId);
				let currentMergedText = baseText;
				let lineMergeFailed = false;
				let conflictPreview = "";

				for (const touch of touches) {
					const branchText = this.readTextSafe(touch.entry!.objectId);
					const mergeAttempt = threeWayMergeText(baseText, currentMergedText, branchText);
					if (!mergeAttempt.ok) {
						lineMergeFailed = true;
						conflictPreview = mergeAttempt.conflictPreview || "Overlapping line edits";
						break;
					}
					currentMergedText = mergeAttempt.mergedText;
				}

				if (!lineMergeFailed) {
					const mergedBuf = Buffer.from(currentMergedText, "utf-8");
					const newObjectId = this.writeCanonicalBlob(mergedBuf, meta);
					mergedTree[relPath] = {
						type: "file",
						objectId: newObjectId,
						mode: touches[0].entry!.mode,
						size: mergedBuf.byteLength,
					};
					mergedFiles.push({
						path: relPath,
						changeType: "modified",
						fromBranches: touches.map((t) => t.branchName),
						autoMergedLines: true,
					});
					continue;
				}

				const branchObjectIds: Record<string, string | undefined> = {};
				for (const t of touches) branchObjectIds[t.branchName] = t.entry?.objectId;
				conflicts.push({
					path: relPath,
					branches: touches.map((t) => t.branchName),
					reason: "Overlapping line modifications in parallel branches",
					baseObjectId: baseEntry.objectId,
					branchObjectIds,
					conflictPreview,
				});
				continue;
			}

			// Otherwise record conflict
			const branchObjectIds: Record<string, string | undefined> = {};
			for (const t of touches) branchObjectIds[t.branchName] = t.entry?.objectId;
			conflicts.push({
				path: relPath,
				branches: touches.map((t) => t.branchName),
				reason: baseEntry
					? "Incompatible parallel modifications / deletions on the same path"
					: "Multiple branches independently created the same file with different contents",
				baseObjectId: baseEntry?.objectId,
				branchObjectIds,
			});
		}

		if (conflicts.length > 0) {
			this.saveMeta(meta);
			return {
				ok: false,
				mergedFiles: [],
				conflicts,
				storeMetrics: this.getMetrics(),
			};
		}

		// Publish new Layer and atomically apply delta to host sourceRoot
		meta.layerSequence += 1;
		const newLayerId = `L${meta.layerSequence}`;
		const newLayer: LayerRecord = {
			layerId: newLayerId,
			parentLayerId: baseLayerId,
			createdAt: Date.now(),
			message: options.message,
			tree: mergedTree,
		};
		this.saveLayer(newLayer);
		meta.headLayerId = newLayerId;

		// Apply delta to host directory
		for (const item of mergedFiles) {
			const hostFilePath = path.join(this.sourceRoot, item.path);
			if (item.changeType === "deleted") {
				if (fs.existsSync(hostFilePath)) {
					fs.rmSync(hostFilePath, { force: true });
				}
			} else {
				const entry = mergedTree[item.path];
				fs.mkdirSync(path.dirname(hostFilePath), { recursive: true });
				if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
					if (fs.existsSync(hostFilePath)) fs.rmSync(hostFilePath, { force: true });
					fs.symlinkSync(entry.symlinkTarget, hostFilePath);
				} else {
					const buf = this.readCanonicalBlob(entry.objectId);
					fs.writeFileSync(hostFilePath, buf, { mode: entry.mode });
				}
			}
		}

		// Clean up ephemeral workspaces of merged branches
		for (const branchName of branchNames) {
			this.unmountWorkspace(branchName, meta);
		}

		this.saveMeta(meta);
		return {
			ok: true,
			publishedLayerId: newLayerId,
			mergedFiles,
			conflicts: [],
			storeMetrics: this.getMetrics(),
		};
	}

	public unmountWorkspace(branchName: string, existingMeta?: StoreMetadata): void {
		const meta = existingMeta ?? this.loadMeta();
		const branch = meta.branches[branchName];
		if (branch?.workspacePath && fs.existsSync(branch.workspacePath)) {
			const parentDir = path.dirname(branch.workspacePath);
			fs.rmSync(parentDir, { recursive: true, force: true });
			branch.workspacePath = undefined;
		}
		if (!existingMeta) {
			this.saveMeta(meta);
		}
	}

	public getMetrics(): StoreMetrics {
		const meta = this.loadMeta();
		const objectCount = Object.keys(meta.objectSizes).length;
		const savedBytes = Math.max(0, meta.logicalBytes - meta.storedBytes);
		const dedupRatio =
			meta.storedBytes > 0 ? Number((meta.logicalBytes / meta.storedBytes).toFixed(2)) : 1;

		return {
			storeRoot: this.storeRoot,
			layerCount: meta.layerSequence,
			branchCount: Object.keys(meta.branches).length,
			commitCount: meta.commitSequence,
			objectCount,
			logicalBytes: meta.logicalBytes,
			storedBytes: meta.storedBytes,
			savedBytes,
			dedupRatio,
		};
	}

	private readTextSafe(objectId: string): string {
		const buf = this.readCanonicalBlob(objectId);
		// Check for null bytes (binary file)
		if (buf.includes(0)) {
			return `[Binary file: ${buf.byteLength} bytes, ObjectId=${objectId.slice(0, 12)}]`;
		}
		return buf.toString("utf-8");
	}
}

/**
 * Generates a readable unified diff for a single file.
 */
function createUnifiedFileDiff(
	relPath: string,
	oldText: string,
	newText: string,
	changeType: "added" | "modified" | "deleted",
): { unifiedDiff: string; added: number; removed: number } {
	const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
	const newLines = newText.length === 0 ? [] : newText.split("\n");

	if (changeType === "added") {
		const body = newLines.map((l) => `+${l}`).join("\n");
		return {
			unifiedDiff: `--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${newLines.length} @@\n${body}`,
			added: newLines.length,
			removed: 0,
		};
	}

	if (changeType === "deleted") {
		const body = oldLines.map((l) => `-${l}`).join("\n");
		return {
			unifiedDiff: `--- a/${relPath}\n+++ /dev/null\n@@ -1,${oldLines.length} +0,0 @@\n${body}`,
			added: 0,
			removed: oldLines.length,
		};
	}

	// Myers/LCS line diff with context lines
	const edits = computeLineDiff(oldLines, newLines);
	let added = 0;
	let removed = 0;
	for (const e of edits) {
		if (e.type === "add") added++;
		if (e.type === "del") removed++;
	}

	const hunks: string[] = [];
	const contextRadius = 3;
	const changedIndices = edits
		.map((e, idx) => (e.type !== "keep" ? idx : -1))
		.filter((idx) => idx !== -1);

	if (changedIndices.length === 0) {
		return { unifiedDiff: "", added: 0, removed: 0 };
	}

	let rangeStart = Math.max(0, changedIndices[0] - contextRadius);
	let rangeEnd = Math.min(edits.length - 1, changedIndices[0] + contextRadius);

	const ranges: Array<[number, number]> = [];
	for (let i = 1; i < changedIndices.length; i++) {
		const nextStart = Math.max(0, changedIndices[i] - contextRadius);
		const nextEnd = Math.min(edits.length - 1, changedIndices[i] + contextRadius);
		if (nextStart <= rangeEnd + 1) {
			rangeEnd = nextEnd;
		} else {
			ranges.push([rangeStart, rangeEnd]);
			rangeStart = nextStart;
			rangeEnd = nextEnd;
		}
	}
	ranges.push([rangeStart, rangeEnd]);

	for (const [start, end] of ranges) {
		const lines: string[] = [];
		let oldStart = 1;
		let newStart = 1;
		let oldCount = 0;
		let newCount = 0;

		for (let i = 0; i < start; i++) {
			if (edits[i].type !== "add") oldStart++;
			if (edits[i].type !== "del") newStart++;
		}
		for (let i = start; i <= end; i++) {
			const e = edits[i];
			if (e.type === "keep") {
				lines.push(` ${e.line}`);
				oldCount++;
				newCount++;
			} else if (e.type === "del") {
				lines.push(`-${e.line}`);
				oldCount++;
			} else {
				lines.push(`+${e.line}`);
				newCount++;
			}
		}
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines.join("\n")}`);
	}

	return {
		unifiedDiff: `--- a/${relPath}\n+++ b/${relPath}\n${hunks.join("\n")}`,
		added,
		removed,
	};
}

interface LineEdit {
	type: "keep" | "add" | "del";
	line: string;
}

function computeLineDiff(oldLines: string[], newLines: string[]): LineEdit[] {
	// Trim common prefix and suffix for speed on large files
	let start = 0;
	while (
		start < oldLines.length &&
		start < newLines.length &&
		oldLines[start] === newLines[start]
	) {
		start++;
	}

	let oldEnd = oldLines.length - 1;
	let newEnd = newLines.length - 1;
	while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}

	const prefix: LineEdit[] = oldLines.slice(0, start).map((line) => ({ type: "keep", line }));
	const suffix: LineEdit[] = oldLines.slice(oldEnd + 1).map((line) => ({ type: "keep", line }));

	const midOld = oldLines.slice(start, oldEnd + 1);
	const midNew = newLines.slice(start, newEnd + 1);

	if (midOld.length === 0 && midNew.length === 0) {
		return [...prefix, ...suffix];
	}
	if (midOld.length === 0) {
		return [...prefix, ...midNew.map((line): LineEdit => ({ type: "add", line })), ...suffix];
	}
	if (midNew.length === 0) {
		return [...prefix, ...midOld.map((line): LineEdit => ({ type: "del", line })), ...suffix];
	}

	// If middle section is huge (>1500 lines), fall back to block replacement
	if (midOld.length * midNew.length > 2_250_000) {
		return [
			...prefix,
			...midOld.map((line): LineEdit => ({ type: "del", line })),
			...midNew.map((line): LineEdit => ({ type: "add", line })),
			...suffix,
		];
	}

	const n = midOld.length;
	const m = midNew.length;
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (midOld[i] === midNew[j]) {
				dp[i][j] = 1 + dp[i + 1][j + 1];
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const midEdits: LineEdit[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (midOld[i] === midNew[j]) {
			midEdits.push({ type: "keep", line: midOld[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			midEdits.push({ type: "del", line: midOld[i] });
			i++;
		} else {
			midEdits.push({ type: "add", line: midNew[j] });
			j++;
		}
	}
	while (i < n) {
		midEdits.push({ type: "del", line: midOld[i++] });
	}
	while (j < m) {
		midEdits.push({ type: "add", line: midNew[j++] });
	}

	return [...prefix, ...midEdits, ...suffix];
}

interface PatchHunk {
	baseStart: number; // 0-indexed inclusive
	baseEnd: number; // 0-indexed exclusive
	replacement: string[];
}

function extractHunks(baseLines: string[], targetLines: string[]): PatchHunk[] {
	const edits = computeLineDiff(baseLines, targetLines);
	const hunks: PatchHunk[] = [];
	let baseIdx = 0;
	let i = 0;

	while (i < edits.length) {
		if (edits[i].type === "keep") {
			baseIdx++;
			i++;
			continue;
		}
		const hunkBaseStart = baseIdx;
		const replacement: string[] = [];
		while (i < edits.length && edits[i].type !== "keep") {
			if (edits[i].type === "del") {
				baseIdx++;
			} else if (edits[i].type === "add") {
				replacement.push(edits[i].line);
			}
			i++;
		}
		hunks.push({
			baseStart: hunkBaseStart,
			baseEnd: baseIdx,
			replacement,
		});
	}
	return hunks;
}

/**
 * Deterministic 3-way text merge for disjoint hunks relative to `baseText`.
 */
function threeWayMergeText(
	baseText: string,
	oursText: string,
	theirsText: string,
): { ok: boolean; mergedText: string; conflictPreview?: string } {
	if (oursText === theirsText) return { ok: true, mergedText: oursText };
	if (oursText === baseText) return { ok: true, mergedText: theirsText };
	if (theirsText === baseText) return { ok: true, mergedText: oursText };

	const baseLines = baseText.split("\n");
	const oursLines = oursText.split("\n");
	const theirsLines = theirsText.split("\n");

	const oursHunks = extractHunks(baseLines, oursLines);
	const theirsHunks = extractHunks(baseLines, theirsLines);

	const combined: Array<PatchHunk & { side: "ours" | "theirs" }> = [
		...oursHunks.map((h) => ({ ...h, side: "ours" as const })),
		...theirsHunks.map((h) => ({ ...h, side: "theirs" as const })),
	].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

	const mergedHunks: PatchHunk[] = [];
	for (let i = 0; i < combined.length; i++) {
		const curr = combined[i];
		if (mergedHunks.length === 0) {
			mergedHunks.push(curr);
			continue;
		}
		const prev = mergedHunks[mergedHunks.length - 1];
		const overlaps =
			curr.baseStart < prev.baseEnd ||
			(curr.baseStart === prev.baseStart && curr.baseEnd === prev.baseEnd);

		if (overlaps) {
			// Identical hunk on both sides is safe
			if (
				curr.baseStart === prev.baseStart &&
				curr.baseEnd === prev.baseEnd &&
				curr.replacement.join("\n") === prev.replacement.join("\n")
			) {
				continue;
			}
			return {
				ok: false,
				mergedText: "",
				conflictPreview: [
					`<<<<<<< ours (lines ${prev.baseStart + 1}-${prev.baseEnd})`,
					prev.replacement.join("\n"),
					"=======",
					curr.replacement.join("\n"),
					`>>>>>>> theirs (lines ${curr.baseStart + 1}-${curr.baseEnd})`,
				].join("\n"),
			};
		}
		mergedHunks.push(curr);
	}

	const out: string[] = [];
	let cursor = 0;
	for (const hunk of mergedHunks) {
		while (cursor < hunk.baseStart) {
			out.push(baseLines[cursor++]);
		}
		out.push(...hunk.replacement);
		cursor = hunk.baseEnd;
	}
	while (cursor < baseLines.length) {
		out.push(baseLines[cursor++]);
	}

	return { ok: true, mergedText: out.join("\n") };
}
