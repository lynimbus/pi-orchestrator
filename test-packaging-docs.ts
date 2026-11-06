/**
 * Packaging documentation contract tests.
 *
 * Reads README.md as plain text and asserts that the install / update /
 * migration / local-development narrative is present, that the legacy
 * `~/.pi/agent/extensions/orchestrator` copy only ever shows up in a
 * migration / backup / rollback context, and that none of the pre-existing
 * feature documentation was dropped.
 *
 * Run directly: `node ./test-packaging-docs.ts`
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_SUITE_COMMANDS } from "./suite-contract.ts";
import { createSyncTestRunner } from "./test-kit.ts";

const runner = createSyncTestRunner();

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(HERE, "README.md");

/** The exact `&&`-chained command line that `npm test` must document. */
const SIX_STAGE_CHAIN = TEST_SUITE_COMMANDS.join(" && ");

const LEGACY_PATH = "~/.pi/agent/extensions/orchestrator";
const GIT_PACKAGE = "git:github.com/lynimbus/pi-orchestrator";

let readme: string;
try {
	readme = fs.readFileSync(README_PATH, "utf-8");
} catch (err) {
	console.error(`无法读取 README.md（${README_PATH}）：${(err as Error).message}`);
	process.exit(1);
}

const lines: string[] = readme.split(/\r?\n/);

interface TestCase {
	name: string;
	run: () => void;
}

const tests: TestCase[] = [];

function test(name: string, run: () => void): void {
	tests.push({ name, run });
}

function expectIncludes(haystack: string, needle: string, label: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`${label}：期望包含 \`${needle}\`，实际缺失（README.md 中未找到该字符串）`);
	}
}

function expectNotIncludes(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle)) {
		throw new Error(`${label}：期望不包含 \`${needle}\`，实际却出现了（README.md 第 ${findLineNumber(needle)} 行）`);
	}
}

function readRepoFile(relPath: string): string {
	const abs = path.join(HERE, relPath);
	try {
		return fs.readFileSync(abs, "utf-8");
	} catch (err) {
		throw new Error(`无法读取 ${relPath}（${abs}）：${(err as Error).message}`);
	}
}

function findLineNumber(needle: string): number {
	const idx = lines.findIndex((line) => line.includes(needle));
	return idx < 0 ? -1 : idx + 1;
}

function getSection(title: string): string {
	const start = lines.findIndex((line) => line.startsWith(`## ${title}`));
	if (start < 0) {
		throw new Error(`小节标题：期望包含 \`## ${title}\`，实际缺失`);
	}
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^##\s/.test(line));
	const body = end < 0 ? rest : rest.slice(0, end);
	return body.join("\n");
}

const RESTART_CONTEXT_KEYWORDS = ["重启", "/reload"];

test(
	"首行标题为 `# Pi Orchestrator` 且不含旧本地路径",
	() => {
		const first = (lines[0] ?? "").trimEnd();
		if (!first.startsWith("# Pi Orchestrator")) {
			throw new Error(`首行标题：期望以 \`# Pi Orchestrator\` 开头，实际为 \`${first}\``);
		}
		expectNotIncludes(first, LEGACY_PATH, "首行标题");
		expectNotIncludes(first, "# Pi Orchestrator (", "首行标题");
	},
);

test(
	"包含云端安装命令 `pi install git:github.com/lynimbus/pi-orchestrator`",
	() => {
		expectIncludes(readme, `pi install ${GIT_PACKAGE}`, "安装命令");
	},
);

test(
	"安装节给出 SSH 备选命令与 settings.json packages 说明",
	() => {
		expectIncludes(readme, "pi install git:git@github.com:lynimbus/pi-orchestrator", "SSH 备选安装命令");
		const install = getSection("安装");
		expectIncludes(install, `pi install ${GIT_PACKAGE}`, "`## 安装` 小节");
		expectIncludes(install, "pi install git:git@github.com:lynimbus/pi-orchestrator", "`## 安装` 小节 SSH 备选");
		expectIncludes(install, "~/.pi/agent/settings.json", "`## 安装` 小节声明写入位置");
		expectIncludes(install, "packages", "`## 安装` 小节 packages 字段");
		expectIncludes(install, "/reload", "`## 安装` 小节重启/热加载说明");
	},
);

