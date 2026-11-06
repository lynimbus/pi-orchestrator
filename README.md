# Pi Orchestrator (`~/.pi/agent/extensions/orchestrator`)

独立的通用 Pi 插件，开启后强制执行 **「主代理拆解任务 → LayerFS 分支隔离并行派发子代理（强制配套单元测试） → 机械门禁校验 → 主代理仅审查 Diff 与测试 → LayerFS 三路合并与集成验证」** 工作流。

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
