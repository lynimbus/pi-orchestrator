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
import { isTestFilePath, matchesAnyPattern } from "./path-patterns.ts";
import type {
	BranchDiffResult,
	FileChangeEntry,
	MergeConflictItem,
	StoreMetrics,
	WaveMergeResult,
} from "./types.ts";
import { ensureScratchDirs, SCRATCH_DIR_NAMES } from "./workspace-env.ts";

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
	size?: number;
	symlinkTarget?: string;
}

/**
 * Nanosecond-resolution fingerprint of one host path, used to prove that a file's
 * bytes are unchanged without reading them back from disk.
 */
export interface StatCacheEntry {
	dev: string;
	ino: string;
	size: number;
	mode: number;
	mtimeNs: string;
	ctimeNs: string;
	objectId: string;
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

/** Contributor name used when direct host working-tree edits are merged into a wave */
export const HOST_CONTRIBUTOR = "<host>";

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

/** Directories never imported into LayerFS canonical store or workspaces.
 * `.tmp` / `.cache` are NOT repeated here: they are spread from `SCRATCH_DIR_NAMES`,
 * the single source of truth for the scratch-directory convention. */
const IGNORED_DIRS = new Set([
	".git",
	".jj",
	".hg",
	".svn",
	...SCRATCH_DIR_NAMES,
	".layerfs-orch",
]);

/** Upper bound on reported host mismatches (a drifted host can mismatch thousands of paths). */
const MAX_HOST_MISMATCHES = 50;

function isSecretFileName(name: string): boolean {
	if (name === ".env" || (name.startsWith(".env.") && !name.endsWith(".example") && !name.endsWith(".sample") && !name.endsWith(".template"))) {
		return true;
	}
	if (name === "id_rsa" || name === "id_ed25519" || name === "id_ecdsa") return true;
	if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12")) return true;
	return false;
}

export class LayerFSEngine {
	private readonly storeRoot: string;
	private readonly objectsDir: string;
	private readonly layersDir: string;
	private readonly commitsDir: string;
	private readonly workspacesDir: string;
	private readonly snapshotsDir: string;
	private readonly statCachePath: string;
	private readonly metaPath: string;
	private readonly projectId: string;
	private readonly sourceRoot: string;

	private statCache?: Map<string, StatCacheEntry>;
	private statCacheDirty = false;

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
		this.statCachePath = path.join(this.storeRoot, "stat-cache.json");
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

	public hasCanonicalBlob(objectId: string): boolean {
		if (!objectId) return false;
		try {
			return fs.statSync(this.objectPath(objectId)).isFile();
		} catch {
			return false;
		}
	}

	// Nanosecond stat cache (issue 7)
	//
	// Re-reading every host file just to prove it is unchanged makes full-tree
	// verification O(bytes). Linux bumps `ctime`/`mtime` (with ns resolution) on any
	// write, so remembering {dev, ino, size, mode, mtimeNs, ctimeNs} -> objectId lets
	// us reuse the canonical ObjectId without touching the file contents. Calling
	// `lstatSync` after a write also sets I_CTIME_QUERIED on the inode, guaranteeing
	// later modifications advance the timestamps we compare against.

	private getStatCache(): Map<string, StatCacheEntry> {
		if (this.statCache) return this.statCache;
		const cache = new Map<string, StatCacheEntry>();
		try {
			if (fs.existsSync(this.statCachePath)) {
				const parsed = JSON.parse(fs.readFileSync(this.statCachePath, "utf-8")) as Record<
					string,
					StatCacheEntry
				>;
				for (const [relPath, entry] of Object.entries(parsed ?? {})) {
					if (
						entry &&
						typeof entry.objectId === "string" &&
						typeof entry.mtimeNs === "string" &&
						typeof entry.ctimeNs === "string"
					) {
						cache.set(relPath, entry);
					}
				}
			}
		} catch {
			// A missing/corrupt cache simply means "re-read from disk".
		}
		this.statCache = cache;
		return cache;
	}

