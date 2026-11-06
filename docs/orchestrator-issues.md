# Orchestrator 实测问题复盘

> 记录一次真实会话中本插件暴露的问题，供后续修复使用。本文只做**现象记录 + 代码定位 + 修复建议**，不含补丁。
>
> - 会话目标：在 `atomic-workstation/dotfiles` 仓库修复截图功能（3 个并行子代理任务 + 1 个收尾任务），全程开启强制工作流。
> - 插件版本：本仓库 HEAD `7b69397`（`test,docs: 补充 LayerFS 引擎与机械门禁单元测试及使用文档`）。
> - LayerFS store：`~/.pi/agent/orchestrator-layerfs/dotfiles-6d027ce8ef43`。
> - 宿主工作区：`/var/home/lynimbus/dotfiles`（jj colocated 仓库，git HEAD detached 属正常状态）。
> - 集成测试命令：`bash tests/run.sh`（12 个套件）。

## TL;DR

最严重的问题是：**重复调用 `orch_integrate` 会发布一个「回退层」并把旧 tree 应用回宿主工作区**，静默抹掉整个 wave 的改动（3 个已修改文件回到原始内容、4 个新增文件消失）。

触发它的是一条连锁故障链：

```
集成测试 runner 的 TMPDIR 缺陷  →  集成测试假失败（5 个套件）
        ↓
失败日志只保留尾部（outputTail）→  主代理看不到根因，误判为「环境瞬时差异」
        ↓
主代理重试 orch_integrate      →  plan 状态未推进，同一 wave 被重复合并
        ↓
发布回退层 L4 并应用到宿主     →  修复被静默抹掉（数据丢失）
```

---

## 1. 证据：LayerFS 层序列

| 层 | parent | 文件数 | 说明 |
| --- | --- | --- | --- |
| L1 | – | 124 | 首个 plan 的 base（`git ls-files` = 124） |
| L2 | L1 | 124 | Wave 0（`tests/run.sh` 注册 3 个新套件） |
| **L3** | L2 | **128** | **正确集成层**，含全部 7 个修复文件 |
| **L4** | **L3** | **124** | **异常：以 L3 为父却少了 4 个文件，内容退回 L2** |
| L5 | L4 | 128 | 重新 plan 的 base（先 `git add` 4 个新文件后才达到 128） |
| L6 | L5 | 128 | 最终层，集成测试通过 |

第二次 `orch_integrate` 之后的宿主状态：

```
$ git status --short
 M tests/run.sh                      # 只剩 Wave 0 的残留
$ grep -n 'early-exit' home/chezmoi/dot_local/bin/executable_screenshot
15:    swappy -f - -o "$out" --early-exit || true   # 修复被还原
$ ls tests/test_screenshot*.sh
No such file or directory           # 3 个新增测试文件消失
$ ls home/chezmoi/dot_config/swappy/
(空)                                # 新增配置文件消失
```

L3 与 L4 的 tree 差异恰好是 7 个文件：3 个 modified（`keybindings.kdl`、`executable_screenshot`、`doctor.sh`）+ 4 个 added（`swappy/config`、3 个 `test_screenshot*.sh`）。

---

## 2. 问题清单（按严重度）

### P0 · 重复 `orch_integrate` 发布回退层并抹掉宿主改动

**现象**：首次 integrate 发布 L3（正确），集成测试失败；再次调用 integrate 想重跑测试，却发布 L4 —— parent 是 L3、文件数从 128 掉回 124、内容等于 L2，并把该 tree 应用到宿主，静默回滚整个 wave 的改动。全过程无任何警告。

**代码定位**：

- `index.ts:1031-1045`（`orch_integrate`）：集成测试 `exitCode !== 0` 时**提前 return**。层已经在 `mergeAndPublishWave` 里发布、`meta.headLayerId` 已前进到 L3，但下面这些状态更新全部没执行：
  - `for (const id of currentWaveIds) activePlan.tasks[id].state.status = "merged"`
  - `activePlan.baseLayerId = ...`
  - phase 推进 / plan 收尾

  结果：`orch_status` 显示 `READY_TO_INTEGRATE, Wave 1/1, Base Layer: L2`、3 个 task 仍是 `approved`，而 LayerFS 的 head 已是 L3 —— **状态机与存储不一致，同一 wave 可被再次合并**。