test(
	"包含更新命令 `pi update git:...` 与 `pi update --extensions`",
	() => {
		expectIncludes(readme, `pi update ${GIT_PACKAGE}`, "更新命令");
		expectIncludes(readme, "pi update --extensions", "全量更新命令");
		const update = getSection("更新");
		expectIncludes(update, `pi update ${GIT_PACKAGE}`, "`## 更新` 小节");
		expectIncludes(update, "pi update --extensions", "`## 更新` 小节全量更新");
		expectIncludes(update, "pi list", "`## 更新` 小节查看已装包");
		for (const keyword of RESTART_CONTEXT_KEYWORDS) {
			expectIncludes(update, keyword, "`## 更新` 小节生效说明");
		}
	},
);

test(
	"更新节说明 git 包按仓库 URL 标识且 `@<ref>` 固定版本不被移动",
	() => {
		const update = getSection("更新");
		expectIncludes(update, "@<ref>", "`## 更新` 小节固定版本语法");
		expectIncludes(update, "仓库 URL", "`## 更新` 小节身份标识说明");
		expectIncludes(update, "固定版本", "`## 更新` 小节固定版本说明");
	},
);

test(
	"同时包含 `## 安装` `## 更新` `## 从本地目录副本迁移` `## 本地开发` 四个小节",
	() => {
		for (const title of ["## 安装", "## 更新", "## 从本地目录副本迁移", "## 本地开发"]) {
			expectIncludes(readme, title, "小节标题");
		}
		// migration section may carry a parenthesised suffix
		const hasMigrateHeading = lines.some((line) => /^## 从本地目录副本迁移(（.*）)?\s*$/.test(line));
		if (!hasMigrateHeading) {
			throw new Error("小节标题：期望包含独立成行的 `## 从本地目录副本迁移`（可带括号说明），实际缺失");
		}
	},
);

test(
	"迁移节包含备份/移除/校验/回滚命令且禁止本地拷贝与 git 包共存",
	() => {
		const migrate = getSection("从本地目录副本迁移");
		expectIncludes(migrate, "mkdir -p ~/.pi/agent/extensions/.backup", "`## 从本地目录副本迁移` 备份目录");
		expectIncludes(migrate, "tar -czf", "`## 从本地目录副本迁移` 打包备份");
		expectIncludes(migrate, "~/.pi/agent/extensions/.backup", "`## 从本地目录副本迁移` 备份路径");
		expectIncludes(migrate, "rm -rf ~/.pi/agent/extensions/orchestrator", "`## 从本地目录副本迁移` 移除本地拷贝");
		expectIncludes(migrate, "tar -xzf", "`## 从本地目录副本迁移` 回滚解包");
		expectIncludes(migrate, "pi list", "`## 从本地目录副本迁移` 校验已装包");
		expectIncludes(migrate, "pi remove git:github.com/lynimbus/pi-orchestrator", "`## 从本地目录副本迁移` 回滚时卸载 git 包");
		expectIncludes(migrate, "/reload", "`## 从本地目录副本迁移` 重启/热加载");
		expectIncludes(migrate, "/orch status", "`## 从本地目录副本迁移` 校验命令");
		expectIncludes(migrate, "同名扩展", "`## 从本地目录副本迁移` 共存风险说明（同名扩展）");
		expectIncludes(migrate, "加载歧义", "`## 从本地目录副本迁移` 共存风险说明（加载歧义）");
		expectIncludes(
			migrate,
			"可能触发同名扩展重复加载或加载歧义",
			"`## 从本地目录副本迁移` 共存风险的谨慎表述",
		);
	},
);

test(
	"迁移节的共存风险是可验证的谨慎表述，不把运行时行为写成必然断言",
	() => {
		const migrate = getSection("从本地目录副本迁移");
		// 必须写明包身份去重的三类标识，以及本地副本与 git 包是两条不同来源
		expectIncludes(migrate, "包身份去重", "`## 从本地目录副本迁移` 包身份去重说明");
		for (const identity of ["npm 包名", "git 仓库 URL", "本地绝对路径"]) {
			expectIncludes(migrate, identity, "`## 从本地目录副本迁移` 包身份标识");
		}
		expectIncludes(migrate, "两条不同来源", "`## 从本地目录副本迁移` 来源区分说明");
		// 风险句必须带可能性限定词，且显式声明对运行时行为不做断言
		expectIncludes(migrate, "可能触发", "`## 从本地目录副本迁移` 风险可能性限定");
		expectIncludes(migrate, "不做断言", "`## 从本地目录副本迁移` 对未验证运行时行为的声明");
		// 禁止把未验证的加载行为写成必然结论
		const forbiddenClaims = ["会导致同名扩展被重复加载", "必然导致", "一定会导致", "肯定会导致", "因此迁移结束后必须只保留 git 包"];
		for (const claim of forbiddenClaims) {
			if (migrate.includes(claim)) {
				throw new Error(
					`\`## 从本地目录副本迁移\` 谨慎表述：期望不包含 \`${claim}\`（未验证的必然结论），实际却出现了（README.md 第 ${findLineNumber(claim)} 行）`,
				);
			}
		}
	},
);

test(
	"`## 本地开发` 与 `## 测试` 的 npm test 注释同步为六段链",
	() => {
		const sixStage = SIX_STAGE_CHAIN;
		expectIncludes(getSection("本地开发"), sixStage, "`## 本地开发` npm test 六段链注释");
		expectIncludes(getSection("测试"), sixStage, "`## 测试` npm test 六段链注释");
		// 源码中不存在只写三段的 npm test 注释
		const commented = lines.filter((line) => /npm test\s+#/.test(line));
		if (commented.length === 0) {
			throw new Error("npm test 注释：期望至少有一行 `npm test    # ...` 形式的分阶段注释，实际缺失");
		}
		for (const line of commented) {
			for (const stage of TEST_SUITE_COMMANDS) {
				if (!line.includes(stage)) {
					throw new Error(
						`npm test 注释：期望行内包含 \`${stage}\`（六段链完整），实际缺失。违规行：${line.trim()}`,
					);
				}
			}
		}
	},
);

test(
	"README 的 npm test 链与 suite-contract.ts 的 TEST_SUITE_COMMANDS 逐段一致（六段）",
	() => {
		if (TEST_SUITE_COMMANDS.length !== 6) {
			throw new Error(
				`TEST_SUITE_COMMANDS：期望 6 段，实际 ${TEST_SUITE_COMMANDS.length} 段（${TEST_SUITE_COMMANDS.join(" && ")}）`,
			);
		}
		expectIncludes(SIX_STAGE_CHAIN, "node ./test-primitives.ts", "六段链最后一段");
		for (const title of ["本地开发", "测试"]) {
			expectIncludes(getSection(title), SIX_STAGE_CHAIN, `\`## ${title}\` 六段链与单源顺序一致`);
		}
	},
);

test(
	"`## 测试` 列出 node ./test-primitives.ts 的单独运行命令并写进覆盖说明",
	() => {
		const testing = getSection("测试");
		expectIncludes(testing, "- `node ./test-primitives.ts`", "`## 测试` 原语测试条目");
		expectIncludes(testing, "test-primitives.ts` 覆盖", "`## 测试` 覆盖说明中的原语测试");
		expectIncludes(testing, "path-patterns", "`## 测试` 覆盖说明列出 path-patterns");
		expectIncludes(testing, "process-runner", "`## 测试` 覆盖说明列出 process-runner");
		expectIncludes(testing, "suite-contract", "`## 测试` 覆盖说明列出 suite-contract");
	},
);

test(
	"README 只声称六段链，不再出现五段链表述",
	() => {
		expectIncludes(readme, "六段链", "README 段数表述");
		expectNotIncludes(readme, "五段链", "README 陈旧段数表述");
		expectNotIncludes(readme, "四段链", "README 陈旧段数表述");
	},
);

test(
	"SKILL.md 不引用已删除的 withMergedMode / threeWayMergeText 并解释语义锚点",
	() => {
		const skill = readRepoFile(".agents/skills/verify-wave-integration/SKILL.md");
		expectNotIncludes(skill, "withMergedMode", "SKILL.md 已删除的 withMergedMode 包装");
		expectNotIncludes(skill, "threeWayMergeText", "SKILL.md 已删除的 threeWayMergeText 包装");
		expectIncludes(skill, "resolveMergedMode", "SKILL.md 指向真实的 resolveMergedMode");
		expectIncludes(skill, "multiWayMergeText", "SKILL.md 指向真实的 multiWayMergeText");
		expectIncludes(skill, "function names", "SKILL.md 语义锚点说明");
		expectIncludes(skill, "not line numbers", "SKILL.md 语义锚点说明");
		expectIncludes(
			skill,
			"node .agents/skills/verify-wave-integration/scripts/verify-wave-integration.ts",
			"SKILL.md 复跑命令",
		);
		expectIncludes(skill, "all 3 clauses", "SKILL.md 复跑结论");
	},
);

test(
	"verify-wave-integration.ts 的 codeRef 全部是函数名锚点，不含行号范围",
	() => {
		const script = readRepoFile(
			path.join(".agents", "skills", "verify-wave-integration", "scripts", "verify-wave-integration.ts"),
		);
		const lineRef = /\.ts:\s*\d/.exec(script);
		if (lineRef) {
			const at = script.slice(0, lineRef.index).split(/\r?\n/).length;
			throw new Error(
				`verify-wave-integration.ts：期望不再出现 \`file.ts:<行号>\` 锚点，实际第 ${at} 行出现 \`${lineRef[0]}\``,
			);
		}
		expectIncludes(
			script,
			"Anchors are function names, not line numbers: line numbers drift on every refactor.",
			"verify-wave-integration.ts 锚点头注释",
		);
		const refs = [...script.matchAll(/codeRef:\s*"([^"]+)"/g)].map((m) => m[1]);
		if (refs.length < 15) {
			throw new Error(`codeRef 数量：期望至少 15 条语义锚点，实际 ${refs.length} 条`);
		}
		for (const ref of refs) {
			if (!/^[a-z-]+\.ts:[A-Za-z_]/.test(ref)) {
				throw new Error(`codeRef 语义锚点格式：期望形如 \`index.ts:orch_integrate -> persistState\`，实际 \`${ref}\``);
			}
		}
		for (const clause of ["NoDoubleMerge", "NoRecoveryDeadlock", "RollbackPreservesTaskStatuses"]) {
			expectIncludes(script, clause, `verify-wave-integration.ts 子句 ${clause}`);
		}
	},
);

test(
	"`## 测试` 小节列出 test-packaging-manifest.ts 与 test-packaging-docs.ts 的单独运行命令",
	() => {
		const testing = getSection("测试");
		expectIncludes(testing, "node ./test-packaging-manifest.ts", "`## 测试` 包清单测试入口");
		expectIncludes(testing, "node ./test-packaging-docs.ts", "`## 测试` 文档契约测试入口");
		expectIncludes(testing, "test-packaging-manifest.ts", "`## 测试` 包清单测试文件名");
	},
);

test(
	"本地开发节包含 clone / npm test / `pi install ./` / 技能路径",
	() => {
		const dev = getSection("本地开发");
		expectIncludes(dev, "git clone https://github.com/lynimbus/pi-orchestrator", "`## 本地开发` 克隆仓库");
		expectIncludes(dev, "npm test", "`## 本地开发` 测试命令");
		expectIncludes(dev, "test-packaging-manifest.ts", "`## 本地开发` npm test 六段链中的包清单测试");
		expectIncludes(dev, "test-packaging-docs.ts", "`## 本地开发` npm test 六段链中的文档测试");
		expectIncludes(dev, "pi install ./", "`## 本地开发` 本地安装调试");
		expectIncludes(dev, "pi -e ./index.ts", "`## 本地开发` 临时加载");
		expectIncludes(dev, "pi remove ./", "`## 本地开发` 摘掉本地声明");
		expectIncludes(dev, ".agents/skills/verify-wave-integration", "`## 本地开发` 形式化验证技能");
		expectIncludes(readme, "npm test", "本地开发锚点");
		expectIncludes(readme, "pi install ./", "本地开发锚点");
		expectIncludes(readme, ".agents/skills/verify-wave-integration", "本地开发锚点");
	},
);

test(
	"既有功能文档仍完整保留（/orch 系列、Ctrl+Alt+O、--orch 参数、orchestrator.json、LayerFS、机械门禁等）",
	() => {
		const anchors = [
			"/orch model",
			"/orch thinking",
			"/orch status",
			"/orch reset",
			"/orch on",
			"/orch off",
			"/orch toggle",
			"Ctrl+Alt+O",
			"orch_plan",
			"orch_dispatch",
			"orch_review",
			"orch_integrate",
			"orch_retry_integration",
			"orch_rollback_integration",
			"~/.pi/agent/orchestrator.json",
			"LayerFS",
			"三路合并",
			"机械门禁",
			"tool_call",
			"WAVE_0",
			"escalated",
			"内容寻址",
		];
		for (const anchor of anchors) {
			expectIncludes(readme, anchor, "既有功能文档锚点");
		}
		expectIncludes(readme, "pi --orch", "CLI 参数 `--orch*` 文档");
		expectIncludes(readme, "--orch-model", "CLI 参数 `--orch*` 文档");
		expectIncludes(readme, "--orch-thinking", "CLI 参数 `--orch*` 文档");
	},
);

test(
	"含旧本地路径的每一行都处于迁移/备份/回滚语境",
	() => {
		const allowed = ["rm -rf", ".backup", "迁移", "备份", "回滚", "legacy"];
		const offenders: string[] = [];
		lines.forEach((line, index) => {
			if (!line.includes(LEGACY_PATH)) return;
			if (allowed.some((keyword) => line.includes(keyword))) return;
			offenders.push(`第 ${index + 1} 行：${line.trim()}`);
		});
		if (offenders.length > 0) {
			throw new Error(
				`旧本地路径语境：以下行包含 \`${LEGACY_PATH}\`，但同一行缺少 ${allowed
					.map((k) => `\`${k}\``)
					.join(" / ")} 之一：\n${offenders.join("\n")}`,
			);
		}
		const occurrences = lines.filter((line) => line.includes(LEGACY_PATH)).length;
		if (occurrences === 0) {
			throw new Error(`旧本地路径语境：期望迁移小节至少出现一次 \`${LEGACY_PATH}\`，实际缺失`);
		}
	},
);

