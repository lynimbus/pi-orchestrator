# Pi Orchestrator

独立的通用 Pi 插件（仓库：<https://github.com/lynimbus/pi-orchestrator>），以 **Pi git 包**的形式从 GitHub 安装与更新：克隆、缓存、版本解析全部由 Pi 管理，你不需要再手工把文件拷进 `~/.pi/agent/extensions/`。开启后强制执行 **「主代理拆解任务 → LayerFS 分支隔离并行派发子代理（强制配套单元测试） → 机械门禁校验 → 主代理仅审查 Diff 与测试 → LayerFS 三路合并与集成验证」** 工作流。

## 安装

主命令（HTTPS，推荐）：

```bash
pi install git:github.com/lynimbus/pi-orchestrator
```

SSH 备选（已在本机配置 GitHub SSH key 时可用）：

```bash
pi install git:git@github.com:lynimbus/pi-orchestrator
```

- 安装只会把一条 **包声明写进 `~/.pi/agent/settings.json` 的 `packages` 数组**（形如 `"git:github.com/lynimbus/pi-orchestrator"`）。随后的 **克隆、缓存与扩展加载都由 Pi 管理**，不再需要手工拷贝文件，也不需要在 extensions 目录里维护副本。
- 需要固定版本时加 `@<ref>` 后缀，例如 `pi install git:github.com/lynimbus/pi-orchestrator@v0.1.0`；不带 `@` 则跟随仓库默认分支。
- 安装完成后需 **重启 Pi**，或在当前会话执行 **`/reload`**，新扩展才会生效。
- 想确认装上了什么，用 `pi list` 查看已安装的包及其来源。

## 更新

```bash
pi update git:github.com/lynimbus/pi-orchestrator   # 只更新这一个 git 包
pi update --extensions                              # 更新全部已安装的扩展包
```

- git 包以 **仓库 URL 为身份标识**（`git:github.com/lynimbus/pi-orchestrator`），`pi update` 按该标识重新拉取对应仓库。
- 安装/更新时带了 `@<ref>`（例如 `@v0.1.0`、`@<commit>`）就是 **固定版本**：`pi update` **不会**把它移动到更新的 ref；想跟随分支就改回不带 `@` 的仓库 URL 重新安装。
- 更新完成后需 **重启 Pi**，或执行 **`/reload`** 才会用上新代码（扩展是进程内加载的，旧版本不会自动替换）。
- `pi list` 可随时查看已装包、来源与版本标识。

## 从本地目录副本迁移（去掉本地拷贝）

老版本是手工把代码拷进 `~/.pi/agent/extensions/orchestrator` 的（迁移前要先打包备份的 legacy 副本），这份副本已经过期、不再需要。

**为什么迁移后只保留 git 包**：Pi 判断「这是不是同一个包」靠**包身份去重**，可用的身份标识是 **npm 包名 / git 仓库 URL / 本地绝对路径**这三类；`~/.pi/agent/extensions/orchestrator` 这个手工副本（迁移前要备份的那份）没有包声明，与 `git:github.com/lynimbus/pi-orchestrator` 属于**两条不同来源**，不会被 Pi 认成同一个包。因此两者共存时**可能触发同名扩展重复加载或加载歧义**——具体加载几次、`/orch` 命令最终解析到哪份代码，取决于 Pi 的加载顺序与去重实现，本文档对此**不做断言**（属于未在当前环境验证过的运行时行为）。可验证的稳妥结论是：迁移结束后**只保留 git 包**，旧副本打进 `.backup` 归档留档即可。

1. **先装 git 包**：按上面的 `## 安装` 执行 `pi install git:github.com/lynimbus/pi-orchestrator`，并用 `pi list` 确认它已在列表里。

2. **备份本地副本**（迁移前必须先备份，别直接删）：

   ```bash
   mkdir -p ~/.pi/agent/extensions/.backup && tar -czf ~/.pi/agent/extensions/.backup/orchestrator-$(date +%Y%m%d-%H%M%S).tgz -C ~/.pi/agent/extensions orchestrator
   ```

3. **移除本地拷贝**：

   ```bash
   rm -rf ~/.pi/agent/extensions/orchestrator
   ```

4. **校验**：
   - `pi list` 输出中能看到 `git:github.com/lynimbus/pi-orchestrator`，且 extensions 目录下不再有同名目录；
   - 重启 Pi（或执行 `/reload`）后，`/orch status` 能正常返回当前波次状态与 LayerFS 存储统计。

5. **回滚**（想退回本地副本时）：把备份解回 extensions 目录，并卸掉 git 包，二者不要共存：

   ```bash
   tar -xzf ~/.pi/agent/extensions/.backup/orchestrator-<时间戳>.tgz -C ~/.pi/agent/extensions
   pi remove git:github.com/lynimbus/pi-orchestrator
   ```

## 本地开发

