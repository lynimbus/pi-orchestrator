# 最终杂乱审计（Untangle Audit）

> 本文件是**纯文档**，不参与运行时逻辑。
> 它记录消融实验最后一波（Wave 3）由审计子代理执行的收尾审计：**四个扫描**、各自的证据、修掉的东西、以及**刻意保留**的特殊情况及其理由。
> 三波集成后由 Lead 补做的**文件内重复**复核见 **§7**（Wave 4：修掉最后一处夹具副本、逐条记录刻意保留的重复块）。
> 配套文档：[`docs/ablation-report.md`](./ablation-report.md)（波次记录与冗余计数器）。

---

## 0. 结论先行（TL;DR）

| 扫描 | 结果 | 备注 |
|---|---|---|
| A. 重复块（≥10 行相同归一化行，跨生产 `.ts`） | **0 处** | 基线为 15 处 |
| B. 死符号（声明后零引用） | **0 个** | 唯一「生产侧零引用」的 `TEST_SUITE_COMMANDS` 是测试契约（仓库内 34 处引用） |
| C. 特例（单值 `if` / 吞掉的 `catch` / 重试睡眠 / 禁用测试） | 67 + 6 + 0 + 0，**无一条是未记账的需求** | 逐条分类见 §3 |
| D. 导入方向（稳定模块是否 import 更易变的模块） | **0 条违规** | 19 条内部 import 边全部「易变 → 稳定」 |

修复：**1 条 hidden link**（最后一个：`.tmp` / `.cache` 双份硬编码）+ **7 组结构抗回潮守卫**（§5.2）。
保留：**11 项**刻意保留的特殊情况/惯用写法，逐条给了理由（§6）。

**最终判断：没有剩余值得修复的 hidden links / needless links / surplus / special cases。**
理由不是「我觉得没有了」，而是：四个互不重叠的扫描各自给出 0 或已分类的有限清单，且**每一条被消除的结构都有一行可执行的守卫**防止回潮（§5.2）。

> Wave 4 补充：三波合并后 Lead 又做了一次**文件内**重复扫描（归一化 ≥8 行），只发现 3 处值得记账的块（`test-kit.ts` 两个薄工厂 / `verifier.ts` 对称 DP / `index.ts` 惯用尾链）+ 1 处真副本（`test.ts` 夹具，已修），详见 **§7**。

---

## 1. 扫描 A：重复块扫描

**方法**：把 10 个生产模块（`index.ts` / `layerfs-engine.ts` / `verifier.ts` / `subagent-runner.ts` / `workspace-env.ts` / `path-patterns.ts` / `process-runner.ts` / `suite-contract.ts` / `types.ts` / `integration-state.ts`）逐行 `strip()` 归一化（消除缩进差异），切成连续 10 行窗口，找出**跨文件**完全相同的窗口。

```bash
python3 - <<'PY'
import collections
PROD = ["index.ts","layerfs-engine.ts","verifier.ts","subagent-runner.ts","workspace-env.ts",
        "path-patterns.ts","process-runner.ts","suite-contract.ts","types.ts","integration-state.ts"]
W = 10
seen = collections.defaultdict(list)
for f in PROD:
    lines = open(f, encoding="utf-8").read().splitlines()
    for i in range(len(lines) - W + 1):
        block = "\n".join(l.strip() for l in lines[i:i+W])
        if block.strip():
            seen[block].append((f, i + 1))
dups = [(k, v) for k, v in seen.items() if len({f for f, _ in v}) > 1]
print("cross-file duplicate 10-line blocks in production:", len(dups))
PY
```

**结果**：`cross-file duplicate 10-line blocks in production: 0`（基线 15 处 → 0）。

**判读**：Wave 1 抽出的 4 个共享模块 + Wave 2 的 4 个消费方改接线，已经把所有跨文件复制粘贴消除干净；剩下的是**文件内**的局部重复（同一函数里的对称分支、同构的错误消息），它们不属于「同一份知识的多份副本」，见 §6 与 §3。

---

## 2. 扫描 B：死符号扫描

**方法**：用正则收集 10 个生产模块的 `function` / `class` / `interface` / `type` / `const` / `enum` 声明名，再在**全部生产源码**里统计 `\bNAME\b` 的引用次数；次数 `<= 1` 即为「声明后零引用」（纯死代码）。第二遍统计「只在自己文件内被引用」的 `export`（暴露面大于真实需要）。