- `layerfs-engine.ts:651+ mergeAndPublishWave`：
  - `const baseLayer = this.loadLayer(meta.headLayerId)`（重复调用时 base 已是 L3）；
  - `candidatePaths = baseLayer.tree ∪ headCommit.tree`，`if (baseEntry?.objectId === branchEntry?.objectId) continue`；
  - 当 `entry === undefined` 且只有一个 touch 时执行 `delete mergedTree[relPath]`（约 710-720 行）。

  各 branch 的 `headCommit.tree` 是从 **L2** fork 出去的快照，只包含本分支的改动，缺少其它分支新增的文件。base 前进到 L3 后，这些「base 有、branch 无」的路径被解释为**该分支删除了文件**，于是跨分支新增文件被从 mergedTree 删掉。

- `layerfs-engine.ts:~830-860`：「Apply delta to host directory」把合并结果写回 `hostDir`，宿主工作区随之被改动/删除。

**建议**：

1. `orch_integrate` 幂等/防重入：wave 已 merged 或处于 `INTEGRATION_FAILED` 时，重复调用应直接拒绝或 no-op；集成失败也要推进 plan 状态，禁止同一 wave 重复合并。
2. 提供独立的 `retry integration`（只重跑测试命令，不重新合并、不重新发布层）。
3. merge 前校验每个 branch 的 fork base 是否等于当前 `meta.headLayerId`，stale branch 直接拒绝。
4. 发布前做 tree 校验：不允许相对父层**无显式删除理由**地减少文件；`L4.parent = L3` 却少 4 个文件这类层应拒绝发布。
5. 应用 host delta 前保留上一层 tree 快照，支持一键回滚；发布后做 `host ↔ layer` 一致性校验并报告差异。

---

### P1 · `executeWorkspaceCommand` 设置了 `TMPDIR` 却不创建目录（集成测试假失败）

**现象**：首轮集成报 `5 SUITE(S) FAILED`，但同一时刻在宿主上跑 `bash tests/run.sh` 是 `rc=0` / 12 套件全绿。第二轮日志给出实锤：

```
mktemp: failed to create file via template
'/var/home/lynimbus/dotfiles/.tmp/tmp.XXXXXXXXXX': No such file or directory
tests/test_dotfiles.sh: line 79: : No such file or directory
FAIL: rendered jj config is not valid TOML: ...
dotfiles: 7 checks, 1 failed
```

**代码定位**：`verifier.ts:193-218`

```ts
const tmpDir = path.join(workspacePath, ".tmp");
const cacheDir = path.join(workspacePath, ".cache");
spawn("bash", ["-c", command], {
  cwd: workspacePath,
  env: { ...process.env, TMPDIR: tmpDir, XDG_CACHE_HOME: cacheDir, CI: "1" },
});
```

**没有 `fs.mkdirSync(tmpDir, { recursive: true })`**。`layerfs-engine.ts:455-457` 只在 `provisionWorkspace`（子代理 workspace）里创建 `.tmp`/`.cache`；而 `index.ts:1036` 把**集成测试**的 `workspacePath` 传成 `ctx.cwd`（宿主工作区），宿主目录里并没有 `.tmp`。

**与 README 承诺的对照**：README 写「每个子代理拥有独立的 `.tmp/` 与 `.cache/`（自动绑定 `TMPDIR` 和 `XDG_CACHE_HOME`），绝不进入 Commit 或污染宿主机」。checkpoint/publish 不捕获 scratch 目录这个设计本身是对的，但**集成测试这条路径漏了创建目录**。

**影响**：所有无参 `mktemp`（`tests/test_dotfiles.sh:79`、`tests/test_screenshot_config.sh` 等）失败；显式写死 `/tmp/...` 的套件不受影响 —— 这正是「5 个失败、其余通过」的原因。同一命令在集成环境与真实工作区结果不一致，且失败原因与任何 task diff 都无关。

**建议**：`executeWorkspaceCommand` 在 spawn 前 `mkdirSync(tmpDir/cacheDir, { recursive: true })`；或集成测试显式用 `TMPDIR=/tmp` 兜底；失败输出中打印实际 `TMPDIR` 等环境摘要。本轮的规避是在用户项目侧给 `tests/run.sh` 加了守卫（`${TMPDIR:-/tmp}` 不存在/不可写时 `export TMPDIR=/tmp`），但**这不该由每个仓库各自实现**。

---

### P1 · base layer 只导入 git tracked 文件，untracked 新增文件不进 base

**现象**：`orch_plan` 报 `L1 (124 tracked files)`，与 `git ls-files | wc -l = 124` 完全一致。子代理新建的 4 个文件能经 branch diff 进入 L3（128），但它们在宿主上始终是 untracked；一旦某次发布不含它们的层（L4），就会从宿主消失。重新注册 plan 时，若不处理，新 base 仍只有 124 个文件，修复内容会再次丢失。

