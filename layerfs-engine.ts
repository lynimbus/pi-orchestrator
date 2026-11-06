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
	/** Set when the imported tree loses files relative to its parent layer */
	treeRegressionWarning?: string;
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

export interface HostSnapshotEntry {
	existed: boolean;
	type?: "file" | "symlink" | "directory";
	objectId?: string;
	mode?: number;
	symlinkTarget?: string;
}

/** Pre-image of the host working tree, captured before a published layer is applied. */
export interface HostSnapshotRecord {
	layerId: string;
	parentLayerId: string;
	branchNames: string[];
	createdAt: number;
	files: Record<string, HostSnapshotEntry>;
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
	private readonly snapshotsDir: string;
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
		this.snapshotsDir = path.join(this.storeRoot, "host-snapshots");
		this.metaPath = path.join(this.storeRoot, "store-meta.json");
	}

	private ensureDirs(): void {
		for (const dir of [this.storeRoot, this.objectsDir, this.layersDir, this.commitsDir, this.workspacesDir, this.snapshotsDir]) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	private loadMeta(): StoreMetadata {
		this.ensureDirs();
		if (fs.existsSync(this.metaPath)) {
			// NEVER silently reset a corrupt/partially written metadata file: doing so
			// would make the store forget its head layer and start a fresh L1 from the
			// (possibly rolled-back) host tree.
			const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf-8")) as StoreMetadata;
			if (!parsed || typeof parsed !== "object" || !("headLayerId" in parsed)) {
				throw new Error(`LayerFS store metadata is corrupt: ${this.metaPath}`);
			}
			return parsed;
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

	private atomicWriteJson(filePath: string, value: unknown): void {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
		fs.renameSync(tmp, filePath);
	}

	private saveLayer(layer: LayerRecord): void {
		this.atomicWriteJson(path.join(this.layersDir, `${layer.layerId}.json`), layer);
	}

	public loadLayer(layerId: string): LayerRecord {
		const p = path.join(this.layersDir, `${layerId}.json`);
		return JSON.parse(fs.readFileSync(p, "utf-8")) as LayerRecord;
	}

	private saveCommit(commit: CommitRecord): void {
		this.atomicWriteJson(path.join(this.commitsDir, `${commit.commitId}.json`), commit);
	}

	public loadCommit(commitId: string): CommitRecord {
		const p = path.join(this.commitsDir, `${commitId}.json`);
		return JSON.parse(fs.readFileSync(p, "utf-8")) as CommitRecord;
	}

	/**
	 * Imports the current host directory state as a new immutable Layer in the LayerStack.
	 */
	public importHostAsLayer(
		message: string,
		options: { expectedParentLayerId?: string } = {},
	): LayerRecord {
		const meta = this.loadMeta();
		this.assertStoreMatchesSource(meta);
		if (
			options.expectedParentLayerId &&
			meta.headLayerId !== options.expectedParentLayerId
		) {
			throw new Error(
				`Stale host import: expected parent layer ${options.expectedParentLayerId}, but the store head is ${meta.headLayerId || "(none)"}.`,
			);
		}
		const tree = this.scanTree(this.sourceRoot, meta);
		const parentLayerId = meta.headLayerId || undefined;
		let treeRegressionWarning: string | undefined;
		if (parentLayerId) {
			const parentTree = this.loadLayer(parentLayerId).tree;
			const dropped = Object.keys(parentTree).filter((p) => !(p in tree));
			if (dropped.length > 0) {
				treeRegressionWarning =
					`Host import drops ${dropped.length} file(s) present in parent layer ${parentLayerId}: ` +
					`${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", ..." : ""}. ` +
					`Verify that these deletions are intentional (untracked files are imported from disk, not from git).`;
			}
		}
		meta.layerSequence += 1;
		const layerId = `L${meta.layerSequence}`;

		const layer: LayerRecord = {
			layerId,
			parentLayerId,
			createdAt: Date.now(),
			message,
			tree,
			treeRegressionWarning,
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
		options: {
			allowAutoThreeWayLineMerge: boolean;
			message: string;
			/** Plan's base layer: refuse when the store head has already advanced (duplicate integrate). */
			expectedBaseLayerId?: string;
			/** Verify host <-> layer consistency after applying the delta (default: true). */
			verifyHost?: boolean;
		},
	): WaveMergeResult {
		const meta = this.loadMeta();
		this.assertStoreMatchesSource(meta);
		const refusal = (error: string): WaveMergeResult => ({
			ok: false,
			error,
			baseLayerId: meta.headLayerId,
			mergedFiles: [],
			conflicts: [
				{
					path: "(wave)",
					branches: branchNames,
					reason: error,
					branchObjectIds: {},
				},
			],
			storeMetrics: this.getMetrics(),
		});

		if (branchNames.length === 0) {
			return {
				ok: true,
				publishedLayerId: meta.headLayerId,
				baseLayerId: meta.headLayerId,
				hostMatchesLayer: true,
				hostMismatches: [],
				mergedFiles: [],
				conflicts: [],
				storeMetrics: this.getMetrics(),
			};
		}

		const baseLayerId = meta.headLayerId;
		if (options.expectedBaseLayerId && options.expectedBaseLayerId !== baseLayerId) {
			return refusal(
				`Refusing to merge: plan expected base layer ${options.expectedBaseLayerId}, but the store head is ${baseLayerId}. ` +
					`This wave was most likely already integrated. Use orch_retry_integration (tests only), orch_rollback_integration, or /orch reset.`,
			);
		}
		const baseLayer = this.loadLayer(baseLayerId);
		const mergedTree: TreeManifest = { ...baseLayer.tree };
		/** Paths explicitly deleted by a branch (relative to its OWN fork base) */
		const explicitDeletions = new Set<string>();

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
				return refusal(`Cannot merge unknown branch: ${branchName}`);
			}
			if (branch.baseLayerId !== baseLayerId) {
				return refusal(
					`Stale branch "${branchName}" was forked from ${branch.baseLayerId}, but the wave base is now ${baseLayerId}. ` +
						`Reject/re-dispatch the task (or roll back the published layer) instead of re-merging stale branch trees.`,
				);
			}
			const headCommit = this.loadCommit(branch.headCommitId);
			if (headCommit.baseLayerId && headCommit.baseLayerId !== baseLayerId) {
				return refusal(
					`Stale commit ${headCommit.commitId} on branch "${branchName}" was based on ${headCommit.baseLayerId}, expected ${baseLayerId}.`,
				);
			}

			// CRITICAL: a branch head tree is a FULL snapshot of its fork base, NOT a delta.
			// Touched paths must be computed against that fork base. Comparing it to the
			// current store head (which advances after a previous integrate) makes every
			// cross-branch new file look like a deletion and silently drops it from the tree.
			const forkBaseTree = this.loadLayer(branch.baseLayerId).tree;
			const candidatePaths = new Set<string>([
				...Object.keys(forkBaseTree),
				...Object.keys(headCommit.tree),
			]);

			for (const relPath of candidatePaths) {
				const forkEntry = forkBaseTree[relPath];
				const branchEntry = headCommit.tree[relPath];
				if (forkEntry?.objectId === branchEntry?.objectId) continue;

				const list = pathTouchMap.get(relPath) ?? [];
				list.push({ branchName, entry: branchEntry });
				pathTouchMap.set(relPath, list);
				if (forkEntry && !branchEntry) explicitDeletions.add(relPath);
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
				baseLayerId,
				mergedFiles: [],
				conflicts,
				storeMetrics: this.getMetrics(),
			};
		}

		// Guard against silent data loss: every path that disappears from the parent
		// tree must have been explicitly deleted by a branch. This catches stale-branch
		// replays and any layer that would shrink the tree without a reason (the L4
		// rollback layer described in docs/orchestrator-issues.md).
		const unexplainedDeletions = Object.keys(baseLayer.tree).filter(
			(relPath) => !(relPath in mergedTree) && !explicitDeletions.has(relPath),
		);
		if (unexplainedDeletions.length > 0) {
			return refusal(
				`Refusing to publish a layer that drops ${unexplainedDeletions.length} file(s) without an explicit branch deletion: ` +
					`${unexplainedDeletions.slice(0, 20).join(", ")}${unexplainedDeletions.length > 20 ? ", ..." : ""}`,
			);
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

		// Capture the host pre-image BEFORE touching anything. It is persisted first so
		// a crash/failure can never leave the host in a half-applied, unrecoverable state.
		const snapshot = this.captureHostSnapshot(newLayerId, baseLayerId, branchNames, mergedFiles, meta);
		this.saveHostSnapshot(snapshot);

		let hostVerification = { matches: true, mismatches: [] as string[], checked: 0 };
		let hostDrift: string[] = [];
		try {
			this.applyDeltaToHost(mergedFiles, mergedTree);
			if (options.verifyHost !== false) {
				// Strictly verify the paths this wave actually applied. Unrelated host
				// edits (e.g. direct escalated lead edits re-imported afterwards) are
				// reported as drift, but must not abort an otherwise valid merge.
				hostVerification = this.verifyHostMatchesTree(
					mergedTree,
					mergedFiles.map((item) => item.path),
				);
				if (!hostVerification.matches) {
					throw new Error(
						`host <-> layer mismatch on merged paths: ${hostVerification.mismatches.slice(0, 10).join("; ")}`,
					);
				}
				hostDrift = this.verifyHostMatchesTree(mergedTree).mismatches;
			}
		} catch (err) {
			this.restoreHostSnapshot(snapshot);
			return refusal(
				`Failed to apply/verify merged tree on host: ${err instanceof Error ? err.message : String(err)}. ` +
					`The host working tree was restored from the snapshot and NO layer was published.`,
			);
		}

		// Only publish once the host has been verified: a published layer is always
		// consistent with the host working tree.
		this.saveLayer(newLayer);
		meta.headLayerId = newLayerId;

		// Clean up ephemeral workspaces of merged branches
		for (const branchName of branchNames) {
			this.unmountWorkspace(branchName, meta);
		}

		this.saveMeta(meta);
		return {
			ok: true,
			publishedLayerId: newLayerId,
			baseLayerId,
			hostMatchesLayer: hostVerification.matches,
			hostMismatches: hostVerification.mismatches,
			hostDrift,
			rollbackSnapshotId: newLayerId,
			mergedFiles,
			conflicts: [],
			storeMetrics: this.getMetrics(),
		};
	}

	/** Resolve a tree path safely: never allow absolute paths or `..` traversal out of the host root. */
	private safeHostPath(relPath: string): string {
		const normalized = relPath.replace(/\\/g, "/");
		if (
			path.isAbsolute(normalized) ||
			normalized.split("/").includes("..") ||
			normalized.length === 0
		) {
			throw new Error(`Unsafe tree path rejected: "${relPath}"`);
		}
		const full = path.resolve(this.sourceRoot, normalized);
		if (full !== this.sourceRoot && !full.startsWith(this.sourceRoot + path.sep)) {
			throw new Error(`Tree path escapes host root: "${relPath}"`);
		}
		return full;
	}

	private lstatIfExists(fullPath: string): fs.Stats | undefined {
		try {
			return fs.lstatSync(fullPath);
		} catch {
			return undefined;
		}
	}

	private captureHostSnapshot(
		layerId: string,
		parentLayerId: string,
		branchNames: string[],
		mergedFiles: WaveMergeResult["mergedFiles"],
		meta: StoreMetadata,
	): HostSnapshotRecord {
		const files: Record<string, HostSnapshotEntry> = {};
		for (const item of mergedFiles) {
			const full = this.safeHostPath(item.path);
			const stat = this.lstatIfExists(full);
			if (!stat) {
				files[item.path] = { existed: false };
				continue;
			}
			if (stat.isSymbolicLink()) {
				files[item.path] = {
					existed: true,
					type: "symlink",
					symlinkTarget: fs.readlinkSync(full),
					mode: stat.mode & 0o7777,
				};
			} else if (stat.isDirectory()) {
				files[item.path] = { existed: true, type: "directory", mode: stat.mode & 0o7777 };
			} else {
				files[item.path] = {
					existed: true,
					type: "file",
					objectId: this.writeCanonicalBlob(fs.readFileSync(full), meta),
					mode: stat.mode & 0o7777,
				};
			}
		}
		return { layerId, parentLayerId, branchNames, createdAt: Date.now(), files };
	}

	private snapshotPath(layerId: string): string {
		return path.join(this.snapshotsDir, `${layerId}.json`);
	}

	private saveHostSnapshot(snapshot: HostSnapshotRecord): void {
		this.atomicWriteJson(this.snapshotPath(snapshot.layerId), snapshot);
	}

	private loadHostSnapshot(layerId: string): HostSnapshotRecord | undefined {
		const p = this.snapshotPath(layerId);
		if (!fs.existsSync(p)) return undefined;
		return JSON.parse(fs.readFileSync(p, "utf-8")) as HostSnapshotRecord;
	}

	private restoreHostSnapshot(snapshot: HostSnapshotRecord): void {
		for (const [relPath, entry] of Object.entries(snapshot.files)) {
			const full = this.safeHostPath(relPath);
			const stat = this.lstatIfExists(full);
			if (stat) {
				fs.rmSync(full, { force: true, recursive: stat.isDirectory() });
			}
			if (!entry.existed) continue;
			fs.mkdirSync(path.dirname(full), { recursive: true });
			if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
				fs.symlinkSync(entry.symlinkTarget, full);
			} else if (entry.type === "directory") {
				fs.mkdirSync(full, { recursive: true });
			} else if (entry.type === "file" && entry.objectId) {
				fs.writeFileSync(full, this.readCanonicalBlob(entry.objectId));
				if (entry.mode !== undefined) fs.chmodSync(full, entry.mode & 0o7777);
			}
		}
	}

	private applyDeltaToHost(
		mergedFiles: WaveMergeResult["mergedFiles"],
		mergedTree: TreeManifest,
	): void {
		for (const item of mergedFiles) {
			const hostFilePath = this.safeHostPath(item.path);
			const existing = this.lstatIfExists(hostFilePath);
			if (item.changeType === "deleted") {
				if (existing?.isDirectory()) {
					throw new Error(`Refusing to delete host directory "${item.path}"`);
				}
				if (existing) fs.rmSync(hostFilePath, { force: true });
				continue;
			}
			const entry = mergedTree[item.path];
			if (!entry) continue;
			if (existing?.isDirectory()) {
				throw new Error(`Refusing to overwrite host directory "${item.path}" with a ${entry.type}`);
			}
			fs.mkdirSync(path.dirname(hostFilePath), { recursive: true });
			// Remove first: never write through an existing symlink, and make sure the
			// recorded mode (e.g. executable bit) is applied to a freshly created file.
			if (existing) fs.rmSync(hostFilePath, { force: true });
			if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
				fs.symlinkSync(entry.symlinkTarget, hostFilePath);
			} else {
				const buf = this.readCanonicalBlob(entry.objectId);
				fs.writeFileSync(hostFilePath, buf, { mode: entry.mode });
				fs.chmodSync(hostFilePath, entry.mode & 0o7777);
			}
		}
	}

	private verifyHostMatchesTree(
		tree: TreeManifest,
		onlyPaths?: string[],
	): {
		matches: boolean;
		mismatches: string[];
		checked: number;
	} {
		const mismatches: string[] = [];
		let checked = 0;
		const entries: Array<[string, TreeEntry]> = onlyPaths
			? onlyPaths.filter((p) => p in tree).map((p) => [p, tree[p]])
			: Object.entries(tree);
		for (const [relPath, entry] of entries) {
			checked++;
			const full = this.safeHostPath(relPath);
			try {
				const stat = fs.lstatSync(full);
				if (entry.type === "symlink") {
					if (!stat.isSymbolicLink() || fs.readlinkSync(full) !== entry.symlinkTarget) {
						mismatches.push(`${relPath}: symlink mismatch`);
					}
				} else if (!stat.isFile()) {
					mismatches.push(`${relPath}: not a regular file`);
				} else {
					const buf = fs.readFileSync(full);
					const header = Buffer.from(`blob ${buf.byteLength}\0`, "utf-8");
					const actualId = crypto
						.createHash("sha256")
						.update(header)
						.update(buf)
						.digest("hex");
					if (actualId !== entry.objectId) mismatches.push(`${relPath}: content mismatch`);
				}
			} catch {
				mismatches.push(`${relPath}: missing or unreadable`);
			}
			if (mismatches.length >= 50) break;
		}
		return { matches: mismatches.length === 0, mismatches, checked };
	}

	/** Verify that the host working tree still matches a published LayerFS layer. */
	public verifyHostMatchesLayer(layerId?: string): {
		matches: boolean;
		mismatches: string[];
		checked: number;
		layerId: string;
	} {
		const meta = this.loadMeta();
		const id = layerId ?? meta.headLayerId;
		if (!id) return { matches: true, mismatches: [], checked: 0, layerId: "" };
		const result = this.verifyHostMatchesTree(this.loadLayer(id).tree);
		return { ...result, layerId: id };
	}

	public getHeadLayerId(): string {
		return this.loadMeta().headLayerId;
	}

	public getProjectId(): string {
		return this.projectId;
	}

	/** A store must never be applied to a different host working tree. */
	private assertStoreMatchesSource(meta: StoreMetadata): void {
		if (meta.sourceRoot && meta.sourceRoot !== this.sourceRoot) {
			throw new Error(
				`LayerFS store ${this.metaPath} belongs to ${meta.sourceRoot}; refusing to use it from ${this.sourceRoot}.`,
			);
		}
	}

	public getLayerTree(layerId: string): TreeManifest {
		return this.loadLayer(layerId).tree;
	}

	/**
	 * One-click rollback of the LAST published layer: restores the host pre-image
	 * captured before the delta was applied and resets the store head to the parent.
	 */
	public rollbackPublishedLayer(layerId?: string): {
		ok: boolean;
		restoredLayerId?: string;
		hostMatchesLayer?: boolean;
		message: string;
	} {
		const meta = this.loadMeta();
		const target = layerId ?? meta.headLayerId;
		if (!target) return { ok: false, message: "No published layer to roll back." };
		if (target !== meta.headLayerId) {
			return {
				ok: false,
				message: `Cannot roll back ${target}: it is not the head layer (${meta.headLayerId}). Only the latest layer can be rolled back.`,
			};
		}
		const snapshot = this.loadHostSnapshot(target);
		if (!snapshot) {
			return {
				ok: false,
				message: `No host pre-image snapshot found for ${target}; refusing to roll back blindly.`,
			};
		}
		const layer = this.loadLayer(target);
		if (!layer.parentLayerId) {
			return { ok: false, message: `Layer ${target} has no parent layer; refusing to roll back.` };
		}
		this.restoreHostSnapshot(snapshot);
		meta.headLayerId = layer.parentLayerId;
		this.saveMeta(meta);
		const verification = this.verifyHostMatchesLayer(meta.headLayerId);
		return {
			ok: true,
			restoredLayerId: meta.headLayerId,
			hostMatchesLayer: verification.matches,
			message:
				`Rolled back layer ${target}: host restored from pre-image snapshot, head is now ${meta.headLayerId}. ` +
				`The rolled-back layer stays in the store for audit.`,
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
			headLayerId: meta.headLayerId,
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
