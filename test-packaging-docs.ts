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
import { ORCHESTRATOR_TOOL_NAMES } from "./tool-gate.ts";
import { createSyncTestRunner } from "./test-kit.ts";

const runner = createSyncTestRunner();

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const README_PATH = path.join(HERE, "README.md");

/** The exact `&&`-chained command line that `npm test` must document. */
const ELEVEN_STAGE_CHAIN = TEST_SUITE_COMMANDS.join(" && ");

/** Stage-count claim the README must make (and the count `TEST_SUITE_COMMANDS` must have). */
const STAGE_COUNT = 11;

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
	"`## 本地开发` 与 `## 测试` 的 npm test 注释同步为十一段链",
	() => {
		const elevenStage = ELEVEN_STAGE_CHAIN;
		expectIncludes(getSection("本地开发"), elevenStage, "`## 本地开发` npm test 十一段链注释");
		expectIncludes(getSection("测试"), elevenStage, "`## 测试` npm test 十一段链注释");
		// 源码中不存在只写三段的 npm test 注释
		const commented = lines.filter((line) => /npm test\s+#/.test(line));
		if (commented.length === 0) {
			throw new Error("npm test 注释：期望至少有一行 `npm test    # ...` 形式的分阶段注释，实际缺失");
		}
		for (const line of commented) {
			for (const stage of TEST_SUITE_COMMANDS) {
				if (!line.includes(stage)) {
					throw new Error(
						`npm test 注释：期望行内包含 \`${stage}\`（十一段链完整），实际缺失。违规行：${line.trim()}`,
					);
				}
			}
		}
	},
);

