# Aimlock task message entry

Use `cli-aimlock tasks capabilities <coordinationRoot>` to discover the task registration, routing, acknowledgement, handoff and resume schemas. JSON inputs use stdin. This entry calls the installed `cli-swarm/coordinator` directly and preserves its persistent ledger.

Before executing each new user requirement, restore the original task with `task-resume`, classify distinct items and call `message-route`. Reuse an existing owner when identified. Preserve uncertain requests and the current task's unfinished requirements. Do not append new user messages as replacement execution plans or overwrite chain state.

The installed Swarm reference `references/task-routing.md` defines the shared protocol, matching evidence, receipt validation and handoff lifecycle. Do not duplicate or maintain a separate routing algorithm in Aimlock.

The `cli-aimlock/tasks` export provides `handleTaskMessage(root,input,adapter,options)`. The IDE supplies an authorized destination-aware `deliver` function and `continueTask`. Each delivery must return the destination's persisted acceptance receipt. Atomic delivery claims prevent blind retries after process interruption. The helper checks authoritative message status and reports explicit failures; only a runnable source task continues. Delivery is bounded to 30 seconds unless the host sets a positive `options.deliveryTimeoutMs`. Timeouts preserve uncertain delivery without claiming it was cancelled; a runnable original task still continues.

Explicit forced assignment must preserve the current task checkpoint. Complete `handoff-release` at the previous owner's safe boundary, then obtain a fresh Aimlock contract/snapshot/pass for the receiving scope. After completion, the previous owner uses `handoff-resume` to refresh actual file fingerprints before rebuilding its own snapshot and continuing. Credentials, budgets and previous test receipts are never transferred as new authorization.

Status questions and explicit stop/cancel retain their existing host behavior. New requirements alone never cancel an unfinished goal. Each host must call this entry at its message boundary and consume pending inboxes after restart. The package cannot intercept unrelated hosts, create tasks or Git branches, install a background service, or grant access to unrelated accounts.
