/**
 * Unit tests for the worker CLI construction, the persisted worker session
 * (session-dir / session-id / resume) and the PI_CACHE_RETENTION spawn env.
 *
 * Scope of the contract under test:
 * - `buildWorkerCliArgs(taskId, sessionDir, opts)` is a PURE function: it never
 *   touches `fs` or `process`, and it returns the complete pi CLI argument array
 *   WITHOUT the trailing prompt positional (the caller pushes that last).
 * - `--no-session` must be gone; `--session-dir` + `--session-id worker-<taskId>`
 *   replace it, so attempt #2 reuses the same jsonl session without any extra
 *   resume flag (pi restores a session by id automatically).
 * - The spawn env carries `PI_CACHE_RETENTION` = options.cacheRetention
 *   ?? process.env.PI_ORCHESTRATOR_CACHE_RETENTION ?? "short", and omits the
 *   variable entirely when that resolved value is empty.
 * - `workerSessionFile` is written to the task runtime state when the session
 *   jsonl exists, and left `undefined` (never a throw) when it does not.
 *
 * Every assertion observes a runtime outcome for the CLI/env/session-file
 * contracts; the wiring section below reads file text only where the contract
 * IS the file text (package.json, README, the ignore list).
 *
 * Also pins the repo-wide worker-session wiring:
 *
 * 1. `IGNORED_DIRS` in `layerfs-engine.ts` treats `sessions/` exactly like the
 *    scratch dirs (`.tmp` / `.cache`): `commitWorkspace` never captures it, and
 *    `importHostAsLayer` never imports a host `sessions/`, while ordinary files
 *    keep being captured. Without this, worker transcripts would be merged into
 *    every published layer and leak into the host tree.
 * 2. `suite-contract.ts` is the single source for the suite chain: seven stages,
 *    with `node ./test-worker-session.ts` immediately before `node ./test-primitives.ts`
 *    (the shared-primitive stage stays last).
 * 3. `package.json` `scripts.test` and the README `## 测试` section both follow
 *    that single source, and the README no longer claims the chain is six stages.
 *
 * Run directly: `node ./test-worker-session.ts`
 */

import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	attachWorkerSessionFile,
	buildWorkerCliArgs,
	buildWorkerSpawnEnv,
	resolveCacheRetention,
	resolveWorkerSessionFile,
	workerSessionDir,
	workerSessionId,
} from "./subagent-runner.ts";
import type { TaskRuntimeState } from "./types.ts";
import { fileURLToPath } from "node:url";
import { LayerFSEngine } from "./layerfs-engine.ts";
import { TEST_SUITE_COMMANDS } from "./suite-contract.ts";
import { createAsyncTestRunner } from "./test-kit.ts";

const runner = createAsyncTestRunner();
const testCase = runner.testCase;

const SESSION_ID = "worker-t5";

function tmpRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `pi-orch-${prefix}-`));
}

function makeState(overrides: Partial<TaskRuntimeState> = {}): TaskRuntimeState {
	return {
		id: "t5",
		wave: 0,
		status: "running",
		attempts: 1,
		branchName: "task-t5",
		reviewHistory: [],
		usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 },
		...overrides,
	};
}

function baseCliArgs(): { args: string[]; sessionDir: string } {
	return buildWorkerCliArgs("t5", "/ws/task-t5/sessions", {});
}

async function spawnCacheProbe(env: Record<string, string>): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["-e", "process.stdout.write(String(process.env.PI_CACHE_RETENTION ?? '<unset>'))"],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code !== 0) {
				reject(new Error(`probe exited ${code}: ${stderr}`));
				return;
			}
			resolve(stdout);
		});
	});
}

// ---------------------------------------------------------------------------
// 1. buildWorkerCliArgs —— 纯函数 / session 参数
// ---------------------------------------------------------------------------