	private persistStatCache(): void {
		if (!this.statCache || !this.statCacheDirty) return;
		const serialized: Record<string, StatCacheEntry> = {};
		for (const [relPath, entry] of this.statCache) serialized[relPath] = entry;
		this.statCacheDirty = false;
		try {
			this.atomicWriteJson(this.statCachePath, serialized);
		} catch {
			// The cache is only an optimization: never fail an operation because of it.
		}
	}

	private static fingerprint(stat: fs.BigIntStats): {
		dev: string;
		ino: string;
		size: number;
		mode: number;
		mtimeNs: string;
		ctimeNs: string;
	} {
		return {
			dev: stat.dev.toString(),
			ino: stat.ino.toString(),
			size: Number(stat.size),
			mode: Number(stat.mode),
			mtimeNs: stat.mtimeNs.toString(),
			ctimeNs: stat.ctimeNs.toString(),
		};
	}

	private statCacheHit(relPath: string, stat: fs.BigIntStats): StatCacheEntry | undefined {
		const cached = this.getStatCache().get(relPath);
		if (!cached) return undefined;
		const fp = LayerFSEngine.fingerprint(stat);
		if (
			cached.dev !== fp.dev ||
			cached.ino !== fp.ino ||
			cached.size !== fp.size ||
			cached.mode !== fp.mode ||
			cached.mtimeNs !== fp.mtimeNs ||
			cached.ctimeNs !== fp.ctimeNs
		) {
			return undefined;
		}
		return cached;
	}

	private updateStatCache(relPath: string, stat: fs.BigIntStats, objectId: string): void {
		const fp = LayerFSEngine.fingerprint(stat);
		this.getStatCache().set(relPath, { ...fp, objectId });
		this.statCacheDirty = true;
	}

	private deleteStatCacheEntry(relPath: string): void {
		if (this.getStatCache().delete(relPath)) this.statCacheDirty = true;
	}

	/**
	 * Re-reads the host fingerprint AFTER a write/restore. The `lstatSync` call is
	 * intentional: it marks the inode as queried so a later external modification is
	 * guaranteed to advance mtime/ctime and therefore invalidate this cache entry.
	 */
	private refreshStatCacheFromHost(relPath: string, objectId?: string): void {
		try {
			const stat = fs.lstatSync(this.safeHostPath(relPath), { bigint: true });
			if (!objectId || !stat.isFile()) {
				this.deleteStatCacheEntry(relPath);
				return;
			}
			this.updateStatCache(relPath, stat, objectId);
		} catch {
			this.deleteStatCacheEntry(relPath);
		}
	}

