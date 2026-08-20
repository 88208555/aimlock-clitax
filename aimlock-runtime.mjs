// aimlock runtime v1.0.1 — lock the aim, then fire. Self-contained, no relative imports.
const REQUEST_SCHEMA = "aimlock.skill.request/1.0";
const RESPONSE_SCHEMA = "aimlock.skill.response/1.0";
const ERROR_SCHEMA = "aimlock.skill.error/1.0";
const CONTRACT_SCHEMA = "aimlock.scope-contract/1.0";
const COMPILER_NAME = "aimlock";
const COMPILER_VERSION = "v5.0.2";
const KEEP_ALIVE_SECONDS = 90;
const KEEP_ALIVE_MESSAGE = "智能目标持续执行中，请勿关闭！";
const LOCK_LINE_BUDGET = 20;
const PROBE_LINE_BUDGET = 80;
const PROBE_FILE_BUDGET = 3;
const CATALOG_SCHEMA = "cli.tax.skill-catalog/1.0";

const OPERATIONS = [
  "capabilities", "help", "intake", "classify", "scope-contract", "skill-route",
  "propose-nodes", "accept-nodes", "snapshot-plan", "mutate-gate",
  "continuity-check", "interrupt", "keep-alive", "delivery-doc", "validate-json",
];
const PURE_OPERATIONS = new Set(OPERATIONS);
const OPERATION_CATALOG = Object.freeze(OPERATIONS.map((operation) => ({ operation, summary: operation })));

const GOAL_KINDS = new Set(["code", "calculator", "mixed", "docs"]);
const MODES = new Set(["lock", "probe", "swarm"]);

function text(value) { return String(value ?? ""); }
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finding(severity, ruleId, entityRef, message, evidence = {}) {
  return { severity, ruleId, entityRef, message, evidence };
}
function okResponse(requestId, payload) {
  return { schemaVersion: RESPONSE_SCHEMA, requestId, status: "succeeded", ...payload };
}
function blockedResponse(requestId, findings) {
  return {
    schemaVersion: RESPONSE_SCHEMA, requestId, status: "blocked",
    validation: { valid: false, guarantee: "blocked", findings },
  };
}
function failed(requestId, code, message) {
  return {
    schemaVersion: RESPONSE_SCHEMA, requestId, status: "failed", errorSchema: ERROR_SCHEMA,
    error: { code, message },
  };
}

function requireText(input, key) {
  const value = text(input?.[key]).trim();
  if (!value) return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} is required`) };
  return { value };
}
function requireBoolean(input, key) {
  if (typeof input?.[key] !== "boolean") {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be boolean`) };
  }
  return { value: input[key] };
}
function requireNumber(input, key) {
  if (typeof input?.[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0) {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be a finite number >= 0`) };
  }
  return { value: input[key] };
}
function requireStringArray(input, key) {
  if (!Array.isArray(input?.[key]) || input[key].some((item) => typeof item !== "string")) {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be a string array`) };
  }
  return { value: input[key] };
}
function collect(parts) {
  const findings = parts.filter((part) => part.error).map((part) => part.error);
  return findings;
}

const FIRST_USE_NOTICE = Object.freeze({
  zh: "默认只走官方技能，并按需求匹配能力。用户点名的额外技能才进入候选。链路无关或自行扩展的技能不得调用。",
  en: "Default to official skills and match capability to the demand. Extra skills enter only when the user names them. Do not call chain-unrelated or self-extended skills.",
  ru: "По умолчанию только официальные навыки, сопоставляемые с потребностью. Чужие навыки — только если пользователь назвал их.",
});

const INTAKE_QUESTIONS = Object.freeze([
  { id: "goal", required: true, prompt: "What must be true when this finishes, and what must never change?", example: "只改税率常量一行，不改其它计税逻辑" },
  { id: "targetFiles", required: true, prompt: "Which file paths are in scope? Use unknown if not located yet.", example: "apps/web/src/tax.ts" },
  { id: "estimatedChangedLines", required: true, prompt: "How many lines should change?", example: "1" },
  { id: "crossModule", required: true, prompt: "Does this cross modules? yes or no.", example: "no" },
  { id: "needParallel", required: true, prompt: "Must independent modules run in parallel? yes or no.", example: "no" },
  { id: "goalKind", required: true, prompt: "Goal kind: code, calculator, mixed, or docs.", example: "code" },
  { id: "deliveryDoc", required: true, prompt: "After success, summarize a local delivery document? yes or no.", example: "no" },
]);