async function cliArgsTests(): Promise<void> {
	console.log("buildWorkerCliArgs（session 参数替换 --no-session）");

	await testCase(
		"args 含 --session-dir /ws/task-t5/sessions 与 --session-id worker-t5, 不含 --no-session",
		() => {
			const { args, sessionDir } = baseCliArgs();

			const dirFlagIndex = args.indexOf("--session-dir");
			assert.notEqual(dirFlagIndex, -1, "args must contain --session-dir");
			assert.equal(args[dirFlagIndex + 1], "/ws/task-t5/sessions");

			const idFlagIndex = args.indexOf("--session-id");
			assert.notEqual(idFlagIndex, -1, "args must contain --session-id");
			assert.equal(args[idFlagIndex + 1], "worker-t5");

			assert.equal(args.includes("--no-session"), false, "--no-session must be gone");
			assert.equal(args.includes("--resume"), false, "no extra resume flag is needed");
			assert.equal(args.includes("--continue"), false, "no extra resume flag is needed");
			assert.equal(sessionDir, "/ws/task-t5/sessions", "sessionDir is returned for mkdir + state");
		},
		"AC1: --no-session 换成 --session-dir / --session-id worker-<taskId>",
	);

	await testCase(
		"基础 pi 旗标保持完整（--mode json, -p, --tools）且无位置参数残留",
		() => {
			const { args } = baseCliArgs();

			assert.deepEqual(args.slice(0, 3), ["--mode", "json", "-p"]);
			const toolsIndex = args.indexOf("--tools");
			assert.notEqual(toolsIndex, -1);
			assert.equal(args[toolsIndex + 1], "read,write,edit,bash");

			// The prompt positional is the caller's job: everything in the array must
			// be either a flag or the value that directly follows a flag.
			const flagValues = new Set<string>();
			for (let i = 0; i < args.length; i += 1) {
				if (args[i].startsWith("-")) flagValues.add(args[i + 1] ?? "");
			}
			for (const arg of args) {
				assert.equal(arg.startsWith("-") || flagValues.has(arg), true, `unexpected positional: ${arg}`);
			}
		},
		"contract: args 是完整 CLI 数组（不含 prompt 位置参数）",
	);

	await testCase(
		"model + thinkingLevel 追加在末尾（prompt 位置参数之前）",
		() => {
			const { args } = buildWorkerCliArgs("t5", "/ws/task-t5/sessions", {
				model: "m/x",
				thinkingLevel: "high",
			});

			assert.deepEqual(args.slice(-4), ["--model", "m/x", "--thinking", "high"]);
			// …and the caller can still append the prompt positional last.
			const withPrompt = [...args, "PROMPT"];
			assert.equal(withPrompt[withPrompt.length - 1], "PROMPT");
		},
		"contract: args 末尾含 --model m/x 与 --thinking high",
	);

	await testCase("未配置 model / thinking 时不产生空旗标", () => {
		const { args } = baseCliArgs();
		assert.equal(args.includes("--model"), false);
		assert.equal(args.includes("--thinking"), false);
	});

	await testCase(
		"attempt #2 起复用同一 sessionDir 与 session-id, 无需额外恢复参数",
		() => {
			const first = buildWorkerCliArgs("t5", "/ws/task-t5/sessions", { model: "m/x" });
			const second = buildWorkerCliArgs("t5", "/ws/task-t5/sessions", { model: "m/x" });

			assert.deepEqual(second.args, first.args, "attempt #2 must be byte-identical");
			assert.equal(second.sessionDir, first.sessionDir);

			// Same session id, no resume-only flag bolted on for the retry.
			const idIndex = second.args.indexOf("--session-id");
			assert.equal(second.args[idIndex + 1], SESSION_ID);
			for (const flag of ["--resume", "--continue", "--session", "--no-session"]) {
				assert.equal(second.args.includes(flag), false, `attempt #2 must not add ${flag}`);
			}
			assert.equal(first.args.filter((a) => a === "--session-id").length, 1);
		},
		"AC2: attempt>1 复用同一 session，无需额外恢复参数",
	);

	await testCase("每次调用返回独立数组（不共享可变状态）", () => {
		const first = baseCliArgs();
		const second = baseCliArgs();
		assert.notEqual(first.args, second.args);
		first.args.push("MUTATED");
		assert.equal(second.args.includes("MUTATED"), false);
	});

	await testCase(
		"workerSessionDir: workspaces/<task>/root → workspaces/<task>/sessions",
		() => {
			const workspacePath = path.join("/ws", "workspaces", "task-t5", "root");
			assert.equal(workerSessionDir(workspacePath), path.join("/ws", "workspaces", "task-t5", "sessions"));

			const withTrailingSep = path.join("/ws", "workspaces", "task-t5", "root") + path.sep;
			assert.equal(
				workerSessionDir(withTrailingSep),
				path.join("/ws", "workspaces", "task-t5", "sessions"),
				"a trailing separator must not push the sessions dir one level deeper",
			);
		},
		"AC1: sessionDir = path.join(path.dirname(workspacePath), 'sessions')",
	);

	await testCase("workerSessionId 由 taskId 派生", () => {
		assert.equal(workerSessionId("t5"), "worker-t5");
		assert.equal(workerSessionId("T1"), "worker-T1");
	});
}