```bash
# 见 docs/ablation-report.md §结论与复测命令 中的「死导出 / 陈旧引用扫描」三条 grep
grep -rn "threeWayMergeText\|withMergedMode" --include=*.ts --include=*.md .
```

**结果**：

- **零引用的死符号：0 个。**
- 唯一被第一遍标出的 `suite-contract.ts:TEST_SUITE_COMMANDS` 是**假阳性**：它是测试契约，生产代码本来就不该引用它，而 `package.json scripts.test`、`test-waves.ts`、`test-packaging-manifest.ts`、`test-packaging-docs.ts` 都从它派生（仓库内 34 处引用）。它是**唯一来源**，不是死代码。
- 「只在本文件内引用」的 `export` 共 **19 个**，全部是**类型/接口词汇**（`TreeEntry` / `TreeManifest` / `CommitRecord` / `BranchRecord` / `HostSnapshotEntry` / `StatCacheEntry` / `HostSnapshotRecord` / `ScratchDirs` / `SupervisedProcessOptions` / `SubagentDispatchOptions` / `OrchestratorPhase` / `RequiredTestCase` / `MechanicalGateCheck` / `ReviewEntry` / `TaskRuntimeState` / `IntegrationRecord` / `IntegrationDecision`）加上 **2 个内部值 helper**（`layerfs-engine.ts:HOST_CONTRIBUTOR`、`verifier.ts:parseWorkerStructuredReport`）。

**判读与处理**：这些 `export` 不构成「链接」——**没有任何模块 import 它们**，所以既不是 hidden link 也不是 needless link；去掉 `export` 只是收紧模块的公开面，属于**公开签名变更**，而本次任务的口径是「公开签名一律不动」。因此**保留不改**，理由记录在 §6。

---

## 3. 扫描 C：特例扫描

### 3.1 字面量单值 `if`（67 处）

| 文件 | 处数 | 判读 |
|---|---|---|
| `index.ts` | 25 | CLI 子命令分发（`sub === "on"` / `"model"` / `"reset"` …）、`event.toolName === "write" \| "edit"`、`activePlan.phase === "WAVE_0"`、`rev.decision === "approve" \| "reject" \| "escalate"`、模型/思考选择菜单项 —— 每一条都是**对外可见的相位迁移或用户可选值**，不是内部隐藏需求。 |
| `layerfs-engine.ts` | 24 | 层/提交/快照记录的 `type === "file" \| "directory" \| "symlink"`、`changeType === "added" \| "deleted"`、`name === "id_rsa" \| "id_ed25519" \| "id_ecdsa"`（secret 名单）—— 全是**数据模型判别式**。 |
| `verifier.ts` | 7 | 门禁检查项的 `kind` 判别与报告字段判别。 |
| `subagent-runner.ts` | 5 | 子代理事件流 `evt.type` 判别。 |
| `path-patterns.ts` | 4 | glob 语法判别（`*` / `?` / 目录前缀）—— **glob 语义本体**。 |
| `integration-state.ts` | 2 | 集成状态机判别。 |

**没有一处**是「同一种判定的第 2 份副本」或「一条本可以参数化却写死的业务值」。其中 `PI_ORCHESTRATOR_WORKER === "1"`、secret 名单、`CI=1` 三项属于外部策略，见 §6。

### 3.2 被吞掉的 `catch`（6 处）

| 位置 | 形态 | 为什么不是「静默失败」 |
|---|---|---|
| `layerfs-engine.ts` `scanTree` 的 `readdirSync` | `catch { return; }` | 扫描期间目录可能被**并发删除**（TOCTOU）；跳过该目录正是「导入磁盘现状」的语义。 |
| `layerfs-engine.ts` `scanTree` 的 `lstatSync(bigint)` | `catch { return undefined; }` | 同上；`undefined` 会走 `continue`，不会产出半个 tree entry。 |
| `layerfs-engine.ts` `lstatIfExists` | `catch { return undefined; }` | 名字即契约（`IfExists`），调用方显式处理 `undefined`。 |
| `layerfs-engine.ts` `verifyHostMatchesLayer` 的静默 `lstatSync` | `catch { return undefined; }` → `return \`${relPath}: missing or unreadable\`` | **有显式下游后果**：变成一条 mismatch，host↔layer 判为不 MATCH。 |
| `layerfs-engine.ts` 同函数的 `readFileSync` | `catch { return undefined; }` → 同上 | 同上（读失败 = 不可验证 = mismatch）。 |
| `subagent-runner.ts` 的 `JSON.parse(line)` | `catch { … }` 跳过非 JSON 行 | 子代理 stdout 混有非结构化日志行，这是**协议的一部分**。 |