**规避**：本轮不得不 `git add` 那 4 个新文件，让 `git ls-files` 变成 128，`L5` 才正确导入全部内容；集成完成后再 `git reset` 还原未暂存状态。

**代码定位**：`index.ts:518`（`(Object.keys(baseLayer.tree).length} tracked files)`）、`layerfs-engine.ts` 的 `importHostAsLayer` / 初始导入与 ignore 过滤（约 115-125 行）。

**影响**：插件与最常见的 git 工作流（先改文件、审阅、最后才 `git add` / commit）不兼容。「新增文件」是最常见的改动，却是最脆弱的一类。

**建议**：初始导入纳入 `git ls-files --others --exclude-standard`（或提供开关）；至少在检测到 untracked 新增文件时给出警告，并让发布逻辑保留它们。

---

### P2 · 失败输出只保留尾部 64KB，丢失诊断信息

**现象**：第一次 `orch_integrate` 返回的输出只有末尾几十行，恰好是**通过**的 `screenshot_wiring: 31 checks, 0 failed`，看不到 5 个失败套件分别是谁、也没有任何 `FAIL:` 行。直到第二次因 `no such suite: screenshot` 以 exit 2 终止，才看到 `mktemp` 报错。

**代码定位**：`verifier.ts:223-226` —— `maxBuffer = 64 * 1024`，`combined = combined.slice(combined.length - maxBuffer)`，只返回 `outputTail`；`index.ts:1039` 直接把 `integrationResult.outputTail` 塞进失败信息。

**影响**：可观测性缺陷直接升级成数据丢失事故（见 TL;DR 的连锁链）。

**建议**：失败时额外返回 `outputHead`、所有 `FAIL:` / `Error` 行、失败套件名清单、完整日志的落盘路径；不要把输出按固定尾部截断。

---

### P2 · 失败引导与真实原因不匹配，缺少「只重跑集成测试」入口

**现象**：两次失败都提示 `Inspect the integration failure and either re-open/reject the offending task or register a follow-up fix plan.` 但根因（runner 的 TMPDIR、回退层）既不在任何 task 的 diff 里，`orch_review` 也无法重开已 approved 的任务；`orch_status` 一直显示 `READY_TO_INTEGRATE` / 3 tasks approved。

**影响**：修插件环境问题的唯一途径是「再写一个 plan、再派一次子代理」。本轮最后是靠一个 T4 收尾任务（改用户项目的 `tests/run.sh`）才让状态走完 —— 用业务改动去绕过工具缺陷。

**代码定位**：`index.ts:1043`（固定提示文案）、`index.ts:1031-1045`（失败分支不推进状态）。

**建议**：区分 `TASK_FAILURE` 与 `INTEGRATION_ENV_FAILURE`；后者给出诊断信息并提供 `retry integration only`。

---

### P2 · Mechanical Gate 按文件名分类 test file

**现象**：T4 的 Gate 报 `Implementation Diff (0 file(s))` 和 `Unit Tests Present: Updated 2 test file(s) (tests/run.sh, tests/test_screenshot_wiring.sh)`，仅因为 `run.sh` 位于 `tests/` 下。实际 `tests/run.sh` 是测试入口/基础设施，是本次唯一的实现改动。

**代码定位**：`layerfs-engine.ts:115 isTestFilePath`、`verifier.ts:61-63`（`f.isTestFile || matchesAnyPattern(...spec.testFiles) || isTestFilePath(f.path)`）、`index.ts:733/738`（用 `f.isTestFile` 分组展示 diff）。

**建议**：按 task 声明的 `allowedFiles` / `testFiles` 分类，或两类 diff 都展示，避免 Lead 在 review 时看到「实现为空」的误导。

---

### P3 · `orch_status` 不反映层 / 宿主一致性

**现象**：第一次 integrate 已发布 L3 到宿主，status 仍是 `READY_TO_INTEGRATE, Wave 1/1, Base Layer: L2`；第二次发布 L4 回滚宿主后也没有任何告警。只能靠手工比对 `L3.json` / `L4.json` 的 tree 和 `git status` 才发现数据丢失。

**建议**：status 增加 `lastPublishedLayer`、集成测试详细结果、`hostMatchesLayer: true|false`；tree 文件数异常减少时高亮告警。

---

### P3 · 子代理测试 cwd 隔离不足

**现象**：T1 worker 报告，用旧版脚本跑 mock 测试时 `grim` 的 stdout 被当成文件名写到仓库根目录，生成了一个名为 `-` 的文件，worker 自行 `rm -f ./-` 清理。