```bash
git clone https://github.com/lynimbus/pi-orchestrator
cd pi-orchestrator
npm test        # node ./test.ts && node ./test-regressions.ts && node ./test-waves.ts && node ./test-packaging-manifest.ts && node ./test-packaging-docs.ts
```

本地调试有两种方式，都指向当前工作目录，不写死绝对路径：

- **写进个人设置**：在仓库根目录执行 `pi install ./`（把 `./` 作为本地包写进个人设置），改完代码后重启 Pi 或 `/reload` 生效；开发完成后用 `pi remove ./` 摘掉这条本地声明。
- **临时加载**：`pi -e ./index.ts` 直接加载入口文件跑一次，不写任何设置，适合快速验证。

> 仓库内还带了一个形式化验证技能 **`.agents/skills/verify-wave-integration`**：修改 `integration-state.ts`、`index.ts` 的集成流程（`orch_integrate` / `orch_retry_integration` / `orch_rollback_integration` / `reconcileIntegrationState`）或 `layerfs-engine.ts` 的 `mergeAndPublishWave` 之前，请先跑它。它对「波次只从 base 层合并一次、崩溃对账不卡死、回滚保留任务状态」做穷尽式模型检查，能挡住重复合并抹掉文件这类事故。

---

## 快速上手

### 1. 开关与配置命令
在 Pi 交互界面中：
- **`/orch`**：打开交互式设置菜单（开关工作流、选择子代理模型、调节子代理思考等级、并发度、重试上限、人工确认点、查看 LayerFS 存储去重指标等）
- **`Ctrl+Alt+O`**：一键切换 Orchestrator 强制工作流 **ON / OFF**
- **`/orch on` / `/orch off` / `/orch toggle`**：命令行开启或关闭工作流
- **`/orch model [provider/modelId | inherit]`**：调节子代理使用的模型（不传参数则弹出模型选择列表；设为 `inherit` 则跟随主代理当前模型）
- **`/orch thinking [off|minimal|low|medium|high|xhigh|inherit]`**：调节子代理思考等级（不传参数则弹出等级选择列表）
- **`/orch status`**：查看当前任务波次状态与 LayerFS 对象存储去重统计
- **`/orch reset`**：重置当前正在执行的编排计划

启动时也可通过 CLI 参数直接控制：
```bash
pi --orch --orch-model group/deepseek --orch-thinking medium
```

配置文件持久化保存在：`~/.pi/agent/orchestrator.json`。

---

## 强制执行机制（开启后主代理无法绕过）

1. **工具级拦截 (`tool_call` Gate)**：
   - 主代理直接调用 `write` / `edit` 修改业务代码会被直接拦截，要求必须先通过 `orch_plan` 注册任务拆解计划并派发子代理。
   - 仅在 `WAVE_0` 阶段允许主代理编辑 `wave0Files` 中声明的公共类型/接口桩文件，或在子代理重试超过上限被标记为 `escalated` 后允许主代理兜底接管对应文件。
   - 子代理进程 (`PI_ORCHESTRATOR_WORKER=1`) 同样受此插件保护：子代理试图修改 `allowedFiles` + `testFiles` 之外的任何文件会在 `tool_call` 阶段被当场拦截。

2. **LayerFS 架构并行防冲突 (`layerfs-engine.ts`)**：
   - 参考 [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) 的 `LayerStack` / `Layer` / `Branch` / `Commit` / `Workspace` 模型构建：
     - **内容寻址存储 (CAS)**：所有文件按 SHA-256 `ObjectId` 全局去重存储于 `~/.pi/agent/orchestrator-layerfs/<project>/`，自动过滤 `.git`、`.jj`、`.env*` 密钥与私钥文件。
     - **零拷贝依赖共享与临时目录隔离**：`node_modules`、`.venv`、`target` 等重型依赖通过 O(1) 符号链接共享；每个子代理拥有独立的 `.tmp/` 与 `.cache/`（自动绑定 `TMPDIR` 和 `XDG_CACHE_HOME`），绝不进入 Commit 或污染宿主机。
     - **Compare-And-Swap (CAS) 提交与三路合并 (`mergeAndPublishWave`)**：同一波次的所有子代理从同一不可变 `Layer` 分叉出各自的 `Branch`；波次结束时执行确定性三路树合并与非重叠行块合并，冲突时保留各分支现场并输出冲突块预览。

3. **第一层机械门禁 (`verifier.ts`，零 Token 消耗)**：
   - **文件越界检查 (`fileScope`)**：核对变更文件是否严格处于 `allowedFiles` + `testFiles` 内。
   - **配套单元测试强制检查 (`unitTestsPresent`)**：必须新增或修改单元测试文件且包含有效断言。
   - **反作弊测试完整性检查 (`testIntegrity`)**：自动扫描并拦截 `.only`、`.skip`、`xit`、`t.Skip`、`#[ignore]` 或删除测试文件的行为。
   - **独立测试执行 (`testExecution`)**：由插件在隔离工作区内独立运行 `testCommand`，不轻信子代理自报结果。