	private scanTree(rootDir: string, meta: StoreMetadata): TreeManifest {
		const manifest: TreeManifest = {};
		// The stat cache is only meaningful for the host working tree; workspace scans
		// use the same relPaths but a different root, so they must never pollute it.
		const cacheEnabled = path.resolve(rootDir) === this.sourceRoot;

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
					if (cacheEnabled) this.deleteStatCacheEntry(relPath);
				} else if (lstat.isDirectory()) {
					walk(fullPath, relPath);
				} else if (lstat.isFile()) {
					const statBig = (() => {
						try {
							return fs.lstatSync(fullPath, { bigint: true });
						} catch {
							return undefined;
						}
					})();
					if (!statBig) continue;
					if (cacheEnabled) {
						const cached = this.statCacheHit(relPath, statBig);
						if (cached && this.hasCanonicalBlob(cached.objectId)) {
							manifest[relPath] = {
								type: "file",
								objectId: cached.objectId,
								mode: (Number(statBig.mode) & 0o111) !== 0 ? 0o755 : 0o644,
								size: Number(statBig.size),
							};
							continue;
						}
					}
					const buf = fs.readFileSync(fullPath);
					const objectId = this.writeCanonicalBlob(buf, meta);
					const executable = (lstat.mode & 0o111) !== 0;
					manifest[relPath] = {
						type: "file",
						objectId,
						mode: executable ? 0o755 : 0o644,
						size: buf.byteLength,
					};
					if (cacheEnabled) {
						// Fingerprint AFTER reading: queried atime/ctime must not point at a
						// pre-read inode state, otherwise a concurrent write would be masked.
						this.refreshStatCacheFromHost(relPath, objectId);
					}
				}
			}
		};

		walk(rootDir, "");
		if (cacheEnabled) this.persistStatCache();
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
		let parentTree: TreeManifest | undefined;
		if (parentLayerId) {
			parentTree = this.loadLayer(parentLayerId).tree;
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

		// A host import is itself a host mutation (the layer records what the host
		// became). Persist the pre-image of every path that differs from the parent
		// layer so `rollbackPublishedLayer` can restore the host to the parent tree.
		if (parentLayerId && parentTree) {
			this.saveHostSnapshot(
				this.captureTreeDiffSnapshot(layerId, parentLayerId, parentTree, tree),
			);
		}

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

		if (fs.existsSync(wsRoot)) {
			fs.rmSync(wsRoot, { recursive: true, force: true });
		}
		fs.mkdirSync(wsRoot, { recursive: true });
		const { tmpDir, cacheDir } = ensureScratchDirs(wsRoot);

		for (const [relPath, entry] of Object.entries(commit.tree)) {
			const destPath = path.join(wsRoot, relPath);
			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
				try {
					fs.symlinkSync(entry.symlinkTarget, destPath);
				} catch {
					// A dangling target is not fatal: the projected file still exists as a link.
				}
			} else {
				const buf = this.readCanonicalBlob(entry.objectId);
				fs.writeFileSync(destPath, buf, { mode: entry.mode });
			}
		}

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
							// A failed link only costs disk space, it must not fail the mount.
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
			/** Merge direct host working-tree edits as an extra `<host>` contributor. */
			includeHostEdits?: boolean;
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
		const noop = (): WaveMergeResult => ({
			ok: true,
			publishedLayerId: meta.headLayerId,
			baseLayerId: meta.headLayerId,
			hostMatchesLayer: true,
			hostMismatches: [],
			mergedFiles: [],
			conflicts: [],
			storeMetrics: this.getMetrics(),
		});

		if (branchNames.length === 0 && !options.includeHostEdits) {
			return noop();
		}

		const baseLayerId = meta.headLayerId;
		if (options.expectedBaseLayerId && options.expectedBaseLayerId !== baseLayerId) {
			return refusal(
				`Refusing to merge: plan expected base layer ${options.expectedBaseLayerId}, but the store head is ${baseLayerId}. ` +
					`This wave was most likely already integrated. Use orch_retry_integration (tests only), orch_rollback_integration, or /orch reset.`,
			);
		}
		if (!baseLayerId) {
			// No base layer yet: nothing to merge against (a host scan would create L1).
			return noop();
		}
		const baseLayer = this.loadLayer(baseLayerId);
		const mergedTree: TreeManifest = { ...baseLayer.tree };
		/** Paths explicitly deleted by a branch (relative to its OWN fork base) */
		const explicitDeletions = new Set<string>();

		const pathTouchMap = new Map<
			string,
			Array<{
				branchName: string;
				entry: TreeEntry | undefined;
			}>
		>();

		interface WaveContributor {
			name: string;
			/** Snapshot the contributor started from (fork base / wave base) */
			forkBaseTree: TreeManifest;
			/** Full snapshot the contributor wants to publish */
			headTree: TreeManifest;
		}
		const contributors: WaveContributor[] = [];

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
			contributors.push({
				name: branchName,
				forkBaseTree,
				headTree: headCommit.tree,
			});
		}

		// Direct host edits are just another contributor: they are diffed against the
		// wave base layer and then flow through the exact same 3-way tree/line merge, so
		// disjoint edits converge, identical edits dedupe, and conflicts are reported.
		if (options.includeHostEdits) {
			const hostTree = this.scanTree(this.sourceRoot, meta);
			contributors.push({ name: HOST_CONTRIBUTOR, forkBaseTree: baseLayer.tree, headTree: hostTree });
		}

		for (const contributor of contributors) {
			const candidatePaths = new Set<string>([
				...Object.keys(contributor.forkBaseTree),
				...Object.keys(contributor.headTree),
			]);

			for (const relPath of candidatePaths) {
				const forkEntry = contributor.forkBaseTree[relPath];
				const nextEntry = contributor.headTree[relPath];
				// `objectId` only hashes file CONTENT bytes, so a branch that only flips the
				// executable bit or rewrites a symlink target must still count as a touch.
				if (
					forkEntry &&
					nextEntry &&
					forkEntry.objectId === nextEntry.objectId &&
					forkEntry.mode === nextEntry.mode &&
					forkEntry.type === nextEntry.type &&
					forkEntry.symlinkTarget === nextEntry.symlinkTarget
				) {
					continue;
				}
				if (!forkEntry && !nextEntry) continue;

				const list = pathTouchMap.get(relPath) ?? [];
				list.push({ branchName: contributor.name, entry: nextEntry });
				pathTouchMap.set(relPath, list);
				if (forkEntry && !nextEntry) explicitDeletions.add(relPath);
			}
		}

		if (pathTouchMap.size === 0) {
			return noop();
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

			const uniqueObjectIds = new Set(touches.map((t) => t.entry?.objectId ?? "DELETED"));
			if (uniqueObjectIds.size === 1) {
				const firstEntry = touches[0].entry;
				if (!firstEntry) {
					delete mergedTree[relPath];
					mergedFiles.push({
						path: relPath,
						changeType: "deleted",
						fromBranches: touches.map((t) => t.branchName),
					});
				} else {
					mergedTree[relPath] = { ...firstEntry, mode: resolveMergedMode(baseEntry, touches) };
					mergedFiles.push({
						path: relPath,
						changeType: baseEntry ? "modified" : "added",
						fromBranches: touches.map((t) => t.branchName),
					});
				}
				continue;
			}

			const allRegularFiles =
				Boolean(baseEntry && baseEntry.type === "file") &&
				touches.every((t) => t.entry && t.entry.type === "file");

			if (options.allowAutoThreeWayLineMerge && allRegularFiles && baseEntry) {
				const baseText = this.readTextSafe(baseEntry.objectId);
				// Merge every branch hunk directly against `baseText` (never against an
				// already-merged intermediate text) so the result is order independent.
				const mergeAttempt = multiWayMergeText(
					baseText,
					touches.map((t) => this.readTextSafe(t.entry!.objectId)),
				);

				if (mergeAttempt.ok) {
					const mergedBuf = Buffer.from(mergeAttempt.mergedText, "utf-8");
					const newObjectId = this.writeCanonicalBlob(mergedBuf, meta);
					mergedTree[relPath] = {
						type: "file",
						objectId: newObjectId,
						mode: resolveMergedMode(baseEntry, touches),
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
					conflictPreview: mergeAttempt.conflictPreview || "Overlapping line edits",
				});
				continue;
			}

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
		// tree must have been explicitly deleted by a branch. Stale-branch replays (a
		// wave merged again after its Layer was published) and any layer that would
		// otherwise shrink the tree are refused here.
		const unexplainedDeletions = Object.keys(baseLayer.tree).filter(
			(relPath) => !(relPath in mergedTree) && !explicitDeletions.has(relPath),
		);
		if (unexplainedDeletions.length > 0) {
			return refusal(
				`Refusing to publish a layer that drops ${unexplainedDeletions.length} file(s) without an explicit branch deletion: ` +
					`${unexplainedDeletions.slice(0, 20).join(", ")}${unexplainedDeletions.length > 20 ? ", ..." : ""}`,
			);
		}

		meta.layerSequence += 1;
		const newLayerId = `L${meta.layerSequence}`;
		const contributorNames = contributors.map((c) => c.name);

		// A merged tree that shrinks the file count is legal (explicit deletions) but
		// always worth flagging: host edits merged in by `includeHostEdits` can delete
		// files just as easily as a stale branch replay can drop them.
		const baseFileCount = Object.keys(baseLayer.tree).length;
		const mergedFileCount = Object.keys(mergedTree).length;
		let treeRegressionWarning: string | undefined;
		if (mergedFileCount < baseFileCount) {
			const dropped = Object.keys(baseLayer.tree).filter((p) => !(p in mergedTree));
			treeRegressionWarning =
				`Wave merge drops ${dropped.length} file(s) relative to parent layer ${baseLayerId}: ` +
				`${dropped.slice(0, 20).join(", ")}${dropped.length > 20 ? ", ..." : ""}. ` +
				`These paths were removed by an explicit branch/host deletion; verify that this is intended.`;
		}

		const newLayer: LayerRecord = {
			layerId: newLayerId,
			parentLayerId: baseLayerId,
			createdAt: Date.now(),
			message: options.message,
			tree: mergedTree,
			treeRegressionWarning,
		};

		// Capture the ACTUAL host pre-image BEFORE touching anything. This is what a
		// mid-apply failure restores, so it must include direct host edits (they would be
		// lost if we restored the base tree instead).
		const preApplySnapshot = this.captureHostSnapshot(
			newLayerId,
			baseLayerId,
			contributorNames,
			mergedFiles,
			meta,
		);

		// Persisted rollback snapshot: rolling back the published layer must restore the
		// host completely to the BASE layer, so a tree diff (not the current host state)
		// is persisted whenever direct host edits were folded into the wave.
		let persistedSnapshot: HostSnapshotRecord = preApplySnapshot;
		if (options.includeHostEdits) {
			persistedSnapshot = this.captureTreeDiffSnapshot(newLayerId, baseLayerId, baseLayer.tree, mergedTree);
			persistedSnapshot.branchNames = contributorNames;
		}
		this.saveHostSnapshot(persistedSnapshot);

		let hostVerification = { matches: true, mismatches: [] as string[], checked: 0 };
		let hostDrift: string[] = [];
		try {
			this.applyDeltaToHost(mergedFiles, mergedTree);
			if (options.verifyHost !== false) {
				// Strictly verify the paths this wave actually applied (always read from
				// disk, no stat-cache shortcut, so a half-written file is caught). Unrelated
				// host edits (e.g. direct escalated lead edits re-imported afterwards) are
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
				// Full-tree drift check: served from the stat cache for unchanged files.
				hostDrift = this.verifyHostMatchesTree(mergedTree).mismatches;
			}
		} catch (err) {
			this.restoreHostSnapshot(preApplySnapshot);
			return refusal(
				`Failed to apply/verify merged tree on host: ${err instanceof Error ? err.message : String(err)}. ` +
					`The host working tree was restored from the snapshot and NO layer was published.`,
			);
		}

		// Only publish once the host has been verified: a published layer is always
		// consistent with the host working tree.
		this.saveLayer(newLayer);
		meta.headLayerId = newLayerId;

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
			treeRegressionWarning,
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

	/**
	 * Captures the pre-image of every path that differs between two trees, using the
	 * parent tree as the source of truth. Restoring such a record reverts the host to
	 * `parentTree` for exactly those paths (used by host imports and host-edit merges).
	 */
	private captureTreeDiffSnapshot(
		layerId: string,
		parentLayerId: string,
		parentTree: TreeManifest,
		nextTree: TreeManifest,
	): HostSnapshotRecord {
		const files: Record<string, HostSnapshotEntry> = {};
		const allPaths = new Set<string>([...Object.keys(parentTree), ...Object.keys(nextTree)]);
		for (const relPath of allPaths) {
			const prev = parentTree[relPath];
			const next = nextTree[relPath];
			if (!prev && !next) continue;
			// ObjectId is the authenticated content id, so equal ids mean identical bytes.
			if (prev && next && prev.objectId === next.objectId && prev.type === next.type) continue;
			if (prev) {
				files[relPath] = {
					existed: true,
					type: prev.type,
					objectId: prev.objectId,
					mode: prev.mode,
					size: prev.size,
					symlinkTarget: prev.symlinkTarget,
				};
			} else {
				files[relPath] = { existed: false };
			}
		}
		return { layerId, parentLayerId, branchNames: [], createdAt: Date.now(), files };
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
			if (!entry.existed) {
				this.deleteStatCacheEntry(relPath);
				continue;
			}
			fs.mkdirSync(path.dirname(full), { recursive: true });
			if (entry.type === "symlink" && entry.symlinkTarget !== undefined) {
				fs.symlinkSync(entry.symlinkTarget, full);
				// Symlink bytes are content-addressed too, but the snapshot has no objectId here.
				this.deleteStatCacheEntry(relPath);
			} else if (entry.type === "directory") {
				fs.mkdirSync(full, { recursive: true });
				this.deleteStatCacheEntry(relPath);
			} else if (entry.type === "file" && entry.objectId) {
				fs.writeFileSync(full, this.readCanonicalBlob(entry.objectId));
				if (entry.mode !== undefined) fs.chmodSync(full, entry.mode & 0o7777);
				this.refreshStatCacheFromHost(relPath, entry.objectId);
			}
		}
		this.persistStatCache();
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
				this.deleteStatCacheEntry(item.path);
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
				this.deleteStatCacheEntry(item.path);
			} else {
				const buf = this.readCanonicalBlob(entry.objectId);
				fs.writeFileSync(hostFilePath, buf, { mode: entry.mode });
				fs.chmodSync(hostFilePath, entry.mode & 0o7777);
				// lstat AFTER the write: marks the inode as queried so any later external
				// modification is guaranteed to advance mtime/ctime and bust the cache.
				this.refreshStatCacheFromHost(item.path, entry.objectId);
			}
		}
		this.persistStatCache();
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
		// An explicit path list is a strict post-apply verification: those paths are
		// ALWAYS re-read from disk. A full-tree check (hostDrift / verifyHostMatchesLayer)
		// may skip unchanged files via the stat cache (issue 7).
		const strictPaths = Boolean(onlyPaths);
		const paths = onlyPaths ? Array.from(new Set(onlyPaths)) : Object.keys(tree);

		for (const relPath of paths) {
			checked++;
			const mismatch = this.verifyOneHostPath(relPath, tree[relPath], strictPaths);
			if (mismatch) mismatches.push(mismatch);
			if (mismatches.length >= MAX_HOST_MISMATCHES) break;
		}
		this.persistStatCache();
		return { matches: mismatches.length === 0, mismatches, checked };
	}

	/**
	 * Verify ONE host path against its expected tree entry.
	 *
	 * Returns the mismatch message (`undefined` when the host matches) instead of pushing it
	 * into a shared list, so `verifyHostMatchesTree` owns the single reporting cap. All
	 * stat-cache side effects of a per-path check stay in here.
	 */
	private verifyOneHostPath(
		relPath: string,
		entry: TreeEntry | undefined,
		strictPaths: boolean,
	): string | undefined {
		const full = this.safeHostPath(relPath);

		if (!entry) {
			let present = true;
			try {
				fs.lstatSync(full, { bigint: true });
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code;
				present = !(code === "ENOENT" || code === "ENOTDIR");
			}
			if (present) return `${relPath}: expected deleted file to be absent`;
			this.deleteStatCacheEntry(relPath);
			return undefined;
		}

		const stat = (() => {
			try {
				return fs.lstatSync(full, { bigint: true });
			} catch {
				return undefined;
			}
		})();
		if (!stat) {
			this.deleteStatCacheEntry(relPath);
			return `${relPath}: missing or unreadable`;
		}

		if (entry.type === "symlink") {
			let ok = false;
			try {
				ok = stat.isSymbolicLink() && fs.readlinkSync(full) === entry.symlinkTarget;
			} catch {
				ok = false;
			}
			if (!ok) {
				this.deleteStatCacheEntry(relPath);
				return `${relPath}: symlink mismatch`;
			}
			this.updateStatCache(relPath, stat, entry.objectId);
			return undefined;
		}

		if (!stat.isFile()) {
			this.deleteStatCacheEntry(relPath);
			return `${relPath}: not a regular file`;
		}

		if (!strictPaths) {
			const cached = this.statCacheHit(relPath, stat);
			if (cached && this.hasCanonicalBlob(cached.objectId)) {
				if (cached.objectId !== entry.objectId) return `${relPath}: content mismatch`;
				return undefined;
			}
		}

		const actualId = (() => {
			try {
				const buf = fs.readFileSync(full);
				const header = Buffer.from(`blob ${buf.byteLength}\0`, "utf-8");
				return crypto.createHash("sha256").update(header).update(buf).digest("hex");
			} catch {
				return undefined;
			}
		})();
		if (actualId === undefined) {
			this.deleteStatCacheEntry(relPath);
			return `${relPath}: missing or unreadable`;
		}
		// Fingerprint AFTER the read so the cached stat can never predate the bytes.
		this.refreshStatCacheFromHost(relPath, actualId);
		if (actualId !== entry.objectId) return `${relPath}: content mismatch`;
		return undefined;
	}

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
	 * One-click rollback of published layer(s): restores the host pre-image snapshots
	 * and resets the store head to the target parent layer.
	 *
	 * - `rollbackPublishedLayer()` / `rollbackPublishedLayer("L3")` rolls back the head layer.
	 * - `rollbackPublishedLayer("L3", { targetParentLayerId: "L1" })` atomically rolls back
	 *   the whole L3 -> L2 -> L1 chain (every layer must have a persisted snapshot).
	 */
	public rollbackPublishedLayer(
		layerId?: string,
		options?: { targetParentLayerId?: string },
	): {
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

		const headLayer = this.loadLayer(target);
		const targetParentLayerId = options?.targetParentLayerId ?? headLayer.parentLayerId;
		if (!targetParentLayerId) {
			return { ok: false, message: `Layer ${target} has no parent layer; refusing to roll back.` };
		}
		if (!headLayer.parentLayerId) {
			return { ok: false, message: `Layer ${target} has no parent layer; refusing to roll back.` };
		}

		// Validate the WHOLE chain (parent + persisted pre-image snapshot, target parent
		// reachable) BEFORE touching the host, so a failure cannot half-rollback the tree.
		type RollbackStep = { layer: LayerRecord; snapshot: HostSnapshotRecord };
		const chain: RollbackStep[] = [];
		const seen = new Set<string>();
		let current: LayerRecord = headLayer;
		for (;;) {
			if (seen.has(current.layerId)) {
				return {
					ok: false,
					message: `Layer parent chain from ${target} is cyclic at ${current.layerId}; refusing to roll back.`,
				};
			}
			seen.add(current.layerId);
			if (!current.parentLayerId) {
				return {
					ok: false,
					message: `Layer ${current.layerId} has no parent layer; refusing to roll back.`,
				};
			}
			const snapshot = this.loadHostSnapshot(current.layerId);
			if (!snapshot) {
				return {
					ok: false,
					message: `No host pre-image snapshot found for ${current.layerId}; refusing to roll back blindly.`,
				};
			}
			chain.push({ layer: current, snapshot });
			if (current.parentLayerId === targetParentLayerId) break;
			if (current.parentLayerId === current.layerId) {
				return { ok: false, message: `Layer ${current.layerId} is its own parent; refusing to roll back.` };
			}
			try {
				current = this.loadLayer(current.parentLayerId);
			} catch {
				return {
					ok: false,
					message: `Layer parent chain from ${target} is broken at ${current.parentLayerId}; refusing to roll back.`,
				};
			}
		}
		try {
			this.loadLayer(targetParentLayerId);
		} catch {
			return {
				ok: false,
				message: `Target parent layer ${targetParentLayerId} does not exist; refusing to roll back.`,
			};
		}

		// Apply restoreHostSnapshot from the head downwards (reverse chronological).
		try {
			for (const step of chain) {
				this.restoreHostSnapshot(step.snapshot);
			}
		} catch (err) {
			return {
				ok: false,
				message:
					`Restoring host snapshots for ${chain.map((s) => s.layer.layerId).join(" -> ")} failed: ` +
					`${err instanceof Error ? err.message : String(err)}. The store head was left unchanged at ${meta.headLayerId}.`,
			};
		}

		meta.headLayerId = targetParentLayerId;
		this.saveMeta(meta);
		const verification = this.verifyHostMatchesLayer(targetParentLayerId);
		const rolledBack = chain.map((s) => s.layer.layerId);
		return {
			ok: true,
			restoredLayerId: targetParentLayerId,
			hostMatchesLayer: verification.matches,
			message:
				chain.length === 1
					? `Rolled back layer ${rolledBack[0]}: host restored from pre-image snapshot, head is now ${targetParentLayerId}. ` +
						`The rolled-back layer stays in the store for audit.`
					: `Rolled back layers ${rolledBack.join(" -> ")}: host restored from pre-image snapshots, head is now ${targetParentLayerId}. ` +
						`The rolled-back layers stay in the store for audit.`,
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
		if (buf.includes(0)) {
			return `[Binary file: ${buf.byteLength} bytes, ObjectId=${objectId.slice(0, 12)}]`;
		}
		return buf.toString("utf-8");
	}
}

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
 * Resolve the merged `mode` when several branches touch the same path.
 *
 * `objectId` only covers the content bytes, so a branch that only flips the executable
 * bit (`0o644` -> `0o755`) shares the base objectId with every other branch touch. The
 * mode therefore has to be merged separately from the content.
 */
