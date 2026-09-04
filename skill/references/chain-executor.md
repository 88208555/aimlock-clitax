# 持久 CLI 链执行器

服务端技能仍是无状态协议；宿主通过显式计划执行真实步骤，将状态写入仓库的 `.aimlock/executions/<chainId>/state.json`。旧 `run` 仍负责适用性判断与需求采集，生成需求文件不等于执行技能链。

## 命令

```sh
cli-aimlock chain init /absolute/repository < execution-plan.json
cli-aimlock chain resume /absolute/repository my-chain
cli-aimlock chain status /absolute/repository my-chain
cli-aimlock chain answer /absolute/repository my-chain human-actor
```

`init` 只验证并保存不可变计划与已安装技能元数据，不触发 HTTP。
`resume` 按依赖顺序执行尚未完成的步骤；已成功步骤不会重复调用。
`status` 只读取本地状态。等待时退出码为 2，失败/结果不确定为 1。
`answer` 必须在真实交互终端使用，读取展示后的选项 ID；拒绝重定向答案。actorId 是本地审计标签，不代表服务端已验证真人身份。

## 显式计划

```json
{
  "schemaVersion": "aimlock.execution-plan/1.0",
  "chainId": "my-chain",
  "skills": [],
  "steps": [
    {
      "stepId": "test",
      "kind": "command",
      "skillId": null,
      "operation": "exec",
      "input": {
        "executable": "/usr/local/bin/node",
        "args": ["--test"],
        "workingDirectory": ".",
        "timeoutMs": 600000,
        "evidenceKind": "test",
        "environment": {}
      },
      "dependsOn": [],
      "bindings": []
    }
  ]
}
```

每步必须提供全部七个字段；Confirm interaction-request 可额外声明 continueWhen。其它额外字段均拒绝。支持三种 kind：

- `skill`：skillId 必须在 skills 中声明 `{skillId, packageRoot}`；packageRoot 指向已安装 npm 技能包。复用受限 broker 的真实 HTTP、requestId 校验、自动评价和提交回执；不读取或输出令牌。初始化后的包元数据变化会阻止恢复。
- `coordinator`：skillId=null，operation 使用 Swarm 本地接口。`dependency-wait` 会实际登记并驱动 `wait-for-event`/tick，保存唤醒包；不是仅返回 nextStep。`resolve-human` 禁止从计划注入。
- `command`：skillId=null、operation=exec，按显式 executable/args 执行无 shell 的真实进程；workingDirectory 限于仓库，timeoutMs 为 1..3600000，输出上限 1 MiB，超限/超时/非零退出显式失败。命令输入不得动态绑定；environment 必须显式提供字符串字典，spawn 不继承宿主环境，拒绝令牌、私钥、授权等保留变量。使用非绝对 executable 时应显式声明 PATH。示例路径需改成实际 Node 安装位置。evidenceKind 为 test/build/lint/security/benchmark。

步骤必须按拓扑顺序排列；依赖只能引用前面已声明的步骤。运行时仅从已成功步骤的实际输出取值，忽略服务端 nextStep/completed 字段，不据此调用隐含步骤。

绑定使用 RFC 6901 JSON Pointer：
```json
{
  "stepId": "dispatch",
  "kind": "skill",
  "skillId": "swarm",
  "operation": "dispatch",
  "input": { "tasks": null },
  "dependsOn": ["compile"],
  "bindings": [
    { "stepId": "compile", "source": "/machineTasks/tasks", "target": "/tasks" }
  ]
}
```

这里 compile 必须是计划中真实调用 Blueprint compile-inline 的步骤，并在 skills 声明两个安装包。source 指向协议 output 本身，不含 broker 外层包装。目标键必须事先在 input 中声明；缺失值、非法指针、循环依赖均报错。Blueprint 的 blueprintSha256 与 criterionId 原样绑定；不要重算或改变前缀。

## 等待、恢复与证据

- 持久记录 pending/running/waiting/blocked/failed/uncertain/succeeded、调用 ID、实际 requestId、输入摘要、结果、反馈回执和错误。网络发送前先保存 requestId。
- 事件到达才记为依赖满足。死亡、放弃和超时不冒充事件成功；人工选中恢复时保留 `resolved-by-human`、原唤醒原因与 Confirm 审计。
- 遇到 Swarm 高风险裁决，必须在 skills 声明 confirm-protocol 包。宿主真实调用 interaction-request，保存待答状态。resume 不会代答；answer 读取终端输入、真实调用 interaction-answer，校验问题/答案/回调绑定后才调用 resolve-human。
- 普通 Confirm 步骤还必须声明结构化继续条件，例如步骤字段 `continueWhen: {"answer":"yes"}`。协议没有通用“同意”的 option ID；不依据 label 推测授权。真人答案未匹配或未声明条件时，下游保持 blocked；choice/input/multi 同样须明确条件。
- Validator 的协议 succeeded 不代表验收通过：verdict=incomplete/blocked、空或失败执行证据、sandbox-run 等 pending-execution 描述均阻塞链。原协议结果与回执仍保留，不能冒充已执行测试。
- 普通技能 blocked/failed 保持阻塞/失败，不自动重试。发送后断线、无法校验回执、执行中断等不确定结果禁止自动重发；应先人工核查外部效果，再制定新计划。已登记的事件等待可恢复轮询，不重新声明等待。
- 本地命令提供 `cli.tax.test-evidence/1.0`：真实 exitCode、durationMs、stdout/stderr 摘要；runner=local、producer=local-cli-process、independentRunnerVerified=false。可把 output.evidence 绑定到 Blueprint acceptance-report 的逐项 results；报告对账不等于独立可信执行。
- 同链正常 completed 任务不再封锁活跃同伴；全部终态仍封锁。失败/回收任务必须显式注册 supersedesTaskId，保留原任务历史、范围与约束，并先处理人工裁决；任意新任务不构成失败豁免。
- 人工选中 active 任务后，同链未选中的 human-decision 停放任务可继续保持 blocked；旧 lease 不能写入，因为写入联锁仍要求对应 taskId 为 active。未决裁决继续阻止读取与写入。

## 边界

共享 chainId 的只读预算不是智能体身份隔离。命令步骤是用户已声明的本地进程调用，不是操作系统沙箱，不拦截任意外部进程或其文件读取，也不保证其他命令自动遵守 Aimlock 写入门禁。修改源码的受控调用仍必须走 guarded-write 和有效快照/租约。没有隐式 ContextBase 调用；不要省略其适用的预算链参数。没有独立桌面壳或 OS 弹窗承诺；当前 Confirm 宿主是 CLI 终端。

排队锁恢复：允许排队的请求必须显式给出正整数 `queueTimeoutMs`，与授锁后 `ttlSeconds` 独立；`lock-acquire` 返回 queued 后保存 queueId 并挂起本步骤；`resume` 运行一次协调扫描后只查询 `lock-queue-status`，不会重放申请。只有同一任务、链、资源、路径及当前未过期租约全部匹配的真实 grant 才继续。仍在排队时返回包含 deadlineAt 的等待快照；到期后 tick 落账并返回 need-human/Confirm 请求，原队列阻断。本执行器不会把队列超时的人工恢复解释为已授锁；宿主需处理返回的确认，再提交新的显式申请。终止、过期、失配及旧版缺少 queue→grant 关联的授锁明确阻断，不推测归属。

命令结束与进程回收分开记录：超时或输出超限后最多再等待 1 秒关闭输出管道。仍无法确认回收时返回 `uncertain` 和空执行证据，释放执行锁并禁止自动重放；这不证明脱离进程已停止。已启动子进程后落账失败同样按结果不确定记录。