// ---------------------------------------------------------------------------
// 2. PI_CACHE_RETENTION —— spawn env
// ---------------------------------------------------------------------------

function spawnEnv(params: {
	cacheRetention?: string;
	baseEnv?: Record<string, string | undefined>;
}): Record<string, string> {
	return buildWorkerSpawnEnv({
		baseEnv: params.baseEnv ?? {},
		taskId: "t5",
		allowedCombined: ["subagent-runner.ts", "test-worker-session.ts"],
		forbidden: ["index.ts"],
		scratch: { TMPDIR: "/ws/task-t5/root/.tmp", XDG_CACHE_HOME: "/ws/task-t5/root/.cache" },
		cacheRetention: params.cacheRetention,
	});
}

async function cacheRetentionTests(): Promise<void> {
	console.log("PI_CACHE_RETENTION（spawn env）");

	await testCase(
		"默认路径（options 与 env 均未设置）→ PI_CACHE_RETENTION = short",
		() => {
			assert.equal(spawnEnv({}).PI_CACHE_RETENTION, "short");
		},
		"AC3: cacheRetention 默认 short",
	);

	await testCase(
		"显式设为 ''（空串）→ spawn env 不含 PI_CACHE_RETENTION 键",
		() => {
			const env = spawnEnv({ cacheRetention: "" });
			assert.equal(Object.prototype.hasOwnProperty.call(env, "PI_CACHE_RETENTION"), false);
			assert.equal(env.PI_CACHE_RETENTION, undefined);
		},
		"AC3: 空配置时不设置该变量",
	);

	await testCase("显式设为 'long' → 覆盖默认值", () => {
		assert.equal(spawnEnv({ cacheRetention: "long" }).PI_CACHE_RETENTION, "long");
	});

	await testCase("options 未设置时回落到 process.env.PI_ORCHESTRATOR_CACHE_RETENTION", () => {
		const env = spawnEnv({ baseEnv: { PI_ORCHESTRATOR_CACHE_RETENTION: "long" } });
		assert.equal(env.PI_CACHE_RETENTION, "long");
	});

	await testCase("options.cacheRetention 优先于 env 配置", () => {
		const env = spawnEnv({
			baseEnv: { PI_ORCHESTRATOR_CACHE_RETENTION: "long" },
			cacheRetention: "none",
		});
		assert.equal(env.PI_CACHE_RETENTION, "none");
	});

	await testCase("env 配置为空串时（`??` 语义）同样不设置该变量", () => {
		const env = spawnEnv({ baseEnv: { PI_ORCHESTRATOR_CACHE_RETENTION: "" } });
		assert.equal(
			Object.prototype.hasOwnProperty.call(env, "PI_CACHE_RETENTION"),
			false,
			"an explicitly empty env config resolves to an empty value and is therefore not set",
		);
		assert.equal(resolveCacheRetention(undefined, { PI_ORCHESTRATOR_CACHE_RETENTION: "" }), undefined);
	});

	await testCase("完全未配置时才回落到默认 short（与上面空串区分开）", () => {
		assert.equal(resolveCacheRetention(undefined, {}), "short");
		assert.equal(resolveCacheRetention(undefined, { PI_ORCHESTRATOR_CACHE_RETENTION: undefined }), "short");
	});

	await testCase("仅空白的配置视为未设置", () => {
		assert.equal(resolveCacheRetention("   ", {}), undefined);
		assert.equal(resolveCacheRetention(undefined, { PI_ORCHESTRATOR_CACHE_RETENTION: "  " }), undefined);
		assert.equal(resolveCacheRetention(" short ", {}), "short", "surrounding whitespace is trimmed");
	});

	await testCase(
		"env 保留 worker 身份变量、清理 undefined 且不修改入参",
		() => {
			const baseEnv: Record<string, string | undefined> = {
				PATH: "/usr/bin",
				PI_ORCHESTRATOR_CACHE_RETENTION: undefined,
			};
			const snapshot = { ...baseEnv };
			const env = spawnEnv({ baseEnv });

			assert.equal(env.PI_ORCHESTRATOR_WORKER, "1");
			assert.equal(env.PI_ORCHESTRATOR_TASK_ID, "t5");
			assert.equal(
				env.PI_ORCHESTRATOR_ALLOWED_FILES,
				JSON.stringify(["subagent-runner.ts", "test-worker-session.ts"]),
			);
			assert.equal(env.PI_ORCHESTRATOR_FORBIDDEN_FILES, JSON.stringify(["index.ts"]));
			assert.equal(env.TMPDIR, "/ws/task-t5/root/.tmp");
			assert.equal(env.XDG_CACHE_HOME, "/ws/task-t5/root/.cache");
			assert.equal(env.PATH, "/usr/bin");

			for (const [key, value] of Object.entries(env)) {
				assert.equal(typeof value, "string", `${key} must never reach spawn as undefined`);
			}
			assert.deepEqual(baseEnv, snapshot, "the caller's env object must not be mutated");
			assert.equal(Object.keys(env).includes("PI_ORCHESTRATOR_CACHE_RETENTION"), false);
		},
		"AC3: spawn env 结构 + 纯函数语义",
	);

	await testCase(
		"真实 spawn 子进程读到 PI_CACHE_RETENTION=short（默认路径）",
		async () => {
			const env = spawnEnv({ baseEnv: { PATH: process.env.PATH ?? "/usr/bin" } });
			assert.equal(await spawnCacheProbe(env), "short");
		},
		"AC3: spawn env 真的传给子进程",
	);

	await testCase(
		"真实 spawn 子进程在空配置下读不到该变量",
		async () => {
			const env = spawnEnv({
				baseEnv: { PATH: process.env.PATH ?? "/usr/bin" },
				cacheRetention: "",
			});
			assert.equal(await spawnCacheProbe(env), "<unset>");
		},
		"AC3: 空配置 → 变量不存在于子进程",
	);
}

