---
name: aimlock
description: "Aimlock 仅用于大型、深度、跨模块、高风险、需要并行协作或用户明确要求的工程修改，负责锁定目标、范围、快照和写入门禁。低难度、预计不超过 500 行、非跨模块、非高风险、不并行且未明确要求 Aimlock 的需求不要启动完整链；应直接处理或只调用一个匹配的专项技能。Use Aimlock only for large, deep, cross-module, high-risk, parallel, or explicitly requested engineering changes. Bypass low-difficulty work of at most 500 estimated lines only when it is not cross-module, high-risk, parallel, or explicitly assigned to Aimlock; handle it directly or use one matched specialist. Используйте Aimlock только для крупных, сложных, межмодульных, рискованных, параллельных или явно назначенных инженерных изменений. Простую задачу до 500 строк обходите только без межмодульности, высокого риска, параллели и явного требования Aimlock; выполните её напрямую либо одним профильным навыком."
---

# Aimlock Skill

Package version: v7.0.25

Endpoint: https://cli.tax/R3mQ8kWpXn

Request schema: `aimlock.skill.request/1.1`（运行时继续接受 `1.0` 存量客户端）

Response schema: `aimlock.skill.response/1.1`（`1.0` 请求返回 `1.0` 响应）

Aimlock is a high-overhead policy gate for substantial engineering work. It does not replace a specialist skill and must not turn a small change into a full workflow.

## Applicability gate

Apply this gate before calling `capabilities`.

Return `bypass` when every condition is true:

- `difficulty` is `low`;
- `estimatedChangedLines` is at most `500`;
- `crossModule` is `false`;
- risk is not `high`;
- `needParallel` is `false`;
- `explicitAimlockRequested` is `false`.

When bypassed, do not start intake, scope contracts, snapshots, workers, keep-alive, or a full chain. Tell the user:

`需求较小且低风险，不建议使用 Aimlock；请直接处理，或只调用一个匹配的专项技能。`

The CLI `run` command derives applicability from real target paths, recent Git diff sizes, package boundaries, and the local import graph. Caller-supplied estimates cannot override this probe. Ambiguous work starts in the smaller mode and upgrades one level at a time while preserving its snapshot and completed changes. A bypass performs no skill HTTP call, creates no automatic evaluation, and writes no requirements file.

At most one specialist may be recommended. A normal small code change needs no skill. A calculator request may use Calctool alone; a typed approval may use Confirm Protocol alone.

Activate Aimlock when any condition is true: difficulty is medium/high, more than 500 lines are expected, the work crosses modules, risk is high, parallel work is required, or the user explicitly requests Aimlock for the change.

English: bypass small low-difficulty work and use at most one matching specialist.

Русский: небольшую простую задачу обходите без Aimlock; допускается не более одного профильного навыка.

## Request envelope

POST JSON with an `input` wrapper:

```json
{
  "input": {
    "schemaVersion": "aimlock.skill.request/1.1",
    "requestId": "<unique-id>",
    "operation": "<operation>",
    "input": {}
  }
}
```

## Active Aimlock flow

Only after the applicability gate activates Aimlock:

1. Call local `capabilities`, then `probe`; use only its filesystem, Git-history, package-boundary, and import-graph facts for the initial mode. Exact `targetSymbols` may resolve through a fresh ContextBase map; missing, ambiguous, or stale map entries block.
2. Call remote `capabilities`, `intake`, and `classify`. A fallback `bypass` response stops the Aimlock chain.
3. Call `scope-contract`; empty allowed paths are blocked. Initialize the mode's local read budget before exploration.
4. Route every source read through local `budget-read`. Exhaustion requires `execute`, `plan`, or `blocked`; only a low-risk Confirm Protocol receipt may extend it.
5. Call `skill-route`. The server queries the current published official directory and injects only matched skills.
6. For Probe or Swarm, workers inspect read-only and return modification nodes. Lock stays on the current agent.
7. Call `propose-nodes`, `accept-nodes`, `snapshot-plan`, and `snapshot-verify` in order.
8. Issue a local signed mutation pass after `mutate-gate` permits the verified snapshot. Route each batch write through local `guarded-write` with the same chainId and pass.
9. If actual files or changed lines exceed the contract budget, call local `reassess`; upgrade only one level and preserve the current snapshot, changes, and evidence. Tell the user when this occurs.
10. Call `continuity-check` with real TestEvidence. Yellow or red means restore the copied snapshot.
11. Use `keep-alive` only while an active Aimlock goal is incomplete.

