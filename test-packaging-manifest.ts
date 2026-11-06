/**
 * Packaging-manifest tests for the distributable Pi git package.
 *
 * The extension is no longer hand-copied into ~/.pi/agent/extensions/orchestrator;
 * it is installed straight from GitHub with:
 *
 *   pi install git:github.com/lynimbus/pi-orchestrator
 *
 * These tests guard the package.json manifest that makes that possible, plus the
 * cross-file contract that `scripts.test` registers every suite of this repo.
 *
 * Run with: node ./test-packaging-manifest.ts
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_SUITE_COMMANDS } from "./suite-contract.ts";
import { createSyncTestRunner } from "./test-kit.ts";

const runner = createSyncTestRunner();
const testCase = runner.testCase;

/** Positive assertions go through `assert.ok` directly: no pass-through wrapper. */

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

function repoPath(relPath: string): string {
	return path.join(repoRoot, relPath);
}

function readRepoFile(relPath: string): string {
	return fs.readFileSync(repoPath(relPath), "utf-8");
}

const pkg = JSON.parse(readRepoFile("package.json")) as {
	name?: unknown;
	version?: unknown;
	description?: unknown;
	type?: unknown;
	license?: unknown;
	main?: unknown;
	repository?: unknown;
	scripts?: Record<string, unknown>;
	pi?: Record<string, unknown>;
	keywords?: unknown;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	files?: unknown;
};

/** The keywords that must keep working (Pi gallery discovery + existing semantics). */
const REQUIRED_KEYWORDS = [
	"pi",
	"pi-package",
	"orchestrator",
	"subagent",
	"tdd",
	"layerfs",
];

/**
 * Collects every declared resource path in the `pi` manifest, including nested
 * arrays/objects, so a stale or misspelled path fails the suite instead of
 * silently producing a package that does nothing when installed.
 */
function collectPiResourcePaths(value: unknown, trail: string, out: string[]): void {
	if (typeof value === "string") {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((entry, index) => collectPiResourcePaths(entry, `${trail}[${index}]`, out));
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			collectPiResourcePaths(entry, trail ? `${trail}.${key}` : key, out);
		}
	}
}