test(
	"README 的 npm test 链与 suite-contract.ts 的 TEST_SUITE_COMMANDS 逐段一致（十一段）",
	() => {
		if (TEST_SUITE_COMMANDS.length !== STAGE_COUNT) {
			throw new Error(
				`TEST_SUITE_COMMANDS：期望 ${STAGE_COUNT} 段，实际 ${TEST_SUITE_COMMANDS.length} 段（${TEST_SUITE_COMMANDS.join(" && ")}）`,
			);
		}
		expectIncludes(ELEVEN_STAGE_CHAIN, "node ./test-worker-session.ts", "十一段链中的 worker session 测试");
		expectIncludes(ELEVEN_STAGE_CHAIN, "node ./test-primitives.ts", "十一段链最后一段");
		for (const title of ["本地开发", "测试"]) {
			expectIncludes(getSection(title), ELEVEN_STAGE_CHAIN, `\`## ${title}\` 十一段链与单源顺序一致`);
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
	"README 只声称十一段链，不再出现七段链 / 六段链 / 五段链表述",
	() => {
		expectIncludes(readme, "十一段链", "README 段数表述");
		expectNotIncludes(readme, "七段链", "README 陈旧段数表述");
		expectNotIncludes(readme, "六段链", "README 陈旧段数表述");
		expectNotIncludes(readme, "五段链", "README 陈旧段数表述");
		expectNotIncludes(readme, "四段链", "README 陈旧段数表述");
	},
);

/**
 * The four suites registered by the three policy modules. Kept as an explicit list
 * (not sliced out of TEST_SUITE_COMMANDS) so a contract that merely drops a stage
 * cannot also drop its own inclusion assertion.
 */
const POLICY_SUITES = [
	"test-thinking-levels.ts",
	"test-tool-gate.ts",
	"test-session-config.ts",
	"test-extension-wiring.ts",
];

test(
	"十一段链包含四个新策略套件，且顺序与索引 5-8 一致",
	() => {
		for (const [offset, suite] of POLICY_SUITES.entries()) {
			const stage = `node ./${suite}`;
			expectIncludes(ELEVEN_STAGE_CHAIN, stage, `十一段链中的 ${suite}`);
			expectIncludes(readme, stage, "README 中的 " + suite + " 命令");
			const index = TEST_SUITE_COMMANDS.indexOf(stage);
			if (index !== 5 + offset) {
				throw new Error(
					`${suite}：期望位于索引 ${5 + offset}，实际位于索引 ${index}（${TEST_SUITE_COMMANDS.join(" && ")}）`,
				);
			}
		}
	},
);

test(
	"`## 测试` 为四个新策略套件各列一条单独运行命令与覆盖说明",
	() => {
		const testing = getSection("测试");
		for (const suite of POLICY_SUITES) {
			expectIncludes(testing, `- \`node ./${suite}\``, `\`## 测试\` ${suite} 条目`);
		}
		expectIncludes(testing, "test-thinking-levels.ts` 覆盖", "覆盖说明中的思考等级策略测试");
		expectIncludes(testing, "test-tool-gate.ts` 覆盖", "覆盖说明中的工具闸门测试");
		expectIncludes(testing, "test-session-config.ts` 覆盖", "覆盖说明中的会话配置测试");
		expectIncludes(testing, "test-extension-wiring.ts` 覆盖", "覆盖说明中的接线测试");
		for (const module of ["thinking-levels.ts", "tool-gate.ts", "session-config.ts"]) {
			expectIncludes(testing, `\`${module}\``, `覆盖说明列出 ${module}`);
		}
	},
);

test(
	"`/orch thinking` 不再宣传固定枚举，改为跟随所选子代理模型的声明",
	() => {
		expectNotIncludes(readme, "[off|minimal|low|medium|high|xhigh|inherit]", "固定思考等级枚举");
		expectIncludes(readme, "/orch thinking", "`/orch thinking` 命令文档");
		const usage = getSection("快速上手");
		expectIncludes(usage, "reasoning", "思考等级来自模型的 reasoning 声明");
		expectIncludes(usage, "thinkingLevelMap", "思考等级来自模型的 thinkingLevelMap");
		expectIncludes(usage, "magpie/group/deepseek", "deepseek 模型声明示例");
		expectIncludes(usage, "off / low / high / max", "deepseek 声明的具体等级");
		expectIncludes(usage, "magpie/group/hy4", "hy4 模型声明示例");
		expectIncludes(usage, "只声明 \`high\`", "hy4 只声明 high");
		expectIncludes(usage, "不做过滤", "无法解析声明时不过滤等级");
		expectIncludes(usage, "丢弃", "不被声明的配置等级会被丢弃");
		expectIncludes(usage, "clamping", "被丢弃的等级交给 pi 自己的 clamping");
	},
);

test(
	"README 说明关闭状态下八个 orch 工具既不声明给模型也不可调用",
	() => {
		const usage = getSection("快速上手");
		expectIncludes(usage, "既不声明", "工具声明移除说明");
		expectIncludes(usage, "无法调用", "不可调用说明");
		expectIncludes(usage, "system prompt", "工具指南一并移除说明");
		expectIncludes(usage, "/orch on", "拦截理由指向 `/orch on`");
		for (const tool of ORCHESTRATOR_TOOL_NAMES) {
			expectIncludes(usage, tool, `关闭时不可用的工具 ${tool}`);
		}
	},
);

test(
	"快速上手的 `--orch` 示例使用真实的 provider/modelId 与模型声明过的等级",
	() => {
		const usage = getSection("快速上手");
		expectIncludes(usage, "`--orch-model` 接受 `provider/modelId`", "`--orch-model` 的 provider/modelId 说明");

		// 文档自己写出的「<模型> 声明 `<等级>`」句子，就是示例必须遵守的声明表。
		const declarations = new Map<string, string[]>();
		for (const match of usage.matchAll(/`([a-z0-9]+\/[a-z0-9/._-]+)` 只?声明 `([^`]+)`/g)) {
			declarations.set(
				match[1],
				match[2]
					.split("/")
					.map((level) => level.trim())
					.filter(Boolean),
			);
		}
		if (declarations.size < 2) {
			throw new Error(
				`模型声明示例：期望 \`## 快速上手\` 至少写出两个模型的声明等级，实际 ${declarations.size} 个（${[...declarations.keys()].join(", ")}）`,
			);
		}

		const examples = lines.filter((line) => line.trim().startsWith("pi --orch"));
		if (examples.length === 0) {
			throw new Error("CLI 示例：期望至少存在一条以 `pi --orch` 开头的示例命令，实际缺失");
		}
		for (const line of examples) {
			const model = /--orch-model\s+(\S+)/.exec(line)?.[1];
			if (model === undefined) {
				throw new Error(`CLI 示例：期望示例命令带 \`--orch-model provider/modelId\`，实际：${line.trim()}`);
			}
			if (!/^[a-z0-9]+\/[a-z0-9/._-]+$/.test(model)) {
				throw new Error(
					`CLI 示例：\`--orch-model ${model}\` 不是 provider/modelId 形式（按第一个 \`/\` 切分），实际：${line.trim()}`,
				);
			}
			const declared = declarations.get(model);
			if (declared === undefined) {
				throw new Error(
					`CLI 示例：\`${model}\` 的等级声明未在 \`## 快速上手\` 写出，读者无法判断该示例是否可用（已声明等级的模型：${[...declarations.keys()].join(", ")}）。实际：${line.trim()}`,
				);
			}
			const level = /--orch-thinking\s+(\S+)/.exec(line)?.[1];
			if (level === undefined || level === "inherit") continue;
			if (!declared.includes(level)) {
				throw new Error(
					`CLI 示例：\`${model}\` 未声明 \`${level}\`（已声明 ${declared.join(" / ")}），该等级会在派工时被丢弃。实际：${line.trim()}`,
				);
			}
		}
	},
);