Never create a git branch or worktree. File-copy snapshots are the only isolation method.

For an active demand, `Lock` covers one file through 500 estimated changed lines and `Probe` covers at most three files through 500 estimated changed lines. More than three target files, more than 500 lines, cross-module work, or required parallel work routes to `Swarm`; difficulty and risk still decide whether Aimlock activates at all.

## On-demand specialist routing

Aimlock contains no static full-skill registry. `capabilities` does not preload the official catalog. `skill-route` is resolved by the CLI.Tax server from the current published directory, and the result contains matched skills only.

Required routing facts include `mode`, `goalKind`, `risk`, `contractUnclear`, blueprint/architecture state, and explicit booleans for confirmation, calculator, merge, and final validation needs.

- Calctool: only for a calculator demand or explicit calculation requirement. It must not appear in a non-calculation result.
- Confirm Protocol: only when a structured user decision is required.
- ArchGuard: only for code/mixed work in a new project or under an existing architecture contract.
- Blueprint: only for active Probe/Swarm work when `contractUnclear=true` and no blueprint exists.
- Swarm: only for active Swarm mode.
- Validator: only for high-risk work or an explicit final-validation requirement.
- MergeGuard: only for an explicit verified-merge requirement.
- User-named extras are analysis candidates until their own `capabilities` prove a match.

Caller-supplied full catalogs and local registry flags are forbidden. `serverResolvedSkills` is overwritten by the server; missing server resolution is blocked. Bypass routing returns no more than one recommendation and never constructs a chain.

## Operations

- `capabilities`, `help`, `intake`, `classify`
- `scope-contract`, `skill-route`
- `propose-nodes`, `accept-nodes`
- `snapshot-plan`, `snapshot-verify`, `mutate-gate`
- `continuity-check`, `interrupt`, `keep-alive`
- `run-status`, `chain-plan`, `chain-status`
- `delivery-doc`, `validate-json`, `feedback`

Trusted local operations: `capabilities`, `probe`, `reassess`, `budget-init`, `budget-read`, `budget-status`, `budget-extend`, `gate-issue`, `gate-verify`, and `guarded-write`. Invoke them as `cli-aimlock local <operation> <repositoryRoot>` with JSON stdin and call local `capabilities` first for every input Schema.

`chain-plan` accepts only server-resolved skill IDs. High-risk work is blocked if Validator was not resolved. When `swarm` is present, it inserts the internal `coordinator.conflict-scan` step immediately before it; no unrelated external skill is added.

## Interrupt and keep-alive

Call `interrupt` before acting on an interruption:

- forced stop → `stop`;
- status query → `status`;
- related addition → `fuse`;
- unrelated request → `spawn`.

For an active incomplete goal, the caller sends exactly every 90 seconds:

`智能目标持续执行中，请勿关闭！`

Aimlock returns the protocol; it does not start a timer.

## 实现状态