// ---------------------------------------------------------------------------
// 3. workerSessionFile —— 落盘解析
// ---------------------------------------------------------------------------

async function sessionFileTests(): Promise<void> {
	console.log("workerSessionFile（session 落盘 → state）");

	await testCase(
		"sessionDir 下无任何 jsonl → attachWorkerSessionFile 返回 undefined 且不抛错",
		() => {
			const dir = path.join(tmpRoot("nojsonl"), "sessions");
			fs.mkdirSync(dir, { recursive: true });
			const state = makeState();

			assert.doesNotThrow(() => attachWorkerSessionFile(state, dir, "t5"));
			assert.equal(attachWorkerSessionFile(state, dir, "t5"), undefined);
			assert.equal(state.workerSessionFile, undefined);
		},
		"AC4: 不存在时为 undefined 且不抛错",
	);

	await testCase("sessionDir 不存在 → undefined 且不抛错", () => {
		const dir = path.join(tmpRoot("missing"), "sessions");
		assert.equal(fs.existsSync(dir), false);
		assert.doesNotThrow(() => resolveWorkerSessionFile(dir, "t5"));
		assert.equal(resolveWorkerSessionFile(dir, "t5"), undefined);
	});

	await testCase(
		"session 文件存在 → 写入 state.workerSessionFile",
		() => {
			const dir = path.join(tmpRoot("present"), "sessions");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `${SESSION_ID}.jsonl`);
			fs.writeFileSync(file, '{"type":"session"}\n');

			const state = makeState();
			assert.equal(attachWorkerSessionFile(state, dir, "t5"), file);
			assert.equal(state.workerSessionFile, file);
		},
		"AC4: 存在时写入 workerSessionFile",
	);

	await testCase(
		"多个候选时选择最新的一个（含子目录 / pi 的 `<ISO-timestamp>_<sessionId>.jsonl` 命名）",
		() => {
			const root = tmpRoot("latest");
			const dir = path.join(root, "sessions");
			const nested = path.join(dir, "2024-01-01");
			fs.mkdirSync(nested, { recursive: true });

			const older = path.join(dir, `${SESSION_ID}.jsonl`);
			// Exactly what pi's session-manager writes: ISO timestamp with ':' and '.'
			// replaced by '-', then `_<sessionId>.jsonl`.
			const newer = path.join(nested, `2024-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
			fs.writeFileSync(older, "{}\n");
			fs.writeFileSync(newer, "{}\n");
			const past = new Date(Date.now() - 60_000);
			fs.utimesSync(older, past, past);

			const state = makeState();
			attachWorkerSessionFile(state, dir, "t5");
			assert.equal(state.workerSessionFile, newer);
		},
		"AC4: 取最新 session 文件（兼容 pi 真实命名）",
	);

	await testCase(
		"其它任务的同前缀 session 不会误匹配，旧值被清理",
		() => {
			const dir = path.join(tmpRoot("prefixed"), "sessions");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "worker-t5-b.jsonl"), "{}\n");
			fs.writeFileSync(path.join(dir, "worker-t50.jsonl"), "{}\n");

			const state = makeState({ workerSessionFile: "/stale/path.jsonl" });
			attachWorkerSessionFile(state, dir, "t5");
			assert.equal(
				state.workerSessionFile,
				undefined,
				"a stale value must be cleared when this attempt has no session file yet",
			);
		},
		"AC4: 精确匹配 + 旧值清理",
	);

	await testCase(
		"attempt #1 落盘 → attempt #2 从同一 workspace 派生同一 sessionDir，指向同一 jsonl",
		() => {
			const root = tmpRoot("resume");
			const workspacePath = path.join(root, "workspaces", "task-t5", "root");
			fs.mkdirSync(workspacePath, { recursive: true });
			const dir = workerSessionDir(workspacePath);
			fs.mkdirSync(dir, { recursive: true });

			const first = buildWorkerCliArgs("t5", dir, {});
			const file = path.join(dir, `2024-03-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
			fs.writeFileSync(file, "{}\n");

			// attempt #2 re-derives the session dir from the (remounted) workspace path.
			assert.equal(workerSessionDir(workspacePath), first.sessionDir);
			const second = buildWorkerCliArgs("t5", workerSessionDir(workspacePath), {});
			assert.deepEqual(second.args, first.args, "no resume-specific flags on attempt #2");

			const state = makeState({ attempts: 2 });
			attachWorkerSessionFile(state, second.sessionDir, "t5");
			assert.equal(state.workerSessionFile, file);
			assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl")).length, 1);
		},
		"AC2 + AC4: attempt #2 复用同一 session 目录与 session 文件",
	);
}

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = HERE;