function classifyMode(input) {
  const goal = requireText(input, "goal");
  const targetFiles = requireStringArray(input, "targetFiles");
  const lines = requireNumber(input, "estimatedChangedLines");
  const crossModule = requireBoolean(input, "crossModule");
  const needParallel = requireBoolean(input, "needParallel");
  const findings = collect([goal, targetFiles, lines, crossModule, needParallel]);
  if (findings.length) return { findings };
  const fileCount = targetFiles.value.length;
  const lockable = fileCount === 1 && lines.value <= LOCK_LINE_BUDGET
    && crossModule.value === false && needParallel.value === false;
  const probeable = fileCount <= PROBE_FILE_BUDGET && lines.value <= PROBE_LINE_BUDGET
    && needParallel.value === false;
  const mode = lockable ? "lock" : probeable ? "probe" : "swarm";
  return {
    mode,
    reason: lockable
      ? "single-file change within lock budget"
      : probeable
        ? "bounded change needs read-only probe before mutate"
        : "cross-module, parallel, or over-budget work uses swarm",
    goal: goal.value,
    targetFiles: targetFiles.value,
    estimatedChangedLines: lines.value,
  };
}

function matchesPrefix(filePath, prefixes) {
  return prefixes.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));
}
function pathAllowed(filePath, contract) {
  return !matchesPrefix(filePath, contract.forbiddenPaths) && matchesPrefix(filePath, contract.allowedPaths);
}

function readContract(input) {
  const contract = input?.contract;
  if (!isObject(contract)) {
    return { findings: [finding("P0", "CONTRACT_OBJECT", "input.contract", "contract must be an object")] };
  }
  const allowedPaths = requireStringArray(contract, "allowedPaths");
  const forbiddenPaths = Array.isArray(contract.forbiddenPaths)
    ? { value: contract.forbiddenPaths.filter((item) => typeof item === "string") }
    : { value: [] };
  if (Array.isArray(contract.forbiddenPaths) === false && contract.forbiddenPaths !== undefined) {
    return { findings: [finding("P0", "CONTRACT_FORBIDDEN", "input.contract.forbiddenPaths", "forbiddenPaths must be a string array when present")] };
  }
  const maxChangedLines = requireNumber(contract, "maxChangedLines");
  const allowNewFiles = requireBoolean(contract, "allowNewFiles");
  const allowDeleteFiles = requireBoolean(contract, "allowDeleteFiles");
  const findings = collect([allowedPaths, maxChangedLines, allowNewFiles, allowDeleteFiles]);
  if (allowedPaths.value && allowedPaths.value.length === 0) {
    findings.push(finding("P0", "CONTRACT_ALLOWED", "input.contract.allowedPaths", "allowedPaths must not be empty"));
  }
  if (maxChangedLines.value === 0) {
    findings.push(finding("P0", "CONTRACT_BUDGET", "input.contract.maxChangedLines", "maxChangedLines must be > 0"));
  }
  if (findings.length) return { findings };
  return {
    contract: {
      schemaVersion: CONTRACT_SCHEMA,
      allowedPaths: allowedPaths.value,
      forbiddenPaths: forbiddenPaths.value,
      maxChangedLines: maxChangedLines.value,
      allowNewFiles: allowNewFiles.value,
      allowDeleteFiles: allowDeleteFiles.value,
    },
  };
}