**结论**：6 处全部是「容忍并发/外部输入」的显式约定，且每处都有注释或显式下游行为；**没有一处吞掉本该冒泡的错误**。

### 3.3 重试 / 睡眠

- 生产代码**没有任何 `sleep` / backoff / 轮询循环**。
- 定时器只有 `process-runner.ts` 的 **2 个**：超时计时器与 `KILL_ESCALATION_MS` 升级计时器（同一套生命周期，见冗余计数器）。
- `orch_retry_integration` 是**状态机动作**（`integration-state.ts:decideRetryIntegrationAction`），不是"重试 N 次带 sleep"的循环。

### 3.4 禁用测试

- `.only(` / `.skip(` / `xit(` / `t.Skip` 在**仓库的测试文件里出现 0 次**（只有 `verifier.ts` 里用于**检测**作弊的正则、以及 3 处测试在反向断言"生成的套件不得含 `.only/.skip`"）。
- 本次改动**没有删除、没有弱化任何一条断言**。

---

## 4. 扫描 D：导入方向扫描

**稳定性排序（低 = 更稳定 / 依赖更少）**：`types.ts`(0) → `path-patterns.ts`(1) → `workspace-env.ts`(2) → `process-runner.ts`(3) → `suite-contract.ts`(4) → `integration-state.ts`(5) → `layerfs-engine.ts`(6) → `verifier.ts`(7) → `subagent-runner.ts`(8) → `index.ts`(9)。

**19 条内部 import 边**（全部满足 `rank(from) > rank(to)`，即"易变 → 稳定"）：

```
index.ts             (9) -> integration-state.ts (5)   layerfs-engine.ts (6)   path-patterns.ts (1)
                            subagent-runner.ts    (8)   types.ts          (0)   verifier.ts      (7)
integration-state.ts (5) -> types.ts              (0)
layerfs-engine.ts    (6) -> path-patterns.ts      (1)   types.ts          (0)   workspace-env.ts (2)
verifier.ts          (7) -> path-patterns.ts      (1)   process-runner.ts (3)   types.ts (0)  workspace-env.ts (2)
subagent-runner.ts   (8) -> layerfs-engine.ts     (6)   process-runner.ts (3)   types.ts (0)
                            verifier.ts           (7)   workspace-env.ts  (2)
```

**违规：0 条。** 特别值得记一笔的两条（Wave 1 / F1 的修复点）：

1. `index.ts` 不再从**易变的存储引擎**借纯 helper（现在只从 `path-patterns.ts` 拿 `matchesAnyPattern`）；
2. `verifier.ts` **完全不 import** `layerfs-engine.ts`（只依赖 `path-patterns` / `process-runner` / `workspace-env` / `types`），所以「门禁」不再与「存储实现」形成双向绑定的风险。

唯一"跨层"的边是 `subagent-runner.ts -> layerfs-engine.ts`，且是 **`import type`**（仅类型），运行时无依赖倒置。

---

## 5. 本波修掉的东西

### 5.1 最后一个 hidden link：`SCRATCH_DIR_NAMES`

**症状**：`workspace-env.ts:scratchDirs()` 硬编码 `.tmp` / `.cache`；`layerfs-engine.ts` 的 `IGNORED_DIRS` 又硬编码了同样的两个字符串。两份副本靠"人记得同时改"保持一致，任何一边改名都会导致 **scratch 文件被导入进 Layer**（或忽略失效），而且**没有任何测试会报警**。

**修复**（行为完全不变）：