/** The stage this very file registers, and where it must sit in the chain. */
const SESSION_STAGE = "node ./test-worker-session.ts";
const SESSION_STAGE_INDEX = 5;
const EXPECTED_STAGE_COUNT = 7;

let counter = 0;
function nextProjectId(): string {
	counter += 1;
	return `orch-session-${process.pid}-${Date.now()}-${counter}`;
}

function makeHost(files: Record<string, string>): string {
	const host = fs.mkdtempSync(path.join(os.tmpdir(), "orch-session-host-"));
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(host, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	}
	return host;
}

const scratchPaths: string[] = [];
function trackHost(engine: LayerFSEngine, host: string): void {
	scratchPaths.push(host, engine.getMetrics().storeRoot);
}
function cleanup(): void {
	for (const p of scratchPaths) fs.rmSync(p, { recursive: true, force: true });
}

/** Reads a repo file as text; only used where the contract *is* the file's text. */
function readRepoFile(name: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, name), "utf-8");
}

/** Extracts the `## <title>` section body (up to the next `## ` heading). */
function readmeSection(title: string): string {
	const lines = readRepoFile("README.md").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === `## ${title}`);
	if (start === -1) throw new Error(`README.md 中找不到 \`## ${title}\` 小节`);
	const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
	return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

// ---------------------------------------------------------------------------
// suite-contract.ts: the single source of truth
// ---------------------------------------------------------------------------