test(
	"README 说明开关跟随会话、其余七项全局配置写入 orchestrator.json",
	() => {
		expectNotIncludes(readme, "配置文件持久化保存在", "全局持久化声明");
		expectNotIncludes(readme, "永远不会写", "扩展从不写 orchestrator.json 的旧断言");
		expectNotIncludes(readme, "默认种子", "orchestrator.json 是可选默认种子的旧定位");
		const usage = getSection("快速上手");
		expectIncludes(usage, "orchestrator-state", "开关由会话自己的 `orchestrator-state` 条目承载");
		expectIncludes(usage, "`enabled`", "`enabled` 字段说明");
		expectIncludes(usage, "跟随", "开关跟随当前会话");
		expectIncludes(usage, "~/.pi/agent/orchestrator.json", "七项全局配置文件路径");
		expectIncludes(usage, "全局配置", "其余七项是全局配置");
		expectIncludes(usage, "写入", "`/orch` 与菜单修改会写入该文件");
		expectIncludes(usage, "之后启动的会话", "写入对之后启动的会话生效");
		expectIncludes(usage, "忽略", "文件里的 `enabled` 被忽略");
		expectIncludes(usage, "--orch", "`--orch` 只为当次会话强制开启");
		expectIncludes(usage, "--orch-model", "`--orch-model` 当次覆盖");
		expectIncludes(usage, "--orch-thinking", "`--orch-thinking` 当次覆盖");
		expectIncludes(usage, "不落盘", "flag 覆盖不写入共享文件");
		expectIncludes(usage, "内置默认值", "优先级最低层：内置默认值");
		expectIncludes(usage, "会话条目", "开关优先级：会话条目");
		expectIncludes(usage, "CLI 参数", "开关优先级最高层：CLI 参数");
		expectIncludes(usage, "两条", "两条生效优先级链");
		expectIncludes(usage, "七项", "七项全局配置的优先级链");
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
	"`## 测试` 列出 test-packaging-manifest.ts / test-packaging-docs.ts / test-worker-session.ts 的单独运行命令",
	() => {
		const testing = getSection("测试");
		expectIncludes(testing, "node ./test-packaging-manifest.ts", "`## 测试` 包清单测试入口");
		expectIncludes(testing, "node ./test-packaging-docs.ts", "`## 测试` 文档契约测试入口");
		expectIncludes(testing, "test-packaging-manifest.ts", "`## 测试` 包清单测试文件名");
		expectIncludes(testing, "- `node ./test-worker-session.ts`", "`## 测试` worker session 测试条目");
		expectIncludes(testing, "test-worker-session", "`## 测试` worker session 覆盖说明");
	},
);

test(
	"本地开发节包含 clone / npm test / `pi install ./` / 技能路径",
	() => {
		const dev = getSection("本地开发");
		expectIncludes(dev, "git clone https://github.com/lynimbus/pi-orchestrator", "`## 本地开发` 克隆仓库");
		expectIncludes(dev, "npm test", "`## 本地开发` 测试命令");
		expectIncludes(dev, "test-packaging-manifest.ts", "`## 本地开发` npm test 十一段链中的包清单测试");
		expectIncludes(dev, "test-packaging-docs.ts", "`## 本地开发` npm test 十一段链中的文档测试");
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