- `workspace-env.ts` 新增 `export const SCRATCH_DIR_NAMES = [".tmp", ".cache"] as const;`，`scratchDirs()` 用 `SCRATCH_DIR_NAMES[0]` / `[1]` 派生；
- `layerfs-engine.ts` 改为 `new Set([".git", ".jj", ".hg", ".svn", ...SCRATCH_DIR_NAMES, ".layerfs-orch"])`（其余忽略项一字未动）。

**证明**（行为，而不是源码字符串）：`test.ts` 新增用例用真实宿主树（`.tmp/junk.txt`、`.cache/junk.txt`、`src/keep.txt`）跑 `importHostAsLayer`，断言层树**排除**两条 scratch 路径、**保留** `src/keep.txt`；并断言 `scratchDirs("root")` 的两个 basename 恰好等于 `SCRATCH_DIR_NAMES[0]` / `[1]`。

### 5.2 结构抗回潮守卫（`test-regressions.ts`）

| 守卫 | 断言 |
|---|---|
| 死抽象不回潮 | 10 个生产模块中 `threeWayMergeText` / `withMergedMode` 出现 **0** 次 |
| 单一定义点 | `function normalizeRelPath(` / `hasGlobWildcard(` / `isTestFilePath(` / `matchesAnyPattern(` 只能在 `path-patterns.ts`；`scratchDirs(` / `ensureScratchDirs(` / `scratchEnvironment(` 只能在 `workspace-env.ts`；`superviseChildProcess(` 只能在 `process-runner.ts`；且各自恰好 **1** 次 |
| 无单数重复 | 任何生产模块不得出现 `function ensureScratchDir(`（单数） |
| 唯一进程生命周期 | `proc.kill("SIGTERM")` 在**整个仓库**只出现 **1 次**，且文件恰好是 `process-runner.ts` |
| 唯一上限 | `layerfs-engine.ts` 恰好 **1 个** `MAX_HOST_MISMATCHES`（声明 1 + 使用 1 = 2 次出现），且 `mismatches.length >= 50` 副本 **0** 个 |
| 锚点不退化 | `verify-wave-integration.ts` 的 `codeRef` 仍 ≥15 条，且**没有**匹配 `:\d+-\d+` 的行号范围 |
| 共享 runner 接线 | `test-kit.ts` 存在时，`test-waves.ts` / `test-packaging-manifest.ts` / `test-packaging-docs.ts` / `test-primitives.ts` 必须 `import ... from "./test-kit.ts"` |

> `test-kit.ts` 那条是**前瞻性断言**：该文件由同一波次的并行任务创建。在本孤立工作区中它尚不存在，因此该**单条**断言带显式注释 **SKIP**（不是静默跳过、不是移除），集成后立即生效。

**守卫自身的有效性已验证**：临时注入 `mismatches.length >= 50`、`proc.kill("SIGTERM")`、`threeWayMergeText` 三个 canary 后守卫分别报错（`1 !== 0` / `got ["process-runner.ts","verifier.ts"]` / `1 !== 0`），注入回滚后全绿。

### 5.3 文档

`docs/ablation-report.md`：Wave 2 行填入 Lead 确认的结论（Layer **L12**、host↔layer **MATCH**、集成 **2118ms**）、Wave 3 行填入本波内容、新增 `F8` 决策记录、保留表补齐 4 项、占位符替换为**冗余计数器**表与"为何行数几乎持平"的解释；本文件为审计证据。

---

## 6. 刻意保留的特殊情况（逐条理由）