async function suiteContractTests(): Promise<void> {
	console.log("suite-contract.ts single source");

	await testCase("TEST_SUITE_COMMANDS is a seven-stage chain", () => {
		assert.equal(
			TEST_SUITE_COMMANDS.length,
			EXPECTED_STAGE_COUNT,
			`TEST_SUITE_COMMANDS: expect ${EXPECTED_STAGE_COUNT} stages, actual ${TEST_SUITE_COMMANDS.length} (${TEST_SUITE_COMMANDS.join(" && ")})`,
		);
	});

	await testCase("the session stage sits at index 5, right before test-primitives", () => {
		assert.equal(
			TEST_SUITE_COMMANDS[SESSION_STAGE_INDEX],
			SESSION_STAGE,
			`TEST_SUITE_COMMANDS[${SESSION_STAGE_INDEX}]: expect \`${SESSION_STAGE}\`, actual \`${String(TEST_SUITE_COMMANDS[SESSION_STAGE_INDEX])}\``,
		);
		assert.equal(
			TEST_SUITE_COMMANDS[TEST_SUITE_COMMANDS.length - 1],
			"node ./test-primitives.ts",
			"test-primitives.ts must stay the LAST stage (shared primitives underpin every other suite)",
		);
	});

	await testCase("every stage is a unique `node ./test-*.ts` command", () => {
		const unique = new Set(TEST_SUITE_COMMANDS);
		assert.equal(
			unique.size,
			TEST_SUITE_COMMANDS.length,
			`TEST_SUITE_COMMANDS must not contain duplicates: ${TEST_SUITE_COMMANDS.join(" && ")}`,
		);
		for (const stage of TEST_SUITE_COMMANDS) {
			assert.match(
				stage,
				/^node \.\/test(-[a-z0-9-]+)?\.ts$/,
				`stage must be a node ./test-<name>.ts (or node ./test.ts) invocation, actual \`${stage}\``,
			);
		}
	});

	await testCase("the session stage file exists in the repo", () => {
		assert.ok(
			fs.existsSync(path.join(REPO_ROOT, "test-worker-session.ts")),
			`\`${SESSION_STAGE}\` is registered in TEST_SUITE_COMMANDS but test-worker-session.ts does not exist`,
		);
	});

	await testCase("package.json scripts.test chains TEST_SUITE_COMMANDS verbatim (seven stages)", () => {
		const pkg = JSON.parse(readRepoFile("package.json")) as {
			scripts?: Record<string, string>;
		};
		const script = pkg.scripts?.test;
		assert.equal(
			typeof script,
			"string",
			`package.json scripts.test must be a string, actual ${JSON.stringify(script)}`,
		);
		const parts = String(script)
			.split("&&")
			.map((part) => part.trim())
			.filter(Boolean);
		assert.deepEqual(
			parts,
			[...TEST_SUITE_COMMANDS],
			`package.json scripts.test must mirror TEST_SUITE_COMMANDS, actual: ${JSON.stringify(script)}`,
		);
		assert.equal(
			parts.length,
			EXPECTED_STAGE_COUNT,
			`package.json scripts.test must chain exactly ${EXPECTED_STAGE_COUNT} suites, actual ${String(parts.length)}`,
		);
		assert.ok(
			parts.includes(SESSION_STAGE),
			`package.json scripts.test must run \`${SESSION_STAGE}\` so the new stage is actually verified by \`npm test\``,
		);
	});
}

// ---------------------------------------------------------------------------
// README contract: the docs must not drift from the single source
// ---------------------------------------------------------------------------