**建议**：`executeWorkspaceCommand` 对子代理单测也把 cwd 放到 scratch 目录，或在测试结束后检查并清理异常产物。

---

## 3. 连锁故障链（复盘重点）

| 环节 | 缺陷 | 后果 |
| --- | --- | --- |
| 1 | `verifier.ts` 未创建 `TMPDIR` 目录 | 集成测试假失败（5 套件） |
| 2 | `outputTail` 只给尾部 | 看不到根因，误判为环境瞬时抖动 |
| 3 | `index.ts` 失败时提前 return，plan 未推进 | 同一 wave 允许被重复 integrate |
| 4 | 主代理重试 integrate | `mergeAndPublishWave` 以 L3 为 base 重放 L2-era 分支 tree |
| 5 | 跨分支新增路径被当成「删除」 | L4 少 4 个文件，host 被 delta 覆盖，修复静默丢失 |

任何一个环节被修好，本次数据丢失都不会发生；**P0（幂等 + tree 校验）是最后一道、也是最关键的一道防线**。

---

## 4. 建议修复顺序

1. **P0**：`orch_integrate` 幂等 + 失败状态推进 + `mergeAndPublishWave` 的 stale-branch 校验与 tree 超集校验（防止数据丢失）。
2. **P1**：`executeWorkspaceCommand` 创建 scratch 目录（消除假失败）；base layer 纳入 untracked 新增文件。
3. **P2**：失败日志保留 head + 失败行；区分失败类型并提供 retry-integration；Gate 按声明分类。
4. **P3**：status 一致性展示；单测 cwd 隔离。

建议至少补 3 个回归测试（可放进 `test.ts`）：

- 同一 wave 连续调用两次 integrate，第二次必须 no-op 且 host tree 不变；
- 集成测试命令在 `TMPDIR` 指向不存在目录时仍可跑通（含无参 `mktemp`）；
- 初始导入一个含 untracked 新增文件的工作区，base layer 文件数应包含它。

---

## 5. 复现步骤

1. 在一个 git 仓库中开启强制工作流，注册含多个并行任务的 wave（让不同分支各自**新增文件**）。
2. 让 `integrationTestCommand` 使用无参 `mktemp`（如 `tmp="$(mktemp)"`）。
3. `orch_plan` → `orch_dispatch` → `orch_review`（全部 approve）→ `orch_integrate`。
4. 首次集成会因 `TMPDIR` 不存在报失败，但 L3 已发布；此时 `orch_status` 仍显示 `READY_TO_INTEGRATE`。
5. 再次调用 `orch_integrate` → 发布的层文件数回退，宿主工作区改动被抹掉。

---

## 6. 本轮规避措施（非插件修复）

1. 从 `L3.json` 的 tree + objects 精确检出 7 个文件回宿主（含 mode），恢复被 L4 抹掉的改动。
2. `git add` 4 个新增文件让 `L5` base 达到 128 files；集成完成后 `git reset` 还原未暂存状态。
3. 在用户项目 `tests/run.sh` 加 `TMPDIR` 兜底 + 动态回归断言，让坏 `TMPDIR` 不再造成假失败。
4. 只调用一次 integrate（`L6`），`bash tests/run.sh` 12 套件全绿。

最终结果：修复完整落地、`ALL SUITES PASSED`、编排器 `Active Plan: None` / `Workflow Switch: DISABLED`。

---

## 7. 修复记录（本仓库）

> 对应改动：`index.ts`、`layerfs-engine.ts`、`verifier.ts`、`subagent-runner.ts`、`types.ts`、新增 `integration-state.ts` / `test-regressions.ts`。`npm test` 全部通过。

### P0（数据丢失）

| 防线 | 实现 |
| --- | --- |
| 幂等状态机 | 新增 `INTEGRATING` / `INTEGRATION_FAILED` 阶段与持久化 `IntegrationRecord`；**集成测试失败也先推进 plan**（任务 `merged`、`baseLayerId` 前移）。`orch_integrate` 在已发布/已通过的 wave 上直接 no-op（`decideIntegrationAction` 纯函数，可单测）。 |
| 崩溃对账 | `reconcileIntegrationState` 按 LayerFS head 判断「层已发布但测试没跑完」，自动收敛为 `INTEGRATION_FAILED`，杜绝重复合并。 |
| 独立 retry | 新增 `orch_retry_integration`：只重跑测试命令，不合并/不发布/不改宿主；支持 `command` 覆盖。 |
| stale branch | `mergeAndPublishWave` 校验 `branch.baseLayerId == meta.headLayerId`（以及 `expectedBaseLayerId`），不一致直接拒绝。 |
| fork-base diff | 每个分支的 touch 集合相对**自己的 fork base 快照**计算，不再拿当前 head 当 base，跨分支新增文件不再被当成删除。 |
| tree 超集校验 | 父层有、合并后无的每个路径必须有分支显式删除，否则拒绝发布；`orch_plan` / Wave0 的 host import 若丢文件会给出 `treeRegressionWarning`。 |
| 宿主快照/校验/回滚 | 应用 delta 前持久化 `host-snapshots/<layerId>.json` pre-image（内容走 CAS）；应用后严格校验被合并路径，失败自动回滚且不发布层；新增 `orch_rollback_integration` 一键回滚并重新打开 wave。 |
| 发布顺序 | 先应用 + 校验成功，才 `saveLayer` 并推进 head —— 不再出现「层已发布但宿主未应用/应用失败」的不一致。 |