| 保留项 | 位置 | 为什么**不是** hidden link / surplus |
|---|---|---|
| `PI_ORCHESTRATOR_WORKER === "1"` worker 模式守卫 | `index.ts` | 判断的是**外部进程环境**（子代理进程 vs Lead 进程）——这不是内部状态分支，合并会混淆两种运行时身份。 |
| `isSecretFileName` 硬编码的 secret 名单 | `layerfs-engine.ts` | 对应**外部安全策略**（哪些文件禁止被读取/提交）。策略必须显式、可审计、可 diff，不能从别处"推导"出一个隐式版本。 |
| `CI=1` 非交互测试命令 | `verifier.ts:executeWorkspaceCommand` | 测试命令必须**非交互**，否则子代理的测试会卡在 TTY 提示上；这是**执行上下文策略**，且 `scratchEnvironment()` 明确注释了"CI 是调用方策略，不由环境映射隐含"。 |
| `ensureScratchDirs` 的 `os.tmpdir()` 回退 | `workspace-env.ts` | 宿主工作区可能**不可写**（只读挂载 / 权限受限），回退是唯一可行路径；且回退目标是 `mkdtemp` 出来的独立目录，不会静默写到别处。 |
| 重试分支复用已挂载的 LayerFS 工作区 | `index.ts:orch_retry_integration` | **LayerFS 分支生命周期**约束：每次重试重新 `mountWorkspace` 会重置分支的层指针并丢掉未提交改动。 |
| `executeWorkspaceCommand` 的 `scratchRoot` / `cleanupStrayRootFiles` 选项 | `verifier.ts` | 代表**真正不同的执行上下文**（宿主根目录 vs 已挂载工作区；是否清理散落根文件）。合并成一个布尔参数只会把两个上下文塞进一条更难审计的分支。 |
| 惯用尾链 `.filter(Boolean).join("\n")` | `index.ts` 多处 | **JS 集合处理的惯用写法**；每处过滤谓词与分隔符都由上下文决定。提取成 helper 只会把「一段普通代码」变成一层多余间接（needless link）。 |
| 状态机对 `phase` / `status` 的 `switch` / `if` 链 | `index.ts`（`switch (activePlan.phase)`）、`integration-state.ts` | 这些**就是状态机的转换表本体**，每个分支对应一条对外可见的相位迁移；不是同一判定的重复副本。 |
| `verifier.ts:segmentGlobsIntersect` 的对称 DP 分支 | `verifier.ts` | 分支两侧是 glob 段 a / 段 b 各自的通配副作用（`*` 消耗 a 或消耗 b 或同时消耗），**数学上就是对称的**；"消除对称"只能加一层表驱动，可读性更差且行为等价性更难验。 |
| 类型/接口的 `export`（19 个，仅本文件内引用） | 各模块 | 它们是模块的**类型词汇表**，不构成任何 import 边（没有模块 import 它们）。去掉 `export` 属于公开面变更，且不消除任何冗余，故保留。 |
| `KILL_ESCALATION_MS` 单一常量 | `process-runner.ts` | 它是**一条策略**（所有被监管子进程共用同一升级窗口），不是 per-caller 特例；保留为常量正是消融结果。 |

---

## 7. 波次合并后的补充审计（Lead 复核）

三波合并完成之后，Lead 又对**文件内**（intra-file）重复做了一次补充扫描（窗口 ≥8 行、按 `strip()` 归一化）。结果只有下面四行值得记账：**测试基础设施**里的 `test-kit.ts` 薄工厂块（同步 / 异步两个 runner 体，按窗口计即两处）与 `verifier.ts` 的对称 DP（生产侧窗口计数最集中的一块）、`index.ts` 的惯用尾链，以及唯一一处**真副本**——`test.ts` 的 `src/math.js` 夹具（已在本波修掉）。其余扫描命中都是 `} finally { sandbox.cleanup(); } } }` + 空行 + `/**` 这类**收尾括号样板**或局部同构，不构成「同一份知识的多份副本」。逐条判定如下。

| 重复块（归一化 ≥8 行，同一文件内） | 位置 | 判定 |
|---|---|---|
| 两个薄工厂（`createSyncTestRunner` / `createAsyncTestRunner`）的 `testCase` 体只差一个 `await` | `test-kit.ts` | **保留**：它们的**契约真的不同**（`void` vs `Promise<void>`），其余每一块实质内容——pass 行、失败渲染、计数、汇总、退出码——已经在共享 helper（`printPass` / `reportFailure` / `finishHarness`）里。合并它们需要加一个运行时 promise 探测分支 + 一条新的错误路径，等于**为一个没有收益的目标引入新的特例**；而一次典型的改动只落在某一个共享 helper 里。 |
| `segmentGlobsIntersect` 对 `*` 的两侧对称 DP 分支 | `verifier.ts` | **保留**：这是双模式求交 DP **内在的对称性**，不是一条未被记账的新需求。 |
| `.filter(Boolean).join("\n")` 的 4 份副本 | `index.ts` | **保留**：这是一个**语言惯用法**，没有任何需要保持同步的知识；抽出来只会多一层浅包装（shallow wrapper）。 |
| `src/math.js` 夹具的 3 份副本（初始 host import / task-t3 / task-t4） | `test.ts` | **修掉（本波）**：抽成模块级 `mathJs(addReturn, subReturn)` 单一来源，三处调用点只传各自的 return 表达式；默认参数逐字节复现原夹具，新增断言（`testMathJsFixtureIsSingleSource`）锁住默认形态、两种覆盖形态，以及「本文件里夹具头只有一个副本」。（注：`test.ts` 在 ≥8 行窗口下还剩 1 个窗口，但那只是 `} finally { sandbox.cleanup(); } } }` + 空行 + `/**` 这类**收尾括号样板**，不是夹具或知识副本。） |