async function readmeContractTests(): Promise<void> {
	console.log("README `## 测试` contract");

	await testCase("`## 测试` lists `- node ./test-worker-session.ts` as a stage", () => {
		const testing = readmeSection("测试");
		assert.ok(
			testing.includes(`- \`${SESSION_STAGE}\``),
			`\`## 测试\` must list \`- \\\`${SESSION_STAGE}\\\`\`; section was:\n${testing}`,
		);
	});

	await testCase("`## 测试` claims a seven-stage chain and no longer claims six", () => {
		const testing = readmeSection("测试");
		assert.ok(testing.includes("七段链"), `\`## 测试\` must say 七段链 (seven-stage chain); section was:\n${testing}`);
		assert.ok(!testing.includes("六段链"), "`## 测试` must not keep the stale 六段链 (six-stage) wording");
		assert.ok(
			!readRepoFile("README.md").includes("六段链"),
			"README.md must not mention 六段链 anywhere: the chain is seven stages now",
		);
	});

	await testCase("both npm test comments equal TEST_SUITE_COMMANDS.join(' && ')", () => {
		const expected = TEST_SUITE_COMMANDS.join(" && ");
		for (const title of ["本地开发", "测试"]) {
			assert.ok(
				readmeSection(title).includes(expected),
				`\`## ${title}\` npm test comment must contain the full seven-stage chain: ${expected}`,
			);
		}
	});

	await testCase("`## 测试` coverage notes the session stage", () => {
		const testing = readmeSection("测试");
		assert.ok(
			testing.includes("test-worker-session"),
			`\`## 测试\` coverage notes must mention test-worker-session; section was:\n${testing}`,
		);
	});
}

// ---------------------------------------------------------------------------
// IGNORED_DIRS: `sessions/` must never be captured by a workspace commit
// ---------------------------------------------------------------------------

async function ignoredDirsSourceTests(): Promise<void> {
	console.log("layerfs-engine.ts IGNORED_DIRS");

	await testCase("IGNORED_DIRS declares 'sessions' with a purpose comment", () => {
		const source = readRepoFile("layerfs-engine.ts");
		const start = source.indexOf("const IGNORED_DIRS = new Set([");
		assert.notEqual(start, -1, "layerfs-engine.ts must declare `const IGNORED_DIRS = new Set([`");
		const end = source.indexOf("]);", start);
		assert.notEqual(end, -1, "IGNORED_DIRS declaration must be terminated by `]);`");
		const block = source.slice(start, end);

		const sessionEntries = block.match(/"sessions"/g) ?? [];
		assert.ok(
			sessionEntries.length >= 1,
			`IGNORED_DIRS must contain the literal "sessions" entry; block was:\n${block}`,
		);

		// The entry needs a rationale, in the same style as the SCRATCH_DIR_NAMES note,
		// otherwise the next reader deletes it as an accident.
		const docCommentStart = source.lastIndexOf("/**", start);
		const docComment = docCommentStart === -1 ? "" : source.slice(docCommentStart, start);
		assert.ok(
			/sessions/.test(docComment),
			`the doc comment above IGNORED_DIRS must explain why \`sessions\` is ignored; comment was:\n${docComment}`,
		);
		assert.ok(
			/worker|subagent|transcript|session|会话/i.test(docComment),
			`the doc comment must say the directory is engine-owned worker-session storage; comment was:\n${docComment}`,
		);
	});
}