function packageJsonTests(): void {
	console.log("package.json manifest");

	testCase("required: package.json parses and declares name/type/main", () => {
		const raw = readRepoFile("package.json");
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(raw) as Record<string, unknown>;
		} catch (err) {
			assert.fail(
				`package.json must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		assert.equal(
			parsed.name,
			"pi-orchestrator",
			`package.json name must be "pi-orchestrator" (actual: ${JSON.stringify(parsed.name)})`,
		);
		assert.equal(
			parsed.type,
			"module",
			`package.json type must be "module" (actual: ${JSON.stringify(parsed.type)})`,
		);
		assert.equal(
			parsed.main,
			"./index.ts",
			`package.json main must be "./index.ts" (actual: ${JSON.stringify(parsed.main)})`,
		);
	});

	testCase("required: package keeps version and license for distribution", () => {
		assert.equal(
			typeof pkg.version,
			"string",
			`package.json version must be a string (actual: ${JSON.stringify(pkg.version)})`,
		);
		assert.match(
			String(pkg.version),
			/^\d+\.\d+\.\d+/,
			`package.json version must be semver-ish (actual: ${JSON.stringify(pkg.version)})`,
		);
		assert.equal(
			pkg.license,
			"MIT",
			`package.json license must be "MIT" (actual: ${JSON.stringify(pkg.license)})`,
		);
	});

	testCase("required: pi manifest is registered with the package entry point", () => {
		const pi = pkg.pi;
		assert.ok(
			pi && typeof pi === "object",
			`package.json "pi" manifest must be an object (actual: ${JSON.stringify(pi)})`,
		);
		const extensions = pi.extensions;
		assert.ok(
			Array.isArray(extensions),
			`pi.extensions must be an array (actual: ${JSON.stringify(extensions)})`,
		);
		assert.ok(
			(extensions as unknown[]).includes("./index.ts"),
			`pi.extensions must contain "./index.ts" (actual: ${JSON.stringify(extensions)})`,
		);
		assert.ok(
			fs.existsSync(repoPath("./index.ts")),
			'declared extension path "./index.ts" must exist in the repo root',
		);
	});

	testCase("required: every path declared in the pi manifest exists", () => {
		const declared: string[] = [];
		collectPiResourcePaths(pkg.pi, "pi", declared);
		assert.ok(
			declared.length > 0,
			`pi manifest must declare at least one resource path (actual: ${JSON.stringify(pkg.pi)})`,
		);
		const missing = declared.filter((relPath) => !fs.existsSync(repoPath(relPath)));
		assert.deepEqual(
			missing,
			[],
			`pi manifest declares paths that do not exist in the repo: ${JSON.stringify(missing)} (declared: ${JSON.stringify(declared)})`,
		);
	});

	testCase("required: pi.skills stays undeclared (skills live in project .agents/skills)", () => {
		const pi = (pkg.pi ?? {}) as Record<string, unknown>;
		assert.equal(
			pi.skills,
			undefined,
			`pi.skills must be undefined to avoid clashing with project-level skills (actual: ${JSON.stringify(pi.skills)})`,
		);
		assert.ok(
			!Object.prototype.hasOwnProperty.call(pi, "skills"),
			'pi manifest must not declare a "skills" key at all',
		);
	});

	testCase("required: keywords advertise pi-package and keep the semantic tags", () => {
		assert.ok(
			Array.isArray(pkg.keywords),
			`package.json keywords must be an array (actual: ${JSON.stringify(pkg.keywords)})`,
		);
		const keywords = pkg.keywords as unknown[];
		assert.ok(
			keywords.includes("pi-package"),
			`keywords must include "pi-package" for Pi gallery discovery (actual: ${JSON.stringify(keywords)})`,
		);
		const missing = REQUIRED_KEYWORDS.filter((keyword) => !keywords.includes(keyword));
		assert.deepEqual(
			missing,
			[],
			`keywords are missing semantic tags: ${JSON.stringify(missing)} (actual: ${JSON.stringify(keywords)})`,
		);
	});

	testCase("required: repository points at the GitHub distribution source", () => {
		const repository = pkg.repository;
		assert.ok(
			repository && typeof repository === "object",
			`package.json repository must be an object (actual: ${JSON.stringify(repository)})`,
		);
		const repo = repository as Record<string, unknown>;
		assert.equal(
			repo.type,
			"git",
			`repository.type must be "git" (actual: ${JSON.stringify(repo.type)})`,
		);
		assert.equal(
			typeof repo.url,
			"string",
			`repository.url must be a string (actual: ${JSON.stringify(repo.url)})`,
		);
		assert.match(
			String(repo.url),
			/github\.com[:/]lynimbus\/pi-orchestrator(\.git)?$/,
			`repository.url must address github.com/lynimbus/pi-orchestrator (actual: ${JSON.stringify(repo.url)})`,
		);
	});

	testCase("required: no host-provided @earendil-works/* package is declared as a dependency", () => {
		const deps = Object.keys(pkg.dependencies ?? {});
		const devDeps = Object.keys(pkg.devDependencies ?? {});
		const forbidden = [...deps, ...devDeps].filter((name) => name.startsWith("@earendil-works/"));
		assert.deepEqual(
			forbidden,
			[],
			`host-provided packages must never be declared in dependencies/devDependencies: ${JSON.stringify(forbidden)}`,
		);
		assert.doesNotMatch(
			readRepoFile("package.json"),
			/@earendil-works\//,
			"package.json must not mention any @earendil-works/* package at all",
		);
	});

	testCase("required: no files field (avoids npm packing exclusions)", () => {
		assert.equal(
			"files" in pkg,
			false,
			`package.json must not declare "files" (actual: ${JSON.stringify(pkg.files)})`,
		);
	});

	testCase("required: description explains the Pi git package and the orchestration role", () => {
		const description = String(pkg.description ?? "");
		assert.notEqual(description.trim(), "", "package.json description must not be empty");
		assert.match(
			description,
			/pi install git:github\.com\/lynimbus\/pi-orchestrator/,
			`description must state the install source (actual: ${JSON.stringify(description)})`,
		);
		assert.match(
			description,
			/pi\s+git\s+package|pi-package/i,
			`description must say it is a Pi git package (actual: ${JSON.stringify(description)})`,
		);
		assert.match(
			description,
			/orchestrat/i,
			`description must keep the orchestration semantics (actual: ${JSON.stringify(description)})`,
		);
	});

	testCase("required: scripts.test registers every suite with exact && chaining", () => {
		const scripts = pkg.scripts ?? {};
		const script = scripts.test;
		assert.equal(
			typeof script,
			"string",
			`scripts.test must be a string (actual: ${JSON.stringify(script)})`,
		);
		const parts = String(script)
			.split("&&")
			.map((part) => part.trim())
			.filter(Boolean);
		assert.deepEqual(
			parts,
			[...TEST_SUITE_COMMANDS],
			`scripts.test must chain every registered suite in TEST_SUITE_COMMANDS order (actual: ${JSON.stringify(script)})`,
		);
		assert.equal(
			parts.length,
			6,
			`scripts.test must chain exactly six suites (actual: ${String(parts.length)})`,
		);
		assert.ok(
			parts.includes("node ./test-primitives.ts"),
			"scripts.test must run node ./test-primitives.ts",
		);
	});
}

packageJsonTests();

runner.finish();
