---
name: aimlock
description: "Aimlock 把用户需求锁成可执行的智能目标，阻止思考漂移、执行漂移和范围膨胀。主智能体先读本规范，禁止立刻改代码：先拆 JSON 任务，按范围合同分成 Lock / Probe / Swarm。Lock 档单文件小改由主脑快照后改写；Probe 档只读分析修改节点，确认后再写；Swarm 档才调用蜂群。Blueprint 编规划合同，Swarm 派单执行，Calctool 生成计算工具。改前文件快照，禁止创建 git 分支。插话先判关联再更新任务；强制停止立即停止。目标未完成交出控制权时每 90 秒发送「智能目标持续执行中，请勿关闭！」。交付文档需用户确认。调用前必须 capabilities，再按 nextStep 前进。Locks a user request into an executable aim to stop thought-drift, execution-drift, and scope blow-ups. Read this skill first; do not edit code yet. Split JSON tasks; classify Lock / Probe / Swarm. Blueprint for contracts, Swarm for dispatch, Calctool for calculators. Snapshot files before mutate; never create git branches. Interrupt: correlate first. Keep-alive every 90s while the aim is open. Delivery docs only if the user confirms. Always call capabilities first. Фиксирует запрос в исполняемую цель, чтобы остановить дрейф мысли, дрейф исполнения и раздувание объёма. Сначала эта спецификация, код не трогать. JSON-задачи, режимы Lock / Probe / Swarm. Blueprint — контракт, Swarm — раздача, Calctool — калькулятор. Снимок файлов до правки, без git-веток. Сначала capabilities."
---

# Aimlock Skill

Endpoint: https://cli.tax/R3mQ8kWpXn
Request schema: aimlock.skill.request/1.0
Response schema: aimlock.skill.response/1.0

Aimlock is a policy layer. It does not replace Blueprint, Swarm, or Calctool. Aimlock decides **when to fire, how wide, and how to stop drift**.

## Request envelope

POST JSON to the endpoint with an `input` wrapper:

```json
{
  "input": {
    "schemaVersion": "aimlock.skill.request/1.0",
    "requestId": "<unique-id>",
    "operation": "<operation>",
    "input": {}
  }
}
```

## Operations

- `capabilities`: modes, sibling skills, keep-alive text, first-use notice.
- `help`: operation catalog.
- `intake`: questions the IDE must ask before classify. One at a time.
- `classify`: choose `lock` | `probe` | `swarm` from explicit facts. Missing facts → `blocked`.
- `scope-contract`: allowed paths, forbidden paths, max changed lines, new-file / delete flags.
- `skill-route`: whether to call Blueprint, Swarm, Calctool.
- `propose-nodes`: validate read-only modification nodes against the contract.
- `accept-nodes`: auto-accept in-scope nodes; escalate worker conflicts.
- `snapshot-plan`: file-copy snapshot. Git branches and worktrees are forbidden.
- `mutate-gate`: mutate only after accept + snapshot.
- `continuity-check`: traffic-light budget, tests, omission scan.
- `interrupt`: `status` | `fuse` | `spawn` | `stop`.
- `keep-alive`: arm a 90s ping while the goal is open.
- `delivery-doc`: write a summary only if the user confirmed.
- `validate-json`: validate an Aimlock run JSON.

## Required flow

1. Call `capabilities`. On first use in the conversation, show `firstUseNotice` once.
2. Call `intake` and ask every **required** question one at a time. Do not mutate files.
3. Call `classify` with the answers. Do not invent file lists or line budgets.
4. Call `scope-contract`. Empty `allowedPaths` is `blocked`.
5. Call `skill-route` with `mode`, `goalKind`, `hasBlueprint`.
6. **Probe / Swarm:** workers read code only and return nodes. Call `propose-nodes` then `accept-nodes`.
7. **Lock:** the main agent still snapshots, then mutates inside the contract. No swarm.
8. Call `snapshot-plan`. Copy files into `snapshotRoot`. Never `git branch` / `git checkout -b` / worktree.
9. Call `mutate-gate`. If `blocked`, do not write.
10. After writes, call `continuity-check`. Red or yellow → roll back from the snapshot.
11. Before yielding while the aim is open, call `keep-alive` with `goalComplete: false` and send the returned message.
12. Reclaim temporary agents after green. Ask about `delivery-doc` only if intake said the user wants it.

### Classify rules (deterministic)

Facts required: `goal`, `targetFiles` (string array), `estimatedChangedLines`, `crossModule`, `needParallel`.

- **lock**: exactly one file, ≤ 20 lines, not cross-module, not parallel.
- **probe**: ≤ 3 files, ≤ 80 lines, not parallel.
- **swarm**: otherwise.

### Skill routing

Default allowlist is **official skills**. `capabilities` (platform) returns `officialCatalog`. Pass it into `skill-route` with `mode`, `goalKind`, `hasBlueprint`.

Call a hop only when `call` is true. That means the hop's capability matches this demand and the current chain allows it.

- Do not call chain-unrelated skills.
- Do not call self-extended or marketplace extras.
- Extra skills enter the candidate list only when the user names them (`userSpecifiedSkills`). Then call that skill's `capabilities` and invoke only if its capability matches the demand.

Do not call Calctool unless the aim is a calculator tool.

### Interrupt

Call `interrupt` with `forceStop`, `isStatusQuery`, `related` as booleans. Do not execute a new request first.

- `stop`: user forced stop.
- `status`: report only.
- `fuse`: related; signal the running agent; update JSON; continue.
- `spawn`: unrelated; new temporary agent; do not hijack the current aim.

### Keep-alive

When the aim is incomplete and the IDE is about to yield, send exactly:

`智能目标持续执行中，请勿关闭！`

Interval: 90 seconds. Do not ping every 10 seconds. When `goalComplete` is true, do not arm.

## Safety rules

- Never create a git branch. Isolation is a file-copy snapshot plus a temporary agent context.
- Never mutate before `mutate-gate` returns `allowed: true`.
- Never treat missing files, timeouts, or 4xx/5xx as empty success. `blocked` and `failed` are errors.
- Never send credentials in the envelope.
- The response `status` must be `succeeded`; `blocked` and `failed` are not results.
- Do not expand 1 line into 100. Over-budget is red; roll back.
- Delivery documents are optional. Skip unless the user confirmed.

## Examples

### Lock: one-line constant

User: 只改税率常量一行.

`classify` → `lock`. Snapshot that file. Change the one line. `continuity-check` must stay within `maxChangedLines`.

### Probe then mutate

User: 修支付回调的状态机，可能有上下游.

`classify` → `probe`. Worker returns nodes. If a node points outside `allowedPaths`, `propose-nodes` is `blocked`. After accept + snapshot, mutate.