**结论：**上表的判定结果与 §6 的保留清单一致——保留的三项各有独立理由（契约不同 / 数学对称 / 语言惯用法），唯一的真副本已在本波消除，且消除后有断言防回潮。

复核后没有剩余值得修复的 hidden links / needless links / surplus / special cases。

---

## 8. 复测命令与最终结论

```bash
npm test && node .agents/skills/verify-wave-integration/scripts/verify-wave-integration.ts
```

- `npm test`：六段链 `test.ts` → `test-regressions.ts` → `test-waves.ts` → `test-packaging-manifest.ts` → `test-packaging-docs.ts` → `test-primitives.ts`，全部 PASS，退出码 **0**；
- 形式化验证：`NoDoubleMerge` / `NoRecoveryDeadlock` / `RollbackPreservesTaskStatuses` **3/3 PASS**，**1422** 个可达状态，退出码 **0**。

**最终陈述：**四个扫描（重复块 0、死符号 0、特例全部可解释、导入方向 0 违规）+ 一行可执行守卫（§5.2）+ 一次行为等价性证明（§5.1）之后，
**没有剩余值得修复的 hidden links / needless links / surplus / special cases。**

---

## 9. 追加清理复核

用户后来选中了当初被标记为「可选」的两项清理（Comments / Tests）。两波只删噪声，不动行为；本节的复核只看一件事：**剩下的测试还能不能抓到真实的回归**。

- **最终测试集的构成**：只剩两类。
  1. **行为测试**——直接调用被测函数/引擎，断言可观测的结果（glob 与 `allowedFiles` 重叠、依赖波次切分、LayerFS 合并与回滚的端到端状态、共享 runner 的捕获 / 计数 / 退出码探针）。
  2. **面向用户 / 代理的制品契约**——`package.json` 清单（JSON 解析后的 name / type / main / `pi` / keywords / repository / `scripts.test`）、README 的安装 / 升级 / 迁移叙事、`SKILL.md` 的陈旧函数引用与语义锚点说明、形式化验证脚本的三条子句名、`docs/ablation-report.md` 的结构小节与基线数字。它们失败时，坏掉的是**真实发货的制品**。
- **刻意退役的源码文本守卫**：把 `.ts` 当文本读、断言「import 了哪个符号」「不存在本地副本」「某个断言仍在原位」「每个套件只 `finish()` 一次」「夹具只有一份实现」的守卫全部删除。这些属性**要么已由行为测试覆盖**（共享 runner 的三条行为探针就是「只 `finish()` 一次」的行为版本），**要么对用户与代理不可见**（生产文件的 import 布局、兄弟测试文件的写法）。保留它们等于让一次无害的重命名 / 提取变成红灯。
- **净效果**：不再存在「可以在没有真实行为回归的情况下失败或通过」的测试；断言数下降，覆盖不减。属性仍然重要但原先只有源码文本覆盖的两处（路径规范化、`**` / `?` 通配展开）已补上**行为**测试，并做过**变异验证**（改坏实现 → 新测试必须失败）。

**§7 的判定与上面的复测命令不变**：三个「刻意保留」的结构（`test-kit.ts` 薄工厂 / `verifier.ts` 对称 DP / `.filter(Boolean).join("\n")` 惯用尾链）仍然保留，`docs/ablation-report.md` 的最终指标数字与本节表述一致。

**最终复核**：两波之后的收尾测试集为六套共 **45 / 11 / 22 / 36 个命名用例 + 2 套断言链**，形式化验证 **3/3 PASS · 1422 states**，发布 Layer **L20**。