async function ignoredDirsBehaviorTests(): Promise<void> {
	console.log("commitWorkspace skips sessions/");

	await testCase("commitWorkspace skips the workspace sessions dir like .tmp/.cache", () => {
		const host = makeHost({ "a.txt": "a\n" });
		const engine = new LayerFSEngine(host, nextProjectId());
		trackHost(engine, host);

		const layer = engine.importHostAsLayer("Initial import");
		const branch = engine.forkBranch("task-sessions", layer.layerId);
		const ws = engine.mountWorkspace(branch.branchName);

		// Worker transcripts land next to the workspace root, exactly like the
		// scratch dirs the engine already owns.
		fs.mkdirSync(path.join(ws.workspacePath, "sessions", "task-t1"), { recursive: true });
		fs.writeFileSync(
			path.join(ws.workspacePath, "sessions", "task-t1", "events.jsonl"),
			'{"type":"message"}\n',
			"utf-8",
		);
		fs.writeFileSync(path.join(ws.workspacePath, "sessions", "index.json"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(ws.workspacePath, ".tmp", "scratch.txt"), "tmp\n", "utf-8");
		fs.writeFileSync(path.join(ws.workspacePath, ".cache", "cache.txt"), "cache\n", "utf-8");
		fs.writeFileSync(path.join(ws.workspacePath, "b.txt"), "b\n", "utf-8");

		const commit = engine.commitWorkspace(branch.branchName, "work with sessions");
		const captured = Object.keys(commit.tree).sort();

		assert.ok(
			!captured.some((p) => p === "sessions" || p.startsWith("sessions/")),
			`commitWorkspace must NOT capture sessions/; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			!captured.some((p) => p.startsWith(".tmp/") || p.startsWith(".cache/")),
			`commitWorkspace must NOT capture .tmp/.cache either; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			captured.includes("b.txt"),
			`commitWorkspace must still capture ordinary files; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			captured.includes("a.txt"),
			`the imported file must survive the commit; captured: ${captured.join(", ")}`,
		);
	});

	await testCase("sessions is skipped at any depth but a lookalike name is not", () => {
		const host = makeHost({ "pkg/keep.txt": "keep\n" });
		const engine = new LayerFSEngine(host, nextProjectId());
		trackHost(engine, host);

		const layer = engine.importHostAsLayer("Initial import");
		const branch = engine.forkBranch("task-nested", layer.layerId);
		const ws = engine.mountWorkspace(branch.branchName);

		fs.mkdirSync(path.join(ws.workspacePath, "pkg", "sessions"), { recursive: true });
		fs.writeFileSync(path.join(ws.workspacePath, "pkg", "sessions", "nested.jsonl"), "{}\n", "utf-8");
		fs.writeFileSync(path.join(ws.workspacePath, "pkg", "sessions-archive.txt"), "keep me\n", "utf-8");
		fs.mkdirSync(path.join(ws.workspacePath, "sessions-backup"), { recursive: true });
		fs.writeFileSync(path.join(ws.workspacePath, "sessions-backup", "old.jsonl"), "{}\n", "utf-8");

		const commit = engine.commitWorkspace(branch.branchName, "nested sessions");
		const captured = Object.keys(commit.tree).sort();

		assert.ok(
			!captured.some((p) => p.split("/").includes("sessions")),
			`a nested \`sessions\` directory must be skipped too; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			captured.includes("pkg/sessions-archive.txt"),
			`the ignore list matches directory names exactly: \`sessions-archive.txt\` must be captured; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			captured.some((p) => p.startsWith("sessions-backup/")),
			`the ignore list matches directory names exactly: \`sessions-backup/\` must be captured; captured: ${captured.join(", ")}`,
		);
	});

	await testCase("importHostAsLayer never imports a host sessions dir", () => {
		const host = makeHost({
			"a.txt": "a\n",
			"sessions/host-session.jsonl": '{"type":"host"}\n',
		});
		const engine = new LayerFSEngine(host, nextProjectId());
		trackHost(engine, host);

		const layer = engine.importHostAsLayer("Initial import");
		const captured = Object.keys(layer.tree).sort();

		assert.ok(
			layer.tree["a.txt"],
			`ordinary host files must still be imported; captured: ${captured.join(", ")}`,
		);
		assert.ok(
			!captured.some((p) => p === "sessions" || p.startsWith("sessions/")),
			`host \`sessions/\` must not be imported into the canonical store; captured: ${captured.join(", ")}`,
		);
	});
}

async function main(): Promise<void> {
	await cliArgsTests();
	await cacheRetentionTests();
	await sessionFileTests();
	await suiteContractTests();
	await readmeContractTests();
	await ignoredDirsSourceTests();
	await ignoredDirsBehaviorTests();
	cleanup();
	runner.finish();
}

await main();
