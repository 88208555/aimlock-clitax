# cli-aimlock

Aimlock — 面向大型、深度、跨模块、高风险、并行或用户明确要求的工程修改的智能目标门禁（CLI.Tax 发布）。

低难度、预计不超过 500 行、非跨模块、非高风险、不并行且用户未明确要求 Aimlock 的需求不会启动完整链；应直接处理，或最多调用一个匹配专项技能。用户明确要求 Aimlock 时会激活门禁。

`run` 先在本地读取真实文件路径、最近 Git 改动规模、包边界和局部 import 图，推导目标文件、预计行数、跨模块和并行性；调用方自报值不会覆盖探测结果。信息模糊时从小档开始，超出实际预算后只逐级升级并继承已有快照和修改。bypass 不发起任何技能 HTTP 调用、不生成自动评价、不写需求文件。

Aimlock is for substantial or explicitly assigned engineering changes. Small low-difficulty work bypasses only when the user did not explicitly request Aimlock, and is handled directly or with one matched specialist.

`run` derives applicability from real paths, recent Git diffs, package boundaries, and the local import graph. Caller estimates cannot override this probe. Ambiguous work starts in the smaller mode and upgrades one level at a time while preserving existing evidence. Bypass makes no skill HTTP call, emits no automatic evaluation, and writes no requirements file.

Aimlock предназначен для существенных или явно назначенных инженерных изменений. Небольшая простая задача обходит цепочку только если пользователь явно не потребовал Aimlock, и выполняется напрямую либо одним профильным навыком.

`run` выводит факты из реальных путей, истории Git, границ пакетов и локального графа import; самооценка вызывающей стороны не переопределяет проверку. Неясная задача начинает с меньшего режима и повышается по одному уровню с сохранением доказательств. Bypass не выполняет HTTP-вызов, не создаёт автооценку и не записывает файл требований.

激活后，单文件不超过 500 行走 Lock，最多三个文件且总计不超过 500 行走 Probe；目标文件超过三个、总改动超过 500 行、跨模块或必须并行时走 Swarm。Aimlock 不授予磁盘、网络、账号或系统“完全访问”，调用方只能按任务申请可撤销的最小权限。

When active, Aimlock uses Lock for one file through 500 changed lines and Probe for at most three files through 500 lines; more than three target files, more than 500 lines, cross-module work, or required parallelism uses Swarm. Aimlock never grants full access: callers must use revocable, task-scoped least privilege.

После активации Lock применяется к одному файлу до 500 строк, Probe — максимум к трём файлам до 500 строк; более трёх целевых файлов, более 500 строк, межмодульность или необходимая параллельность переводят работу в Swarm. Aimlock не выдаёт полный доступ: разрешения должны быть минимальными, отзывными и ограниченными задачей.

- 把需求锁成可执行目标，阻止思考漂移、执行漂移、范围膨胀
- Bypass / Lock / Probe / Swarm 分档：小改绕过；深度修改才进入门禁
- 改前文件快照，禁止创建 git 分支
- Lock / Probe / Swarm 分别强制 3 / 10 / 30 个文件与 2 / 8 / 15 分钟读取预算；Probe、Swarm 另有限制 30K / 100K 估算 token
- Ed25519 写入凭证绑定 chainId、快照摘要、路径集合和最长 300 秒有效期
- `probe.targetSymbols` 可从新鲜的 ContextBase 项目地图解析真实目标文件；缺失、歧义或陈旧条目直接阻断
- 服务端按当前需求实时发现专项技能，只返回命中项；非计算需求不出现 Calctool

安装：`npx cli-aimlock@latest install`

## 可信本地执行

IDE 宿主先调用本地探测与预算，再把批量写入统一路由到 `guarded-write`：

```bash
cli-aimlock local capabilities .
cli-aimlock local probe .
cli-aimlock local budget-init .
cli-aimlock local budget-read .
cli-aimlock local gate-issue .
cli-aimlock local guarded-write .
```

每个命令从 stdin 读取 JSON。读取预算使用进程间原子锁，耗尽后只允许执行、输出方案或明确阻塞；追加预算必须携带 Confirm Protocol 的低风险确认回执。无凭证写入仅豁免 `.aimlock/logs/` 与 `.aimlock/tmp/`。

Swarm 模式下，`chain-plan` 会在 `swarm` 前插入 `coordinator.conflict-scan`。`gate-issue` 必须显式声明 `coordinationRequired`；为 true 时凭证绑定 `.coord/leases/` 中的签名文件锁，`guarded-write` 在同一拦截点同时校验门禁与活动租约。存在活动 `dependency-wait` 的 chain 会被 `budget-read` 拒绝。

物理边界：本包能拒绝所有经过 `guarded-write` 的无证写入，但不能劫持任意 IDE 的系统调用。IDE 集成必须禁止其他批量写入口，并让门禁运行在独立低权限宿主中；否则不得声称实现了全局物理拦截。


也可以直接从 CLI.Tax 对象存储安装（与站点「安装命令」一致）：

```bash
npx https://cli.tax/cli-downloads/clitax-R3mQ8kWpXn.tgz install
```

Source: https://github.com/88208555/aimlock-clitax.git

## 受限调用与自动评价

使用 `npx cli-aimlock@latest invoke <operation> '<JSON对象>'`，或让 IDE 以 JSON stdin 调用 `npx cli-aimlock@latest broker`。broker 本身只需要 Brain Client HTTPS、受限身份文件和显式传入路径，不需要完整磁盘访问。要保证 IDE 看不到 token，必须把 broker 作为独立低权限账户或沙箱服务运行并只暴露受限 IPC；同一系统账户下的 `0600` 不能隔离 IDE 与 broker。

Brain Client 服务端在同一次 runtime 请求的事务中绑定真实响应、生成并持久化权威评分与评语，再返回已提交回执。broker 只验证 `feedbackReceiptId`、`feedbackInvocationId` 和权威摘要，不发起第二次评价写入，也不生成分数或评语。`not-reported`、验证不完整、P0/P1 findings、`blocked` 或 `failed` 都不得生成好评；缺凭证、缺回执、摘要不匹配、响应非法或 HTTP 失败都会显式失败。

本地 CLI 不提供手工评分或评语提交命令，人类不能选择技能分数或填写技能评价。日常聊天不属于评价协议。