function validateNodes(input) {
  const parsed = readContract(input);
  if (parsed.findings) return parsed;
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    return { findings: [finding("P0", "NODES_REQUIRED", "input.nodes", "nodes must be a non-empty array")] };
  }
  const findings = [];
  let estimatedSum = 0;
  for (const [index, node] of input.nodes.entries()) {
    const ref = `input.nodes[${index}]`;
    if (!isObject(node)) {
      findings.push(finding("P0", "NODE_OBJECT", ref, "node must be an object"));
      continue;
    }
    const filePath = text(node.path).trim();
    const reason = text(node.reason).trim();
    const estimatedLines = node.estimatedLines;
    if (!filePath) findings.push(finding("P0", "NODE_PATH", `${ref}.path`, "path is required"));
    if (!reason) findings.push(finding("P0", "NODE_REASON", `${ref}.reason`, "reason is required"));
    if (typeof estimatedLines !== "number" || !Number.isFinite(estimatedLines) || estimatedLines < 0) {
      findings.push(finding("P0", "NODE_LINES", `${ref}.estimatedLines`, "estimatedLines must be a finite number >= 0"));
    } else {
      estimatedSum += estimatedLines;
    }
    if (filePath && !pathAllowed(filePath, parsed.contract)) {
      findings.push(finding("P0", "NODE_OUT_OF_SCOPE", `${ref}.path`, `${filePath} is outside the scope contract`));
    }
    if (node.isNewFile === true && parsed.contract.allowNewFiles === false) {
      findings.push(finding("P0", "NODE_NEW_FILE", `${ref}.isNewFile`, "new files are forbidden by the contract"));
    }
    if (node.isDelete === true && parsed.contract.allowDeleteFiles === false) {
      findings.push(finding("P0", "NODE_DELETE", `${ref}.isDelete`, "deletes are forbidden by the contract"));
    }
  }
  if (estimatedSum > parsed.contract.maxChangedLines) {
    findings.push(finding("P0", "NODE_BUDGET", "input.nodes", `estimated ${estimatedSum} lines exceed maxChangedLines ${parsed.contract.maxChangedLines}`));
  }
  if (findings.length) return { findings };
  return { contract: parsed.contract, nodes: input.nodes, estimatedSum };
}

function hopAllowed(rule, demand, currentRole) {
  if (currentRole === "user-specified" || !rule.fromRoles?.includes(currentRole)) {
    return { call: false, reason: "chain-unrelated" };
  }
  if (rule.modes && !rule.modes.includes(demand.mode)) return { call: false, reason: rule.reasonSkip };
  if (rule.goalKinds && !rule.goalKinds.includes(demand.goalKind)) {
    return { call: false, reason: "capability-unrelated" };
  }
  if (rule.requiresHasBlueprintFalse && demand.hasBlueprint) return { call: false, reason: rule.reasonSkip };
  return { call: true, reason: rule.reasonCall };
}

function matchCatalogHops(catalog, demand) {
  const specified = new Set(demand.userSpecifiedSkills);
  const current = catalog.skills.find((skill) => skill.runtimeCode === catalog.currentRuntimeCode);
  const currentRole = current?.role ?? "user-specified";
  return catalog.skills.map((skill) => {
    if (skill.runtimeCode === catalog.currentRuntimeCode) {
      return { ...skill, call: false, analyze: false, reason: "self" };
    }
    if (!skill.official && !specified.has(skill.runtimeCode)) {
      return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    }
    if (!catalog.hopsEnabled) {
      return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    }
    if (!skill.official) {
      return { ...skill, call: false, analyze: true, reason: "user-specified: confirm capabilities match the demand before invoke" };
    }
    const rule = catalog.hopRules.find((item) => item.role === skill.role);
    if (!rule) return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    return { ...skill, analyze: false, ...hopAllowed(rule, demand, currentRole) };
  });
}