4. **第二层主代理纯 Diff 审查 (`orch_dispatch` → `orch_review`)**：
   - `orch_dispatch` 只向主代理返回 **实现代码 Unified Diff**、**单元测试 Unified Diff**、**机械门禁清单** 和 **子代理假设/偏离报告**，保护主代理上下文窗口。
   - 机械门禁未通过的任务，主代理调用 `orch_review(approve)` 会被硬性拒绝，只能 `reject` 打回原工作区重做（最多 `maxRetries` 次）或 `escalate`。

---

## 集成（每个 wave 只调用一次 `orch_integrate`）

> 历史事故：集成测试失败后重试 `orch_integrate`，插件发布了「回退层」并静默抹掉整个 wave 的改动。详见 [`docs/orchestrator-issues.md`](docs/orchestrator-issues.md)。

| 工具 | 作用 |
| --- | --- |
| `orch_integrate` | 三路合并 + 发布不可变 Layer + 应用到宿主 + 跑集成测试。**同一 wave 只执行一次**；层一旦发布，重复调用一律 no-op（`INTEGRATION_FAILED` / `COMPLETED`）。 |
| `orch_retry_integration` | 只重跑集成测试命令，**不合并、不发布层、不改宿主**。可传 `command` 覆盖命令。 |
| `orch_rollback_integration` | 用发布前的宿主快照一键回滚最新层（恢复文件与 mode、重置 head），并把该 wave 重新打开为 `READY_TO_INTEGRATE`。 |

状态机：`READY_TO_INTEGRATE → INTEGRATING → (通过) COMPLETED / 下一波`，失败则 `INTEGRATION_FAILED`（**层已发布、改动已落地，只是测试没过**）。集成测试无论成功失败，plan 状态都会先推进（任务置 `merged`、`baseLayerId` 前移、host/store 一致），因此不存在「状态没动但 head 已前进」的窗口；进程中断也会在下次调用时按 LayerFS head 自动对账。

### 数据安全闸门

- **stale branch 拒绝**：每个分支的 fork base 必须等于当前 `meta.headLayerId`，否则拒绝合并。
- **fork-base 差异计算**：分支 head tree 是「fork base 的完整快照」，touch 集合必须相对**分支自己的 fork base** 计算（原来相对当前 head 计算，会把别的分支新增的文件误判成删除）。
- **无理由删除校验**：父层中出现、合并后消失的每个路径，都必须有分支显式删除，否则拒绝发布（防止回退层）。
- **宿主快照 + 一致性校验**：应用 delta 前保存宿主 pre-image；应用后严格校验所有被合并路径，失败自动回滚且不发布层。未触及路径的漂移只告警、不阻断。
- **mode 与 symlink 安全**：覆盖已有文件后显式 `chmod`（可执行位不会丢）；拒绝覆盖/删除宿主上的真实目录；拒绝 `..` 路径穿越。
- **store 绑定**：LayerFS store 与宿主绝对路径绑定；`store-meta.json` 损坏时抛错而非静默重置（否则会丢失 head）；layer/commit/meta 均原子写入。
- **状态展示**：`orch_status` 报告 `lastPublishedLayer`、head/parent 文件数（减少时高亮 ⚠ TREE REGRESSION）、`host ↔ layer` 校验结果、集成测试 exit code 与诊断。

### 测试执行环境

- `executeWorkspaceCommand` 在 spawn 前**创建** `TMPDIR` / `XDG_CACHE_HOME`（含 `TMP`/`TEMP`），不可写时回退到 `os.tmpdir()`；宿主集成测试的 scratch 放在 LayerFS store 内，不污染仓库。
- 失败输出保留 **输出头部 + 全量失败签名行 + 尾部**（原来只有尾部 40 行，会丢根因），并打印环境摘要。
- 子代理单测结束后清理工作区根目录新产生的垃圾文件（如误写出的 `-` 文件）；子代理进程有 15 分钟硬超时、SIGTERM→SIGKILL 升级与缓冲区上限。

---

## 测试

```bash
npm test    # node ./test.ts && node ./test-regressions.ts && node ./test-waves.ts && node ./test-packaging-manifest.ts && node ./test-packaging-docs.ts
```

`npm test` 现在是**五段链**，也可以按需单独跑某一段：

- `node ./test.ts`：核心编排 / LayerFS 行为
- `node ./test-regressions.ts`：回归用例
- `node ./test-waves.ts`：多波次与派发用例
- `node ./test-packaging-manifest.ts`：包清单契约（`package.json` 的 `pi.extensions`、入口文件、`npm test` 脚本段数等）
- `node ./test-packaging-docs.ts`：纯文本契约测试，保证这份 README 的安装/更新/迁移叙事不会退回「手工拷贝目录」的老写法

`test-regressions.ts` 覆盖：重复 integrate 被拒且宿主不变、跨分支新增文件不丢、宿主快照/校验/回滚/重合并、可执行位、非相关漂移、TMPDIR/诊断/超时、损坏 meta、source root 绑定、集成状态机。