### P1（TMPDIR 假失败）

`executeWorkspaceCommand` 在 spawn 前 `mkdirSync` 并校验可写（失败回退 `os.tmpdir()`），同时设置 `TMP` / `TEMP`；宿主集成测试通过 `scratchRoot` 把 scratch 放到 LayerFS store 内，不污染仓库。

### P1（untracked 文件）——复盘修正

**此项原判断有误**：`importHostAsLayer` / `scanTree` 扫的是整个宿主目录树（只排除 `.git`、`.jj`、`.tmp`、`.cache`、密钥/私钥与共享依赖目录），**并不使用 `git ls-files`**，untracked 文件本来就会进 base layer。`L1 = 124 == git ls-files` 只是巧合（当时那 4 个文件尚未被创建）；它们之所以「消失」，是 P0 的回退层 L4 通过 delta 把它们从宿主删掉了，之后重新 plan 时宿主已经没有这些文件，`git add` 只是恢复手段之一。

已补回归测试确认 untracked 文件进入 base layer；同时把 `orch_plan` 的措辞从 `tracked files` 改为 `files scanned from the host working tree, including untracked files`，并增加 host import 丢文件告警。

### P2 / P3（诊断与隔离）

- 失败输出改为 **outputHead + 全量 failureLines + outputTail + 环境摘要**（`formatCommandDiagnostics`），不再只有尾部 40 行；review packet 同时展示 head/tail 与失败签名。
- `orch_status` 增加 `lastPublishedLayer`、head/parent 文件数与 ⚠ TREE REGRESSION、`host ↔ layer` 校验、集成状态与 exit code。
- 子代理单测结束后清理工作区根目录的异常产物（如 `-` 文件）；子代理进程增加硬超时、SIGTERM→SIGKILL 升级、监听器清理与 stdout 缓冲区上限。

### 顺带排查出的其他潜在问题

1. `loadMeta()` 遇到损坏/半写的 `store-meta.json` 会**静默重置**为全新 store（丢 head → 可能重新从被回退的宿主导入 L1），已改为抛错；layer/commit/meta 全部原子写入。
2. `executeWorkspaceCommand` 在 `signal` 已 aborted 时触发 `clearTimeout(timer)` 的 TDZ 错误；`proc.killed` 导致 SIGKILL 永远不会发出。均已修复。
3. 覆盖已有文件时 `writeFileSync({mode})` 不会改变已有文件权限，**可执行位丢失**；发布后未做 host ↔ layer 校验；`applyDelta` 会对真实目录执行 `symlinkSync` / 非递归删除而抛错。均已修复（显式 chmod、严格校验、拒绝危险目标、路径穿越防护）。
4. `orch_plan` 在已有活动 plan 时会静默覆盖状态并重新导入宿主；`orch_review` / `orch_dispatch` 缺少阶段校验，可能在合并后把 phase 倒回 `READY_TO_INTEGRATE`。均已加阶段闸门。
5. `activePlan.projectId` 原为 `undefined as any`；现已写入真实 projectId，并让 store 与宿主绝对路径绑定（换 cwd 复用同一 store 直接拒绝）。
6. `computeDependencyWaves` 的注释声称会把 `allowedFiles` 重叠的任务拆成子波次，实现并没有；目前仅靠三路合并的冲突检测兜底（**已知限制，未改动**）。
7. 全量 `host ↔ layer` 校验为 O(仓库文件数) 读盘；`orch_status` 才会做全量校验，合并时只严格校验被合并路径，其余漂移仅告警。
8. 遗留限制：若 wave 中存在 `escalated` 任务，合并后会把宿主直接编辑 re-import 成额外一层；该层没有 pre-image 快照，`orch_rollback_integration` 会明确拒绝而不是盲目回滚。