function resolveMergedMode(
	baseEntry: TreeEntry | undefined,
	touches: Array<{ entry: TreeEntry | undefined }>,
): number {
	const entries = touches
		.map((t) => t.entry)
		.filter((entry): entry is TreeEntry => Boolean(entry));
	if (entries.length === 0) return baseEntry?.mode ?? 0o100644;

	if (baseEntry && entries.some((entry) => entry.mode !== baseEntry.mode)) {
		// An executable bit is safe to converge on.
		const executable = entries.find((entry) => entry.mode === 0o755);
		return executable ? executable.mode : entries[0].mode;
	}
	return entries[0].mode;
}

/**
 * Deterministic N-way text merge for disjoint hunks relative to `baseText`.
 *
 * Every branch is diffed DIRECTLY against `baseText` and all hunks are combined in one
 * pass. Re-diffing an already merged intermediate text against the base (the old
 * pairwise fold) misidentifies unchanged lines and corrupts hunk boundaries as soon as
 * three branches edit the same file, making the merge order dependent.
 */
function multiWayMergeText(
	baseText: string,
	branchTexts: string[],
): { ok: boolean; mergedText: string; conflictPreview?: string } {
	const distinct: string[] = [];
	for (const text of branchTexts) {
		if (text === baseText) continue;
		if (distinct.includes(text)) continue;
		distinct.push(text);
	}

	if (distinct.length === 0) return { ok: true, mergedText: baseText };
	if (distinct.length === 1) return { ok: true, mergedText: distinct[0] };

	const baseLines = baseText.split("\n");
	const combined: Array<PatchHunk & { branchIndex: number }> = [];
	distinct.forEach((text, branchIndex) => {
		for (const hunk of extractHunks(baseLines, text.split("\n"))) {
			combined.push({ ...hunk, branchIndex });
		}
	});

	combined.sort(
		(a, b) =>
			a.baseStart - b.baseStart ||
			a.baseEnd - b.baseEnd ||
			a.replacement.join("\n").localeCompare(b.replacement.join("\n")),
	);

	const mergedHunks: Array<PatchHunk & { branchIndex: number }> = [];
	for (const curr of combined) {
		if (mergedHunks.length === 0) {
			mergedHunks.push(curr);
			continue;
		}
		const prev = mergedHunks[mergedHunks.length - 1];

		const identical =
			curr.baseStart === prev.baseStart &&
			curr.baseEnd === prev.baseEnd &&
			curr.replacement.length === prev.replacement.length &&
			curr.replacement.every((line, idx) => line === prev.replacement[idx]);
		if (identical) continue;

		// A pure insertion immediately BEFORE a modified/deleted range does not overlap:
		// the insertion's baseEnd equals the other hunk's baseStart, so applying the
		// insertion first then the replacement is unambiguous.
		const overlaps =
			curr.baseStart < prev.baseEnd ||
			(curr.baseStart === prev.baseStart && curr.baseEnd === prev.baseEnd);

		if (overlaps) {
			return {
				ok: false,
				mergedText: "",
				conflictPreview: [
					`<<<<<<< branch ${prev.branchIndex + 1} (lines ${prev.baseStart + 1}-${prev.baseEnd})`,
					prev.replacement.join("\n"),
					"=======",
					curr.replacement.join("\n"),
					`>>>>>>> branch ${curr.branchIndex + 1} (lines ${curr.baseStart + 1}-${curr.baseEnd})`,
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