| ID | 能力 | 状态 | 边界 |
|---|---|---|---|
| A1 | 90 秒保活协议 | 已实现 | 返回固定消息和间隔；定时器由调用方负责，运行时不会自行推送。 |
| A2 | 运行状态查询 | 已实现（无持久化） | 仅验证调用方传入的状态；未传状态时明确返回 `known: false`。 |
| A3 | 官方技能按需路由 | 已实现 | 服务端读取当前已发布官方目录，只注入与需求匹配的技能；不加载完整目录。 |
| A4 | 快照写入门禁 | 已实现（需宿主路由） | 本地运行器重读真实文件副本并签发 Ed25519 短期凭证；凭证绑定 chainId、快照摘要和路径。只有经过 `guarded-write` 的写入能被物理拦截，IDE 宿主必须关闭旁路批量写入口。 |
| A5 | 真实分档与逐级升级 | 已实现 | 本地读取真实路径、Git 历史、包边界和 import 图；可从新鲜 ContextBase 地图解析精确目标符号；调用方自报复杂度不能覆盖探测，升级继承现有证据。 |
| A6 | 读取预算与截止 | 已实现（需宿主路由） | Lock/Probe/Swarm 限制 3/10/30 文件与 2/8/15 分钟；Probe/Swarm 另限 30K/100K 估算 token，并用进程间锁阻止并发超额。 |
| A7 | AutoCoord 物理联锁 | 已实现（需宿主路由） | `gate-issue` 显式选择是否需要协调；协调凭证绑定 Swarm 签名文件租约，`guarded-write` 在同一临界区校验凭证、活动锁和路径范围。活动依赖等待会阻断预算读取。 |

## Safety

- Never mutate before accepted nodes and verified file-copy snapshots.
- Never claim global write interception unless the IDE host routes every batch write through `guarded-write`; the package cannot intercept unrelated operating-system writes by itself.
- Never read source outside `budget-read` after a budget is initialized. Estimated tokens use the documented UTF-8-bytes/4 ceiling and are not an exact tokenizer count.
- Never issue a coordinated pass without a current signed `.coord` file lease. Never read while the same chain has an active `dependency-wait`.
- Never treat missing server routing, files, timeouts, or HTTP errors as empty success.
- Never send credentials in the request envelope.
- Aimlock never grants blanket disk, network, account, or operating-system access. The caller must request only the exact resource and action needed, prefer file/directory pickers and read-only or time-bounded grants, and revoke the grant after the task. If an integration only works with full access, stop and require a least-privilege adapter instead of bypassing the operating-system permission model.
- `blocked` and `failed` are not successful results.
- Delivery documents are optional and require explicit user confirmation.
- Do not expand a small request merely to justify Aimlock.

## 受限调用与自动评价闭环

- IDE / 智能体必须通过本包 `invoke` 或 JSON-stdin `broker` 调用，不得直接拼装技能 HTTP 请求，也不得读取 BrainClient token。
- broker 从 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 读取身份；macOS/Linux 文件必须为当前 broker 账户所有且权限 `0600`，Windows 文件必须位于受限 `%LOCALAPPDATA%\CLI.Tax\broker` 目录。
- broker 只需要 Brain Client HTTPS、受限身份文件和调用方显式传入的路径，本身不需要完整磁盘访问。若要保证 IDE 无法读取身份文件，必须把 broker 放进独立低权限系统账户或沙箱服务，并只暴露受限 IPC；broker 与 IDE 同账户运行时，`0600` 不能隔离二者，禁止声称令牌已隔离。
- broker 只用 `Authorization: BrainClient …` 发起一次 runtime 请求。HTTP 成功后必须保留响应顶层原始 `feedbackReceiptId`、`feedbackInvocationId` 和 `feedbackEvaluation.digest`，不得生成、猜测、复用或跨调用转移。
- Brain Client 服务端必须严格绑定请求/响应的 `requestId` 和 `schemaVersion`，再根据真实状态、验证结果、服务端耗时与 findings 生成并持久化权威评分、评语和摘要。broker 不得生成分数或评语。
- 同一次 runtime 请求在服务端事务内生成并持久化评价，再返回 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要；broker 只验证已提交回执，不发起第二次评价写入。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评。
- 缺少凭证或 ID、身份不匹配、摘要不匹配、响应非法以及任何 HTTP 失败都必须显式失败，不得静默、不重试成重复评价。
- 本地 CLI 不提供手工评分或评语提交命令，人类不得选择技能分数或填写技能评价；日常聊天不属于评价协议。

调用示例：`npx cli-aimlock@latest invoke <operation> '<JSON对象>'`。IDE 集成可向 `npx cli-aimlock@latest broker` 的 stdin 发送 `{"operation":"capabilities","input":{}}`。
