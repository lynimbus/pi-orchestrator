# moejs 运行时引擎（engine/）

engine/ 用 [moejs](https://github.com/MoeForge/moejs)（纯 Go 的 JavaScript 运行时）加载本仓库的 TS 核心，不依赖 Node。`cmd/moetest` 在 moejs 下执行任意套件文件，用来验证核心逻辑在两种运行时下行为一致。

engine/ 是附加组件。Pi 扩展入口 `index.ts` 与全部核心 TS 源码零改动，`pi install` 的加载路径不变。engine/ 不参与 Pi 的扩展加载。

## 构建

```bash
cd engine
go build -o moetest ./cmd/moetest
```

需要 Go 1.27 或更高版本。moejs 从 Go module proxy 拉取，不需要本机 C 编译器。

## 运行套件

```bash
./moetest ../test-waves.ts
```

成功时最后一行打印 `moetest OK`，退出码 0。失败时打印断言错误与失败用例名，退出码 1。套件文件不需要任何改动，跑器在加载期完成全部适配。

`-e <code>` 模式按脚本执行代码，供 `process.execPath` 派生的子进程测试使用（等价于 `node -e`）。

## 对等性结果

下表为 moejs 跑器逐套件实测。复验命令为对每个文件执行 `./moetest <套件路径>`。

| 套件 | 结果 |
| --- | --- |
| test-tool-gate.ts | 17/17 通过 |
| test-thinking-levels.ts | 31/31 通过 |
| test-waves.ts | 45/45 通过 |
| test-session-config.ts | 52/52 通过 |
| test-primitives.ts | 41/41 通过 |
| test.ts | 全部通过 |
| test-packaging-manifest.ts | 11/11 通过 |
| test-packaging-docs.ts | 27/27 通过 |
| test-regressions.ts | 未过。依赖 node:module 的 CJS 互操作，属于 Node 运行时契约测试 |
| test-extension-wiring.ts | 未过。用 node --check 做语法检查并测 Pi TS API 接线 |
| test-worker-session.ts | 未过。经 getPiInvocation 派生真实 pi 进程，该调用假设 Node 宿主 |

## shim 层（参考）

跑器在加载期做两件事。一是把仓库文件里的 "node:fs" 改写为 "orch:fs"，核心源码保持 Node 可运行。二是提供以下模块的 shim。

- `orch:fs`。包装 moejs 的 node:fs，补齐 `lstatSync` 与 `statSync` 的 bigint 选项（由数字 stat 换算，mtimeNs 精度约微秒）、`chmodSync`、`symlinkSync`、`mkdtempSync`、`utimesSync` 与 `fs.promises` 对应方法，全部由 Go 标准库实现。bigint stat 的 `isFile` 一族方法需要覆写，原型方法会把 BigInt 隐式转数字并抛错。
- `node:path`。纯 JS 的 posix path 实现。
- `node:os`。`homedir` 与 `tmpdir` 指向隔离的临时目录 `$TMPDIR/moetest-home`，套件的 LayerFS 存储不会写进真实 home。
- `node:crypto`。`createHash("sha256")` 经 Go 原生函数实现，Buffer 内容经 base64 往返。
- `node:url`。`URL` 与 `fileURLToPath`，`import.meta.url` 由 Importer 的 Meta 钩子提供。
- `node:child_process`。`spawn` 由 Go `os/exec` 实现，stdout/stderr 分块与 close 事件经事件循环投递，`signalCode` 语义与 Node 一致。
- `node:assert/strict`。纯 JS 的严格断言实现，含 `deepStrictEqual`。

## 事件循环规则（参考）

moejs 的事件循环与 Node 的存活模型不同，跑器依赖三条规则。带顶层 await 的模块使 `Load` 返回 `ErrModulePending`，跑器按成功处理并让循环继续。`Loop.NewPromise` 的未决 promise 是存活根，每个 spawn 用它保活到 close。循环退出后投递的任务会被丢弃，所以跨 goroutine 的事件必须在循环存活期间投递。