function routeSkills(input) {
  const modeText = text(input?.mode).trim();
  const kindText = text(input?.goalKind).trim();
  const findings = [];
  if (!MODES.has(modeText)) findings.push(finding("P0", "MODE_REQUIRED", "input.mode", "mode must be lock, probe, or swarm"));
  if (!GOAL_KINDS.has(kindText)) findings.push(finding("P0", "GOAL_KIND", "input.goalKind", "goalKind must be code, calculator, mixed, or docs"));
  const hasBlueprint = requireBoolean(input, "hasBlueprint");
  if (hasBlueprint.error) findings.push(hasBlueprint.error);
  const catalog = input?.officialCatalog;
  if (!isObject(catalog) || catalog.schemaVersion !== CATALOG_SCHEMA) {
    findings.push(finding("P0", "CATALOG_REQUIRED", "input.officialCatalog", "officialCatalog from capabilities is required"));
  }
  if (isObject(catalog) && (!Array.isArray(catalog.skills) || !Array.isArray(catalog.hopRules))) {
    findings.push(finding("P0", "CATALOG_SHAPE", "input.officialCatalog", "officialCatalog.skills and hopRules must be arrays"));
  }
  const specified = input?.userSpecifiedSkills;
  if (specified !== undefined && (!Array.isArray(specified) || specified.some((item) => typeof item !== "string"))) {
    findings.push(finding("P0", "USER_SPECIFIED", "input.userSpecifiedSkills", "userSpecifiedSkills must be a string array when present"));
  }
  if (findings.length) return { findings };
  return {
    hops: matchCatalogHops(catalog, {
      mode: modeText, goalKind: kindText, hasBlueprint: hasBlueprint.value,
      userSpecifiedSkills: specified ?? [],
    }),
  };
}

function snapshotPlan(input) {
  const runId = requireText(input, "runId");
  const paths = requireStringArray(input, "paths");
  const findings = collect([runId, paths]);
  if (input?.createBranch === true || input?.gitBranch === true || input?.worktree === true) {
    findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "Aimlock forbids git branches and worktrees; snapshot with file copies"));
  }
  if (paths.value && paths.value.length === 0) {
    findings.push(finding("P0", "SNAPSHOT_PATHS", "input.paths", "paths to snapshot must not be empty"));
  }
  if (findings.length) return { findings };
  return {
    snapshot: {
      snapshotId: `snap-${runId.value}`,
      method: "file-copy",
      snapshotRoot: `.aimlock/snapshots/${runId.value}`,
      paths: paths.value,
      forbidGitBranch: true,
      forbidWorktree: true,
    },
  };
}

function mutateGate(input) {
  const accepted = requireBoolean(input, "accepted");
  const snapshotId = requireText(input, "snapshotId");
  const findings = collect([accepted, snapshotId]);
  if (input?.createBranch === true || input?.gitBranch === true) {
    findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "mutate must not create a git branch"));
  }
  if (accepted.value === false) {
    findings.push(finding("P0", "MUTATE_NOT_ACCEPTED", "input.accepted", "mutate is forbidden until nodes are accepted"));
  }
  const nodes = validateNodes(input);
  if (nodes.findings) findings.push(...nodes.findings);
  if (findings.length) return { findings };
  return { allowed: true, snapshotId: snapshotId.value };
}

function continuity(input) {
  const changedLines = requireNumber(input, "changedLines");
  const maxChangedLines = requireNumber(input, "maxChangedLines");
  const testsPassed = requireBoolean(input, "testsPassed");
  const omissionScanDone = requireBoolean(input, "omissionScanDone");
  const findings = collect([changedLines, maxChangedLines, testsPassed, omissionScanDone]);
  if (findings.length) return { findings };
  if (changedLines.value > maxChangedLines.value) return { trafficLight: "red", reason: "changed lines exceed the contract budget" };
  if (testsPassed.value === false) return { trafficLight: "red", reason: "continuity tests failed" };
  if (omissionScanDone.value === false) return { trafficLight: "yellow", reason: "omission scan not done" };
  return { trafficLight: "green", reason: "within budget, tests passed, omission scan done" };
}

function interrupt(input) {
  const forceStop = requireBoolean(input, "forceStop");
  const isStatusQuery = requireBoolean(input, "isStatusQuery");
  const related = requireBoolean(input, "related");
  const findings = collect([forceStop, isStatusQuery, related]);
  if (findings.length) return { findings };
  if (forceStop.value) return { kind: "stop", action: "stop the running aim immediately" };
  if (isStatusQuery.value) return { kind: "status", action: "report progress only; do not start new work" };
  if (related.value) return { kind: "fuse", action: "signal the running agent, re-scope, update the JSON tasks, continue" };
  return { kind: "spawn", action: "unrelated: dispatch a new temporary agent; do not hijack the current aim" };
}