test(
	"安装/更新后需重启 Pi 或 `/reload` 生效的说明存在",
	() => {
		expectIncludes(readme, "/reload", "重启生效说明");
		const reloadLines = lines.filter((line) => line.includes("/reload"));
		const contextual = reloadLines.some((line) =>
			["重启", "生效"].some((keyword) => line.includes(keyword)),
		);
		if (!contextual) {
			throw new Error(
				`重启生效说明：期望至少一行同时包含 \`/reload\` 与 \`重启\`/\`生效\`，实际缺失；/reload 出现行：\n${reloadLines
					.map((line) => line.trim())
					.join("\n")}`,
			);
		}
		const install = getSection("安装");
		const update = getSection("更新");
		if (!/重启|生效|reload/.test(install)) {
			throw new Error("重启生效说明：`## 安装` 小节期望包含 `重启` / `/reload` / `生效`，实际缺失");
		}
		if (!/重启|生效|reload/.test(update)) {
			throw new Error("重启生效说明：`## 更新` 小节期望包含 `重启` / `/reload` / `生效`，实际缺失");
		}
	},
);


test(
	"README 不再把手抄本地目录当作安装位置指引",
	() => {
		expectNotIncludes(readme, "拷贝到 ~/.pi/agent/extensions", "安装叙事");
		expectNotIncludes(readme, "安装到 ~/.pi/agent/extensions/orchestrator", "安装叙事");
		// The bare path must not appear in the install/update narrative at all.
		for (const title of ["安装", "更新", "本地开发"]) {
			const section = getSection(title);
			if (section.includes(LEGACY_PATH)) {
				throw new Error(
					`安装/更新路径叙事：\`## ${title}\` 小节期望不包含 \`${LEGACY_PATH}\`，实际却出现了`,
				);
			}
		}
	},
);

test(
	"文档声明的仓库地址与包标识保持一致",
	() => {
		expectIncludes(readme, "https://github.com/lynimbus/pi-orchestrator", "仓库地址");
		expectIncludes(readme, GIT_PACKAGE, "git 包标识");
		// The primary install command must appear as its own un-pinned command line
		// (a `@<ref>` example elsewhere in the section is still allowed).
		const mainInstall = `pi install ${GIT_PACKAGE}`;
		const hasStandaloneMainCommand = lines.some((line) => line.trim() === mainInstall);
		if (!hasStandaloneMainCommand) {
			throw new Error(
				`安装命令：期望存在一条独立成行、不带 \`@<ref>\` 的主命令 \`${mainInstall}\`，实际缺失`,
			);
		}
		const installSection = getSection("安装");
		expectIncludes(installSection, mainInstall, "`## 安装` 小节主命令");
	},
);

for (const t of tests) runner.testCase(t.name, t.run, t.acceptance);
runner.finish();
