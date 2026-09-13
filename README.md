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
- Lock / Probe / Swarm 分别强制 3 / 10 / 30 个文件与 2 / 8 / 60 分钟读取预算；Probe、Swarm 另有限制 30K / 100K 估算 token
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

每个命令从 stdin 读取 JSON。读取预算使用进程间原子锁，耗尽后只允许执行、输出方案或明确阻塞；文件/token 追加预算必须携带 Confirm Protocol 的低风险确认回执。长任务可先用 `budget-auto-renew-request` 生成目标、路径、续期间隔与次数上限，再凭一次真实回执调用 `budget-auto-renew`；同任务后续只自动续时间，累计额度与每次续期保留审计。达到次数/文件/token 上限仍明确阻断。撤销或完成时调用 `budget-auto-renew-stop`；本地执行链成功也会关闭预算。无凭证写入仅豁免 `.aimlock/logs/` 与 `.aimlock/tmp/`。

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

## 网络中断与原回执恢复

仅在 TLS 握手前确定尚未发送 HTTP 请求时，broker 才允许最多 3 次连接尝试，并受总超时约束。请求发出后发生断线或响应中断，只用 GET 查询原 requestId 的服务端回执，禁止重发 POST；未取得有效回执时保留不确定状态，不得假定成功或继续依赖步骤。

`npx cli-aimlock@latest recover <operation> <requestId>` 可重新查询原调用，不会重做操作或重复计费。链恢复不会跳过人工确认，也不会自动重跑结果不确定的本地命令。代理连接需 Node.js 22.21+ 或 24.5+；不支持的运行时会明确报错。

## 账号共享凭据与自动更新

在已登录的能力市场复制安装入口，将内容粘贴给 IDE。页面只展示原地址，剪贴板会携带当前账号凭据。IDE 将四字段凭据 JSON 经标准输入交给 `npx cli-aimlock@latest configure`；不要放到命令参数、项目文件或日志中。一次配置供同一操作系统账号的所有项目、分支和任务使用，八个技能共享同一文件。

默认位置：macOS 为 `~/Library/Application Support/CLI.Tax/broker/credential.json`，Linux 为 `~/.local/share/CLI.Tax/broker/credential.json`，Windows 为 `%LOCALAPPDATA%\CLI.Tax\broker\credential.json`。显式 `CLITAX_BRAIN_CLIENT_TOKEN_FILE` 仍按绝对路径覆盖默认位置；迁移旧 IDE 配置时移除其过时覆盖，再使用账号共享文件。macOS/Linux 校验当前账号所有权和0600权限；Windows校验仅当前账号与SYSTEM可访问的ACL。

每次新技能调用先查询官方发布版本，精确版本下载并校验身份后自动使用；更新已托管的当前项目与账号技能目录，失败恢复旧目录，禁止覆盖 Git 跟踪源码或未托管内容。升级返回 `upgrade.reloadRequired` 和说明路径时，IDE 应读取更新后的 SKILL.md、核对本任务合同再继续。install/check同样自动更新，不需要每次人工发升级指令。查询不确定调用的原回执不升级、不重发操作。

升级不会清除账号凭据；各调用重新读取共享文件，因此重新同步一次密钥后所有任务使用新值。已撤销或失效的密钥不能为自己取得新权限，必须从已认证网页重新同步一次。两个不同操作系统账号不共享私密文件。

English: configure once using JSON stdin; all tasks under the same OS account reuse the credential. Each new invocation checks and updates the official package and managed documentation. Reload updated instructions when indicated. Revoked keys require a fresh authenticated copy.

Русский: настройте ключ один раз через JSON stdin для всех задач пользователя ОС. Перед новым вызовом пакет и управляемые инструкции обновляются автоматически. Отозванный ключ требует повторной синхронизации с авторизованной страницы.