function keepAlive(input) {
  const goalComplete = requireBoolean(input, "goalComplete");
  if (goalComplete.error) return { findings: [goalComplete.error] };
  if (goalComplete.value) return { arm: false, reason: "goal is complete; do not keep the session alive" };
  return { arm: true, intervalSeconds: KEEP_ALIVE_SECONDS, message: KEEP_ALIVE_MESSAGE, reason: "goal still open" };
}

function deliveryDoc(input) {
  const userConfirmed = requireBoolean(input, "userConfirmed");
  if (userConfirmed.error) return { findings: [userConfirmed.error] };
  if (userConfirmed.value === false) return { required: false, skip: true };
  return { required: true, skip: false, instruction: "workers write local notes; main agent merges one document" };
}

function validateRunJson(project) {
  const findings = [];
  if (!isObject(project)) return [finding("P0", "RUN_OBJECT", "input.project", "project must be an object")];
  if (!text(project.goal).trim()) findings.push(finding("P0", "RUN_GOAL", "input.project.goal", "goal is required"));
  if (!MODES.has(text(project.mode))) findings.push(finding("P0", "RUN_MODE", "input.project.mode", "mode must be lock, probe, or swarm"));
  const parsed = readContract({ contract: project.contract });
  if (parsed.findings) findings.push(...parsed.findings);
  if (!Array.isArray(project.tasks)) findings.push(finding("P0", "RUN_TASKS", "input.project.tasks", "tasks must be an array"));
  return findings;
}

function validateRequest(request) {
  const findings = [];
  if (!isObject(request)) return [finding("P0", "REQUEST_OBJECT", "request", "request must be an object")];
  if (request.schemaVersion !== REQUEST_SCHEMA) {
    findings.push(finding("P0", "REQUEST_SCHEMA", "request.schemaVersion", `Expected ${REQUEST_SCHEMA}`));
  }
  if (!text(request.requestId)) findings.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.requestId", "requestId is required"));
  if (!text(request.operation)) findings.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.operation", "operation is required"));
  return findings;
}

function handleClassify(requestId, input) {
  const result = classifyMode(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    ...result,
    nextStep: { operation: "scope-contract", instruction: "Write the scope contract before any file mutation." },
  });
}

function handleContract(requestId, input) {
  const parsed = readContract(input);
  if (parsed.findings) return blockedResponse(requestId, parsed.findings);
  return okResponse(requestId, {
    contract: parsed.contract,
    nextStep: { operation: "skill-route", instruction: "Match officialCatalog hops, then probe or mutate inside the contract." },
  });
}

function handleRoute(requestId, input) {
  const routed = routeSkills(input);
  if (routed.findings) return blockedResponse(requestId, routed.findings);
  return okResponse(requestId, {
    hops: routed.hops,
    nextStep: { operation: "propose-nodes", instruction: "Workers return modification nodes read-only. Do not mutate yet." },
  });
}

function handlePropose(requestId, input) {
  const result = validateNodes(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    nodes: result.nodes, estimatedSum: result.estimatedSum, contract: result.contract,
    nextStep: { operation: "accept-nodes", instruction: "Accept in-scope nodes, or escalate conflicts." },
  });
}

function handleAccept(requestId, input) {
  const result = validateNodes(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : null;
  if (input.conflicts !== undefined && !Array.isArray(input.conflicts)) {
    return blockedResponse(requestId, [finding("P0", "CONFLICTS_ARRAY", "input.conflicts", "conflicts must be an array when present")]);
  }
  const list = conflicts ?? [];
  const autoAccept = list.length === 0;
  return okResponse(requestId, {
    autoAccept, escalate: !autoAccept, nodes: result.nodes,
    nextStep: autoAccept
      ? { operation: "snapshot-plan", instruction: "Snapshot the target files, then mutate-gate." }
      : { operation: "accept-nodes", instruction: "Resolve conflicts with the main agent before mutate." },
  });
}

function handleSnapshot(requestId, input) {
  const result = snapshotPlan(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    snapshot: result.snapshot,
    nextStep: { operation: "mutate-gate", instruction: "Copy files into snapshotRoot, then mutate only accepted nodes." },
  });
}

