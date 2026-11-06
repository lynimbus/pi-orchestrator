/**
 * Workspace scratch-directory conventions for the orchestrator.
 *
 * Every LayerFS workspace (and the host workspace used by integration tests)
 * gets a private `<root>/.tmp` + `<root>/.cache` pair that is bound to
 * TMPDIR/TMP/TEMP and XDG_CACHE_HOME so npm, mktemp, pytest, cargo, ... never
 * write into the commit-captured tree.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ScratchDirs {
	tmpDir: string;
	cacheDir: string;
}

/**
 * The ONE definition of the scratch-directory names.
 *
 * Two consumers depend on these exact names and MUST NOT hard-code them again:
 * - `scratchDirs()` below (the paths bound to TMPDIR / XDG_CACHE_HOME);
 * - `IGNORED_DIRS` in layerfs-engine.ts (the directories a host import never captures).
 *
 * Renaming a scratch dir here therefore moves the convention and the import exclusion
 * together -- they can no longer drift apart.
 */
export const SCRATCH_DIR_NAMES = [".tmp", ".cache"] as const;

export function scratchDirs(root: string): ScratchDirs {
	return {
		tmpDir: path.join(root, SCRATCH_DIR_NAMES[0]),
		cacheDir: path.join(root, SCRATCH_DIR_NAMES[1]),
	};
}

/**
 * The scratch directory handed to TMPDIR/XDG_CACHE_HOME MUST exist and be writable.
 * LayerFS workspaces create it, but the host workspace used by integration tests does
 * not -- which used to make plain `mktemp` fail with a bogus ENOENT.
 */
function ensureDir(preferred: string, label: string): string {
	try {
		fs.mkdirSync(preferred, { recursive: true });
		fs.accessSync(preferred, fs.constants.W_OK);
		return preferred;
	} catch {
		return fs.mkdtempSync(path.join(os.tmpdir(), `orch-${label}-`));
	}
}

export function ensureScratchDirs(root: string): ScratchDirs {
	const dirs = scratchDirs(root);
	return {
		tmpDir: ensureDir(dirs.tmpDir, "tmp"),
		cacheDir: ensureDir(dirs.cacheDir, "cache"),
	};
}

/**
 * Environment overrides for a scratch pair. `CI=1` is intentionally NOT included:
 * that stays a caller policy (verifier/reporting may run without it).
 */
export function scratchEnvironment(dirs: ScratchDirs): Record<string, string> {
	return {
		TMPDIR: dirs.tmpDir,
		TMP: dirs.tmpDir,
		TEMP: dirs.tmpDir,
		XDG_CACHE_HOME: dirs.cacheDir,
	};
}