function handleMutate(requestId, input) {
  const result = mutateGate(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    allowed: true, snapshotId: result.snapshotId,
    nextStep: { operation: "continuity-check", instruction: "After mutate, traffic-light budget, tests, and omission scan." },
  });
}

function handleContinuity(requestId, input) {
  const result = continuity(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  const done = result.trafficLight === "green";
  return okResponse(requestId, {
    trafficLight: result.trafficLight, reason: result.reason,
    nextStep: done
      ? { operation: "keep-alive", instruction: "If the whole aim is complete, set goalComplete true and reclaim workers." }
      : { operation: "mutate-gate", instruction: "Red or yellow: roll back from the snapshot and fix inside the contract." },
  });
}

function finish(requestId, result, payload) {
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, payload ?? result);
}

export async function run(request) {
  const requestFindings = validateRequest(request);
  if (requestFindings.length) {
    return { ...blockedResponse(request?.requestId ?? "unknown", requestFindings), errorSchema: ERROR_SCHEMA };
  }
  const { requestId, operation } = request;
  const input = isObject(request.input) ? request.input : {};
  if (operation === "capabilities") {
    return okResponse(requestId, {
      capabilities: {
        pure: true, stateless: true, networkRequired: false, filesystemRequired: false,
        operations: [...PURE_OPERATIONS],
        modes: ["lock", "probe", "swarm"],
        forbidGitBranch: true,
        keepAliveSeconds: KEEP_ALIVE_SECONDS,
        keepAliveMessage: KEEP_ALIVE_MESSAGE,
        defaultAllowlist: "official",
        userSpecifiedField: "userSpecifiedSkills",
        catalogSchema: CATALOG_SCHEMA,
      },
      skill: { name: COMPILER_NAME, version: COMPILER_VERSION },
      firstUseNotice: FIRST_USE_NOTICE,
      nextStep: { operation: "intake", instruction: "Ask the intake questions one at a time. Do not mutate files yet." },
    });
  }
  if (operation === "help") {
    return okResponse(requestId, {
      help: { name: COMPILER_NAME, version: COMPILER_VERSION, operations: OPERATION_CATALOG },
      nextStep: { operation: "intake", instruction: "Ask the intake questions one at a time." },
    });
  }
  if (operation === "intake") {
    return okResponse(requestId, {
      questions: INTAKE_QUESTIONS,
      nextStep: { operation: "classify", instruction: "Classify lock/probe/swarm from the answers. Do not mutate yet." },
    });
  }
  if (operation === "classify") return handleClassify(requestId, input);
  if (operation === "scope-contract") return handleContract(requestId, input);
  if (operation === "skill-route") return handleRoute(requestId, input);
  if (operation === "propose-nodes") return handlePropose(requestId, input);
  if (operation === "accept-nodes") return handleAccept(requestId, input);
  if (operation === "snapshot-plan") return handleSnapshot(requestId, input);
  if (operation === "mutate-gate") return handleMutate(requestId, input);
  if (operation === "continuity-check") return handleContinuity(requestId, input);
  if (operation === "interrupt") return finish(requestId, interrupt(input));
  if (operation === "keep-alive") return finish(requestId, keepAlive(input));
  if (operation === "delivery-doc") return finish(requestId, deliveryDoc(input));
  if (operation === "validate-json") {
    const findings = validateRunJson(input.project);
    if (findings.length) return blockedResponse(requestId, findings);
    return okResponse(requestId, { valid: true, nextStep: { operation: "classify", instruction: "Run JSON is valid." } });
  }
  return failed(requestId, "UNSUPPORTED_OPERATION", `Unsupported operation: ${operation}`);
}

export {
  COMPILER_VERSION, CONTRACT_SCHEMA, PURE_OPERATIONS, OPERATION_CATALOG, INTAKE_QUESTIONS,
  CATALOG_SCHEMA, KEEP_ALIVE_SECONDS, KEEP_ALIVE_MESSAGE, FIRST_USE_NOTICE,
  classifyMode, readContract, validateNodes, routeSkills, matchCatalogHops, snapshotPlan, mutateGate,
  continuity, interrupt, keepAlive, deliveryDoc, validateRunJson, okResponse, blockedResponse, finding,
};
