// Aimlock router: classify demand and order only server-resolved skill matches.

const CHAIN_KINDS = Object.freeze([
  "code-risky", "calculator", "page-new", "merge", "probe-only", "chat",
]);

const CLASSIFY_RULES = [
  { priority: 60, pattern: /计算器|公式|测算|对账|指标固化|在线测算|计算工具/i, product: "calculator", risk: "low", chain: "calculator" },
  { priority: 50, pattern: /分支合并|合并代码|merge|冲突解决/i, product: "merge", risk: "medium", chain: "merge" },
  { priority: 40, pattern: /修改|更新|重构|修复|bug|调整|优化|改造|新增/i, product: "code", risk: "low", chain: "code-risky" },
  { priority: 30, pattern: /新建页面|新建工具|创建页面|创建工具/i, product: "page", risk: "low", chain: "page-new" },
  { priority: 20, pattern: /只读分析|分析代码|代码审查|review/i, product: "analysis", risk: "low", chain: "probe-only" },
  { priority: 10, pattern: /纯查询|查看|读取|了解|咨询|闲聊/i, product: "none", risk: "low", chain: "chat" },
];
const HIGH_RISK_PATTERNS = [/生产数据|支付|用户隐私|财务|密码|密钥|线上环境|production/i];
const RISK_LEVEL = Object.freeze({ low: 0, medium: 1, high: 2 });
const CONFIRM_PROTOCOL_REQUEST_SCHEMA = "confirm-protocol.skill.request/1.0";
const CONFIRM_INTERACTION_SCHEMA = "confirm.interaction/1.0";
const CONFIRM_AUDIT_SCHEMA = "confirm.audit-entry/1.0";
const CONFIRM_STEP = "confirm-protocol";
const CONFIRM_APPROVE = "approve";

function strongestRisk(...values) {
  return values.filter((value) => value in RISK_LEVEL)
    .sort((left, right) => RISK_LEVEL[right] - RISK_LEVEL[left])[0] ?? "low";
}

function classifyDemand(input) {
  const goal = String(input?.goal ?? "").trim();
  if (!goal) return { findings: [{ severity: "P0", ruleId: "CLASSIFY_GOAL", entityRef: "input.goal", message: "goal is required for classification", evidence: { example: "修改税率常量" } }] };
  const declaredRisk = String(input?.risk ?? "").trim();
  if (declaredRisk && !(declaredRisk in RISK_LEVEL)) {
    return { findings: [{ severity: "P0", ruleId: "CLASSIFY_RISK", entityRef: "input.risk", message: "risk must be low, medium, or high", evidence: { example: "high" } }] };
  }
  const rule = CLASSIFY_RULES.filter((candidate) => candidate.pattern.test(goal))
    .sort((left, right) => right.priority - left.priority)[0];
  if (rule) {
    const detectedRisk = HIGH_RISK_PATTERNS.some((pattern) => pattern.test(goal)) ? "high" : rule.risk;
    const risk = strongestRisk(detectedRisk, declaredRisk, input?.modelClassification?.risk);
    return { product: rule.product, risk, chain: rule.chain, confidence: 1, source: "rule" };
  }
  const assisted = input?.modelClassification;
  const products = new Set(["calculator", "merge", "none", "analysis", "page", "code"]);
  const risks = new Set(["low", "medium", "high"]);
  const chains = new Set(CHAIN_KINDS);
  if (assisted && typeof assisted === "object" && Number(assisted.confidence) >= 0.75
    && products.has(assisted.product) && risks.has(assisted.risk) && chains.has(assisted.chain)) {
    return { product: assisted.product, risk: strongestRisk(declaredRisk, assisted.risk), chain: assisted.chain,
      confidence: Number(assisted.confidence), source: "model-assisted" };
  }
  return { product: null, risk: "unknown", chain: null, confidence: 0, source: "needs-clarification",
    question: "请描述您想实现的产物类型？", options: ["计算工具", "代码修改", "新建页面", "分支合并", "只读分析"] };
}

function resolvedStepIds(input) {
  if (!Array.isArray(input?.steps) || input.steps.some((step) => typeof step !== "string" || !step.trim())) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_STEPS", entityRef: "input.steps", message: "steps must be the server-resolved skill ids", evidence: { example: ["blueprint", "validator"] } }] };
  }
  const steps = [...new Set(input.steps.map((step) => step.trim()))];
  if (steps.length !== input.steps.length) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_STEPS_DUPLICATE", entityRef: "input.steps", message: "steps must be unique", evidence: { example: steps } }] };
  }
  return { steps };
}

function confirmationFinding(ruleId, message, example) {
  return { severity: "P0", ruleId, entityRef: "input.confirmationResult", message,
    evidence: { example } };
}

function confirmationRequest(chain, risk, requestId) {
  return {
    schemaVersion: CONFIRM_PROTOCOL_REQUEST_SCHEMA,
    requestId: `confirm-${requestId}`,
    operation: "interaction-request",
    input: { interaction: {
      schemaVersion: CONFIRM_INTERACTION_SCHEMA,
      requestId,
      type: "confirm",
      question: `Approve execution of the ${chain} chain?`,
      options: [
        { id: CONFIRM_APPROVE, label: "Approve", hint: "Continue the guarded chain." },
        { id: "reject", label: "Reject", hint: "Keep the chain blocked." },
      ],
      default: null,
      timeout: null,
      timeoutAction: "wait",
      risk: risk === "high" ? "high" : "low",
      riskDescription: risk === "high"
        ? "This high-risk chain cannot continue without an explicit human decision." : "",
      rememberable: false,
      memoryKey: "",
      callback: { operation: "resume-aimlock-chain", payload: { chain } },
    } },
  };
}

function validateConfirmationResult(value, chain, risk, requestId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [confirmationFinding("CONFIRMATION_RESULT_REQUIRED",
      "a Confirm Protocol interaction-answer result is required before the chain can continue", {})];
  }
  const audit = value.auditEntry;
  const callback = value.callbackRequest;
  const payload = callback?.payload;
  const findings = [];
  if (!audit || audit.schemaVersion !== CONFIRM_AUDIT_SCHEMA || audit.answer !== CONFIRM_APPROVE) {
    findings.push(confirmationFinding("CONFIRMATION_AUDIT_INVALID",
      "confirmation audit entry must record an explicit approve answer", { schemaVersion: CONFIRM_AUDIT_SCHEMA, answer: CONFIRM_APPROVE }));
  }
  if (!callback || callback.operation !== "resume-aimlock-chain" || payload?.chain !== chain) {
    findings.push(confirmationFinding("CONFIRMATION_CALLBACK_INVALID",
      "confirmation callback must resume the same Aimlock chain", { operation: "resume-aimlock-chain", chain }));
  }
  if (payload?.answer !== CONFIRM_APPROVE || payload?.requestId !== audit?.requestId
    || audit?.requestId !== requestId) {
    findings.push(confirmationFinding("CONFIRMATION_DECISION_INVALID",
      "confirmation callback and audit entry must bind the same approved request", { answer: CONFIRM_APPROVE }));
  }
  if (risk === "high" && audit?.risk !== "high") {
    findings.push(confirmationFinding("CONFIRMATION_RISK_INVALID",
      "high-risk chains require an isolated high-risk confirmation", { risk: "high" }));
  }
  return findings;
}

function buildChainPlan(input) {
  const chain = String(input?.chain ?? "").trim();
  if (!CHAIN_KINDS.includes(chain)) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_KIND", entityRef: "input.chain", message: `unknown chain: ${chain}`, evidence: { example: "code-risky" } }] };
  }
  const resolved = resolvedStepIds(input);
  if (resolved.findings) return resolved;
  const expandedSteps = resolved.steps.flatMap((step) => step === "swarm"
    ? ["coordinator.conflict-scan", "swarm"] : [step]);
  const risk = String(input?.risk ?? "").trim();
  if (!["low", "medium", "high"].includes(risk)) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_RISK", entityRef: "input.risk", message: "risk must be low, medium, or high", evidence: { example: "medium" } }] };
  }
  const steps = expandedSteps.includes(CONFIRM_STEP)
    ? [CONFIRM_STEP, ...expandedSteps.filter((step) => step !== CONFIRM_STEP)] : expandedSteps;
  const highRiskFindings = [];
  if (risk === "high" && !steps.includes(CONFIRM_STEP)) highRiskFindings.push({ severity: "P0",
    ruleId: "HIGH_RISK_CONFIRMATION", entityRef: "input.steps",
    message: "high-risk work requires a server-resolved confirm-protocol step", evidence: { example: [CONFIRM_STEP] } });
  if (risk === "high" && !steps.includes("validator")) highRiskFindings.push({ severity: "P0",
    ruleId: "HIGH_RISK_VALIDATOR", entityRef: "input.steps",
    message: "high-risk work requires a server-resolved validator step", evidence: { example: ["validator"] } });
  if (highRiskFindings.length) return { findings: highRiskFindings };
  const completed = Array.isArray(input?.completed) ? input.completed : [];
  const expected = steps.slice(0, completed.length);
  if (new Set(completed).size !== completed.length
    || completed.some((step, index) => step !== expected[index])) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_ORDER", entityRef: "input.completed", message: "completed must be an exact chain prefix", evidence: { example: expected } }] };
  }
  const current = steps[completed.length] ?? null;
  const requestId = String(input?.confirmationRequestId ?? "").trim();
  if (steps.includes(CONFIRM_STEP) && !requestId) {
    return { findings: [confirmationFinding("CONFIRMATION_REQUEST_ID",
      "confirmationRequestId is required to bind the Confirm Protocol request", { confirmationRequestId: "chain-request-1" })] };
  }
  if (completed.includes(CONFIRM_STEP)) {
    const confirmationFindings = validateConfirmationResult(input.confirmationResult, chain, risk, requestId);
    if (confirmationFindings.length) return { findings: confirmationFindings };
  }
  return { chain: steps, chainKind: chain, ready: current ? [current] : [], current,
    blocked: current ? steps.slice(completed.length + 1).map((step) => ({ step, waitingFor: [current] })) : [],
    totalSteps: steps.length, completedSteps: completed.length, risk,
    confirmationRequired: steps.includes(CONFIRM_STEP),
    ...(current === CONFIRM_STEP ? { confirmProtocolRequest: confirmationRequest(chain, risk, requestId) } : {}) };
}

function submitFeedback(input) {
  const feedbackId = String(input?.feedbackId ?? "").trim();
  const fromSkill = String(input?.fromSkill ?? "").trim();
  const toSkill = String(input?.toSkill ?? "").trim();
  const reason = String(input?.reason ?? "").trim();
  const findings = [];
  if (!feedbackId) findings.push({ severity: "P0", ruleId: "FEEDBACK_ID", entityRef: "input.feedbackId", message: "feedbackId is required", evidence: { example: "route-feedback-1" } });
  if (!fromSkill) findings.push({ severity: "P0", ruleId: "FEEDBACK_FROM", entityRef: "input.fromSkill", message: "fromSkill is required", evidence: { example: "aimlock" } });
  if (!toSkill) findings.push({ severity: "P0", ruleId: "FEEDBACK_TO", entityRef: "input.toSkill", message: "toSkill is required", evidence: { example: "validator" } });
  if (!reason) findings.push({ severity: "P0", ruleId: "FEEDBACK_REASON", entityRef: "input.reason", message: "reason is required", evidence: { example: "routing repair" } });
  if (findings.length) return { findings };
  return { recorded: true, applied: false, persistenceRequired: true, feedbackId,
    record: { feedbackId, fromSkill, toSkill, reason, demand: String(input?.demand ?? "").trim() } };
}

function chainStatus(input) {
  const chainId = String(input?.chainId ?? "").trim();
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  const completed = Array.isArray(input?.completed) ? input.completed : [];
  if (!chainId || steps.length === 0 || new Set(steps).size !== steps.length
    || completed.length > steps.length || completed.some((step, index) => step !== steps[index])) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_STATUS_INVALID", entityRef: "input", message: "chainId is required and completed must be an exact prefix of unique steps", evidence: { example: { chainId: "chain-1", steps: ["validator"], completed: [] } } }] };
  }
  const current = steps[completed.length] ?? null;
  return { chainId, steps, completed, current, totalSteps: steps.length,
    completedSteps: completed.length, isComplete: completed.length === steps.length };
}

export { CHAIN_KINDS, CLASSIFY_RULES, HIGH_RISK_PATTERNS, classifyDemand, buildChainPlan, submitFeedback, chainStatus };
import { createHash } from "node:crypto";

// aimlock runtime v7.0.0 — 统一路由入口 + 变更门禁。Self-contained after build concat.
const LEGACY_REQUEST_SCHEMA = "aimlock.skill.request/1.0";
const LEGACY_RESPONSE_SCHEMA = "aimlock.skill.response/1.0";
const REQUEST_SCHEMA = "aimlock.skill.request/1.1";
const RESPONSE_SCHEMA = "aimlock.skill.response/1.1";
const ERROR_SCHEMA = "aimlock.skill.error/1.0";
const CONTRACT_SCHEMA = "aimlock.scope-contract/1.0";
const COMPILER_NAME = "aimlock";
const COMPILER_VERSION = "v7.0.34";
const KEEP_ALIVE_SECONDS = 90;
const KEEP_ALIVE_MESSAGE = "智能目标持续执行中，请勿关闭！";
const BYPASS_LINE_BUDGET = 500;
const LOCK_LINE_BUDGET = 500;
const PROBE_LINE_BUDGET = 500;
const PROBE_FILE_BUDGET = 3;
const TEST_EVIDENCE_SCHEMA = "cli.tax.test-evidence/1.0";
const SNAPSHOT_RECEIPT_SCHEMA = "aimlock.snapshot-receipt/1.0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SNAPSHOT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const OPERATIONS = [
  "capabilities", "help", "intake", "classify", "scope-contract", "skill-route",
  "propose-nodes", "accept-nodes", "snapshot-plan", "mutate-gate",
  "continuity-check", "interrupt", "keep-alive", "delivery-doc", "validate-json",
  "snapshot-verify", "run-status",
  "chain-plan", "chain-status", "feedback",
];
const PURE_OPERATIONS = new Set(OPERATIONS);
const OPERATION_CATALOG = Object.freeze(OPERATIONS.map((operation) => ({ operation, summary: operation })));

const OPERATION_SCHEMAS = Object.freeze({
  "classify": {
    input: {
      type: "object",
      required: ["goal", "targetFiles", "estimatedChangedLines", "difficulty", "risk",
        "crossModule", "needParallel", "explicitAimlockRequested"],
      properties: {
        goal: { type: "string", minLength: 1 },
        targetFiles: { type: "array", minItems: 1, items: { type: "string" } },
        estimatedChangedLines: { type: "number", minimum: 0 },
        difficulty: { type: "string", enum: ["low", "medium", "high"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        crossModule: { type: "boolean" },
        needParallel: { type: "boolean" },
        explicitAimlockRequested: { type: "boolean" },
        modelClassification: {
          type: "object", optional: true,
          required: ["product", "risk", "chain", "confidence"],
          properties: {
            product: { type: "string", enum: ["calculator", "merge", "none", "analysis", "page", "code"] },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            chain: { type: "string", enum: CHAIN_KINDS },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["bypass", "lock", "probe", "swarm"] },
        useAimlock: { type: "boolean" },
        explicitAimlockRequested: { type: "boolean" },
        friendlyNotice: { type: "object", optional: true },
        product: { type: ["string", "null"] },
        risk: { type: "string" },
        chain: { type: ["string", "null"] },
        confidence: { type: "number" },
        classificationSource: { type: "string" },
        question: { type: "string", optional: true },
        options: { type: "array", items: { type: "string" }, optional: true },
      },
    },
  },
  "scope-contract": {
    input: {
      type: "object",
      required: ["contract"],
      properties: {
        contract: {
          type: "object",
          required: ["allowedPaths", "maxChangedLines", "allowNewFiles", "allowDeleteFiles"],
          properties: {
            allowedPaths: { type: "array", items: { type: "string" }, description: "non-empty array of path prefixes in scope" },
            forbiddenPaths: { type: "array", items: { type: "string" }, optional: true, description: "path prefixes forbidden by contract" },
            maxChangedLines: { type: "number", description: "budget ceiling, must be > 0" },
            allowNewFiles: { type: "boolean" },
            allowDeleteFiles: { type: "boolean" },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        contract: { type: "object", description: "validated scope-contract object with schemaVersion" },
      },
    },
  },
  "skill-route": {
    input: {
      type: "object",
      required: ["mode", "goalKind", "risk", "hasBlueprint", "contractUnclear", "hasArchitectureContract",
        "newProject", "requiresConfirmation", "requiresCalculator", "requiresMerge",
        "requiresValidation", "serverResolvedSkills"],
      properties: {
        mode: { type: "string", enum: ["bypass", "lock", "probe", "swarm"] },
        goalKind: { type: "string", enum: ["code", "calculator", "mixed", "docs"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        hasBlueprint: { type: "boolean" },
        contractUnclear: { type: "boolean" },
        hasArchitectureContract: { type: "boolean" },
        newProject: { type: "boolean" },
        requiresConfirmation: { type: "boolean" },
        requiresCalculator: { type: "boolean" },
        requiresMerge: { type: "boolean" },
        requiresValidation: { type: "boolean" },
        serverResolvedSkills: { type: "array", description: "server-authoritative matched skills only" },
        userSpecifiedSkills: { type: "array", items: { type: "string" }, optional: true },
      },
    },
    output: {
      type: "object",
      properties: {
        hops: { type: "array", description: "routing decisions per skill" },
      },
    },
  },
  "mutate-gate": {
    input: {
      type: "object",
      required: ["accepted", "receipt", "contract", "nodes"],
      properties: {
        accepted: { type: "boolean", description: "must be true to proceed" },
        receipt: { type: "object", description: "binding receipt returned by snapshot-verify" },
        nodes: { type: "array", minItems: 1, description: "non-empty array of Node objects" },
        contract: { type: "object", description: "scope-contract object" },
      },
    },
    output: {
      type: "object",
      properties: {
        allowed: { type: "boolean" },
        snapshotId: { type: "string" },
      },
    },
  },
  "continuity-check": {
    input: {
      type: "object",
      required: ["changedLines", "maxChangedLines", "testsPassed", "omissionScanDone"],
      properties: {
        changedLines: { type: "number", description: "actual changed lines count" },
        maxChangedLines: { type: "number", description: "contract budget ceiling" },
        testsPassed: { type: "boolean" },
        omissionScanDone: { type: "boolean" },
        testEvidence: { type: "array", optional: true, description: "array of TestEvidence objects" },
        changedNodes: {
          type: "array",
          optional: true,
          description: "per-node changed lines for expansion check",
          items: {
            type: "object",
            required: ["path", "diffType", "changedLines"],
            properties: {
              path: { type: "string" },
              diffType: { type: "string", enum: ["added", "modified", "deleted"] },
              changedLines: { type: "number" },
            },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        trafficLight: { type: "string", enum: ["green", "yellow", "red"] },
        reason: { type: "string" },
      },
    },
  },
  "propose-nodes": {
    input: {
      type: "object",
      required: ["contract", "nodes"],
      properties: {
        contract: { type: "object", description: "scope-contract object" },
        nodes: { type: "array", description: "array of Node objects to propose" },
      },
    },
    output: {
      type: "object",
      properties: {
        nodes: { type: "array" },
        estimatedSum: { type: "number" },
        contract: { type: "object" },
      },
    },
  },
  "accept-nodes": {
    input: {
      type: "object",
      required: ["contract", "nodes"],
      properties: {
        contract: { type: "object", description: "scope-contract object" },
        nodes: { type: "array", description: "array of Node objects to accept" },
        conflicts: { type: "array", optional: true, description: "conflict objects to resolve" },
      },
    },
    output: {
      type: "object",
      properties: {
        autoAccept: { type: "boolean" },
        escalate: { type: "boolean" },
        nodes: { type: "array" },
      },
    },
  },
  "snapshot-plan": {
    input: {
      type: "object",
      required: ["runId", "contract", "nodes"],
      properties: {
        runId: { type: "string" },
        contract: { type: "object", description: "accepted scope-contract object" },
        nodes: { type: "array", minItems: 1, description: "accepted modification nodes" },
      },
    },
    output: {
      type: "object",
      properties: {
        snapshot: { type: "object", description: "snapshot metadata including snapshotId and paths" },
      },
    },
  },
  "intake": {
    input: {
      type: "object",
      properties: {
        answers: {
          type: "array",
          optional: true,
          description: "batch answers: array of {id, answer} or {question, answer}",
          items: {
            type: "object",
            oneOf: [
              { properties: { id: { type: "string" }, answer: { type: "string" } }, required: ["id", "answer"] },
              { properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] },
            ],
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        answers: { type: "object", description: "map of question id → answer value" },
        questions: { type: "array", description: "list of intake questions (when no answers provided)" },
      },
    },
  },
  "snapshot-verify": {
    input: {
      type: "object",
      required: ["snapshotId", "contract", "nodes", "files"],
      properties: {
        snapshotId: { type: "string" },
        contract: { type: "object", description: "accepted scope-contract object" },
        nodes: { type: "array", minItems: 1, description: "accepted modification nodes" },
        files: {
          type: "array", minItems: 1,
          items: {
            type: "object", required: ["path", "sourceHash", "snapshotHash"],
            properties: {
              path: { type: "string" },
              sourceHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
              snapshotHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        verified: { type: "boolean" },
        snapshotId: { type: "string" },
        fileCount: { type: "number" },
        receipt: { type: "object", description: "contract/node/path bound snapshot receipt" },
      },
    },
  },
  "run-status": {
    input: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        state: {
          type: "object", optional: true,
          required: ["status", "currentPhase", "history"],
          properties: {
            status: { type: "string", enum: ["running", "blocked", "complete"] },
            currentPhase: { type: "string" },
            history: { type: "array" },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        runId: { type: "string" },
        known: { type: "boolean" },
        run: { type: "object" },
        boundary: { type: "string" },
      },
    },
  },
  "chain-plan": {
    input: {
      type: "object",
      required: ["chain", "risk", "steps"],
      properties: {
        chain: { type: "string", enum: ["code-risky", "calculator", "page-new", "merge", "probe-only", "chat"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        steps: { type: "array", items: { type: "string" } },
        completed: { type: "array", items: { type: "string" }, optional: true },
        confirmationRequestId: { type: "string", optional: true,
          description: "stable request id returned for the Confirm Protocol round trip" },
        confirmationResult: { type: "object", optional: true,
          description: "authoritative interaction-answer response from Confirm Protocol" },
      },
    },
    output: {
      type: "object",
      properties: {
        chain: { type: "array", items: { type: "string" } },
        ready: { type: "array" },
        blocked: { type: "array" },
        current: { type: ["string", "null"] },
        totalSteps: { type: "number" },
        completedSteps: { type: "number" },
        confirmationRequired: { type: "boolean" },
        confirmProtocolRequest: { type: "object", optional: true },
      },
    },
  },
  "chain-status": {
    input: {
      type: "object",
      required: ["chainId", "steps", "completed"],
      properties: {
        chainId: { type: "string" },
        steps: { type: "array", items: { type: "string" } },
        completed: { type: "array", items: { type: "string" } },
      },
    },
    output: {
      type: "object",
      properties: {
        chainId: { type: "string" },
        current: { type: "string" },
        isComplete: { type: "boolean" },
      },
    },
  },
  "feedback": {
    input: {
      type: "object",
      required: ["feedbackId", "fromSkill", "toSkill", "reason"],
      properties: {
        feedbackId: { type: "string" },
        fromSkill: { type: "string" },
        toSkill: { type: "string" },
        reason: { type: "string" },
        demand: { type: "string", optional: true },
      },
    },
    output: {
      type: "object",
      properties: {
        recorded: { type: "boolean" },
        applied: { type: "boolean" },
        persistenceRequired: { type: "boolean" },
        feedbackId: { type: "string" },
        record: { type: "object" },
      },
    },
  },
  "capabilities": {
    input: { type: "object", properties: {} },
    output: {
      type: "object",
      properties: {
        capabilities: { type: "object", description: "full capabilities object including operationSchemas" },
        skill: { type: "object" },
        firstUseNotice: { type: "object" },
      },
    },
  },
  "help": {
    input: { type: "object", properties: {} },
    output: {
      type: "object",
      properties: {
        help: { type: "object", description: "help text and operation catalog with operationSchemas" },
      },
    },
  },
  "validate-json": {
    input: {
      type: "object",
      required: ["project"],
      properties: {
        project: {
          type: "object",
          required: ["goal", "mode", "tasks"],
          properties: {
            goal: { type: "string" },
            mode: { type: "string", enum: ["bypass", "lock", "probe", "swarm"] },
            contract: { type: "object", optional: true },
            tasks: { type: "array" },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
      },
    },
  },
  "interrupt": {
    input: {
      type: "object",
      required: ["forceStop", "isStatusQuery", "related"],
      properties: {
        forceStop: { type: "boolean" },
        isStatusQuery: { type: "boolean" },
        related: { type: "boolean" },
      },
    },
    output: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["stop", "status", "fuse", "spawn"] },
        action: { type: "string" },
      },
    },
  },
  "keep-alive": {
    input: {
      type: "object",
      required: ["goalComplete"],
      properties: {
        goalComplete: { type: "boolean" },
      },
    },
    output: {
      type: "object",
      properties: {
        armed: { type: "boolean" },
        intervalSeconds: { type: "number" },
        mode: { type: "string", enum: ["protocol"] },
        callerTimerRequired: { type: "boolean" },
        message: { type: "string", optional: true },
        note: { type: "string" },
      },
    },
  },
  "delivery-doc": {
    input: {
      type: "object",
      required: ["userConfirmed"],
      properties: {
        userConfirmed: { type: "boolean" },
      },
    },
    output: {
      type: "object",
      properties: {
        required: { type: "boolean" },
        skip: { type: "boolean" },
      },
    },
  },
});

const GOAL_KINDS = new Set(["code", "calculator", "mixed", "docs"]);
const MODES = new Set(["bypass", "lock", "probe", "swarm"]);
const DIFFICULTIES = new Set(["low", "medium", "high"]);
const RISKS = new Set(["low", "medium", "high"]);

function text(value) { return String(value ?? ""); }
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finding(severity, ruleId, entityRef, message, evidence = {}) {
  return { severity, ruleId, entityRef, message, evidence: { example: evidence.example ?? evidence } };
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
  if (!value) return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} is required`, { example: `"string value"` }) };
  return { value };
}
function requireBoolean(input, key) {
  if (typeof input?.[key] !== "boolean") {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be boolean`, { example: true }) };
  }
  return { value: input[key] };
}
function requireNumber(input, key) {
  if (typeof input?.[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0) {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be a finite number >= 0`, { example: 50 }) };
  }
  return { value: input[key] };
}
function requireStringArray(input, key) {
  if (!Array.isArray(input?.[key]) || input[key].some((item) => typeof item !== "string")) {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} must be a string array`, { example: ["src/"] }) };
  }
  return { value: input[key] };
}
function requireChoice(input, key, choices) {
  const value = text(input?.[key]).trim();
  if (!choices.has(value)) {
    return { error: finding("P0", "REQUIRED_FIELD", `input.${key}`, `${key} has an invalid value`, { example: [...choices][0] }) };
  }
  return { value };
}
function collect(parts) { return parts.filter((p) => p.error).map((p) => p.error); }

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("snapshot binding contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isObject(value)) throw new Error("snapshot binding must be JSON serializable");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function digest(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function requireSnapshotIdentifier(input, key) {
  const candidate = requireText(input, key);
  if (candidate.error) return candidate;
  if (!SNAPSHOT_IDENTIFIER_PATTERN.test(candidate.value) || candidate.value === "." || candidate.value === "..") {
    return { error: finding("P0", "SNAPSHOT_IDENTIFIER", `input.${key}`, `${key} must be a safe identifier without path separators`, { example: "run-1" }) };
  }
  return candidate;
}

const FIRST_USE_NOTICE = Object.freeze({
  zh: "Aimlock 仅用于大型、深度、跨模块、高风险或并行修改，以及用户明确要求 Aimlock 的修改。未明确要求 Aimlock 的小型低难度需求应直接处理，或只调用一个匹配的专项技能。",
  en: "Use Aimlock only for large, deep, cross-module, high-risk, parallel, or explicitly requested changes. Handle small low-difficulty work directly or use one matched specialist unless Aimlock was explicitly requested.",
  ru: "Aimlock применяется только для крупных, сложных, межмодульных, рискованных, параллельных или явно назначенных изменений. Небольшую простую задачу выполняйте напрямую либо одним профильным навыком, если Aimlock не потребован явно.",
});
const BYPASS_NOTICE = Object.freeze({
  zh: "需求较小且低风险，不建议使用 Aimlock；请直接处理，或只调用一个匹配的专项技能。",
  en: "This request is small and low risk; Aimlock is not recommended. Handle it directly or use one matched specialist skill.",
  ru: "Запрос небольшой и низкорисковый; Aimlock не рекомендуется. Выполните его напрямую либо используйте один профильный навык.",
});
const INTAKE_QUESTIONS = Object.freeze([
  { id: "goal", required: true, prompt: "What must be true when this finishes, and what must never change?", example: "只改税率常量一行，不改其它计税逻辑" },
  { id: "targetFiles", required: true, prompt: "Which file paths are in scope? Use unknown if not located yet.", example: "apps/web/src/tax.ts" },
  { id: "estimatedChangedLines", required: true, prompt: "How many lines should change?", example: "1" },
  { id: "difficulty", required: true, prompt: "Difficulty: low, medium, or high.", example: "low" },
  { id: "risk", required: true, prompt: "Risk: low, medium, or high.", example: "low" },
  { id: "crossModule", required: true, prompt: "Does this cross modules? yes or no.", example: "no" },
  { id: "needParallel", required: true, prompt: "Must independent modules run in parallel? yes or no.", example: "no" },
  { id: "explicitAimlockRequested", required: true, prompt: "Did the user explicitly require Aimlock for this change? yes or no.", example: "no" },
  { id: "goalKind", required: true, prompt: "Goal kind: code, calculator, mixed, or docs.", example: "code" },
  { id: "deliveryDoc", required: true, prompt: "After success, summarize a local delivery document? yes or no.", example: "no" },
]);

function classifyMode(input) {
  const goal = requireText(input, "goal");
  const targetFiles = requireStringArray(input, "targetFiles");
  const lines = requireNumber(input, "estimatedChangedLines");
  const difficulty = requireChoice(input, "difficulty", DIFFICULTIES);
  const risk = requireChoice(input, "risk", RISKS);
  const crossModule = requireBoolean(input, "crossModule");
  const needParallel = requireBoolean(input, "needParallel");
  const explicitAimlockRequested = requireBoolean(input, "explicitAimlockRequested");
  const findings = collect([goal, targetFiles, lines, difficulty, risk, crossModule,
    needParallel, explicitAimlockRequested]);
  if (targetFiles.value && targetFiles.value.length === 0) {
    findings.push(finding("P0", "TARGET_FILES_EMPTY", "input.targetFiles", "targetFiles must not be empty", { example: ["src/file.ts"] }));
  }
  if (findings.length) return { findings };
  const hasUnknownTarget = targetFiles.value.some((value) => value.trim().toLowerCase() === "unknown");
  const bypass = lines.value <= BYPASS_LINE_BUDGET && difficulty.value === "low"
    && crossModule.value === false && risk.value !== "high" && needParallel.value === false
    && explicitAimlockRequested.value === false;
  if (bypass) {
    return { mode: "bypass", useAimlock: false, reason: "small low-difficulty demand",
      friendlyNotice: BYPASS_NOTICE, goal: goal.value, targetFiles: targetFiles.value,
      estimatedChangedLines: lines.value, difficulty: difficulty.value,
      explicitAimlockRequested: explicitAimlockRequested.value };
  }
  const fileCount = targetFiles.value.length;
  const lockable = !hasUnknownTarget && fileCount === 1 && lines.value <= LOCK_LINE_BUDGET
    && crossModule.value === false && needParallel.value === false;
  const probeable = fileCount <= PROBE_FILE_BUDGET && lines.value <= PROBE_LINE_BUDGET && crossModule.value === false && needParallel.value === false;
  const mode = lockable ? "lock" : probeable ? "probe" : "swarm";
  return { mode, useAimlock: true,
    reason: lockable ? "single-file guarded change" : probeable ? "bounded guarded change" : "deep, over-three-file, cross-module, parallel, high-risk, or over-budget work",
    goal: goal.value, targetFiles: targetFiles.value, estimatedChangedLines: lines.value,
    difficulty: difficulty.value, explicitAimlockRequested: explicitAimlockRequested.value };
}

function safeRelativePath(value) {
  const source = text(value).trim().replace(/\\/g, "/");
  if (!source || source.startsWith("/") || source.startsWith("~") || source.includes(":")
    || /[\u0000-\u001f\u007f]/.test(source)) return null;
  const parts = source.split("/").filter(Boolean);
  const windowsDevice = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  if (parts.length === 0 || parts.some((part) => part === "." || part === ".."
    || /[. ]$/.test(part) || windowsDevice.test(part))) return null;
  return parts.join("/");
}
function matchesPrefix(filePath, prefixes) {
  const normalizedPath = safeRelativePath(filePath);
  return normalizedPath !== null && prefixes.some((prefix) => (
    normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  ));
}
function pathAllowed(filePath, contract) {
  return !matchesPrefix(filePath, contract.forbiddenPaths) && matchesPrefix(filePath, contract.allowedPaths);
}

function readContract(input) {
  const contract = input?.contract;
  if (!isObject(contract)) {
    return { findings: [finding("P0", "CONTRACT_OBJECT", "input.contract", "contract must be an object", { example: { allowedPaths: ["src/"], maxChangedLines: 50, allowNewFiles: false, allowDeleteFiles: false } })] };
  }
  const allowedPaths = requireStringArray(contract, "allowedPaths");
  const forbiddenPaths = contract.forbiddenPaths === undefined
    ? { value: [] } : requireStringArray(contract, "forbiddenPaths");
  const maxChangedLines = requireNumber(contract, "maxChangedLines");
  const allowNewFiles = requireBoolean(contract, "allowNewFiles");
  const allowDeleteFiles = requireBoolean(contract, "allowDeleteFiles");
  const findings = collect([allowedPaths, forbiddenPaths, maxChangedLines, allowNewFiles, allowDeleteFiles]);
  if (allowedPaths.value && allowedPaths.value.length === 0) findings.push(finding("P0", "CONTRACT_ALLOWED", "input.contract.allowedPaths", "allowedPaths must not be empty", { example: ["src/"] }));
  if (maxChangedLines.value === 0) findings.push(finding("P0", "CONTRACT_BUDGET", "input.contract.maxChangedLines", "maxChangedLines must be > 0", { example: 50 }));
  const normalizedAllowed = allowedPaths.value?.map(safeRelativePath) ?? [];
  const normalizedForbidden = forbiddenPaths.value?.map(safeRelativePath) ?? [];
  if (normalizedAllowed.some((value) => value === null)) findings.push(finding("P0", "CONTRACT_ALLOWED_PATH", "input.contract.allowedPaths", "allowedPaths must contain safe relative paths without dot segments", { example: ["src/"] }));
  if (normalizedForbidden.some((value) => value === null)) findings.push(finding("P0", "CONTRACT_FORBIDDEN_PATH", "input.contract.forbiddenPaths", "forbiddenPaths must contain safe relative paths without dot segments", { example: ["secrets/"] }));
  if (findings.length) return { findings };
  return { contract: { schemaVersion: CONTRACT_SCHEMA, allowedPaths: normalizedAllowed, forbiddenPaths: normalizedForbidden, maxChangedLines: maxChangedLines.value, allowNewFiles: allowNewFiles.value, allowDeleteFiles: allowDeleteFiles.value } };
}

function validateNodes(input) {
  const parsed = readContract(input);
  if (parsed.findings) return parsed;
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    return { findings: [finding("P0", "NODES_REQUIRED", "input.nodes", "nodes must be a non-empty array", { example: [{ path: "src/tax.ts", reason: "update rate", estimatedLines: 1 }] })] };
  }
  const findings = [];
  let estimatedSum = 0;
  const normalizedNodes = [];
  const seenPaths = new Set();
  for (const [index, node] of input.nodes.entries()) {
    const ref = `input.nodes[${index}]`;
    if (!isObject(node)) {
      findings.push(finding("P0", "NODE_OBJECT", ref, "node must be an object", { example: { path: "src/tax.ts", reason: "update rate", estimatedLines: 1 } }));
      continue;
    }
    const filePath = text(node.path).trim();
    const normalizedFilePath = safeRelativePath(filePath);
    const reason = text(node.reason).trim();
    const estimatedLines = node.estimatedLines;
    if (!filePath) findings.push(finding("P0", "NODE_PATH", `${ref}.path`, "path is required", { example: "src/tax.ts" }));
    else if (normalizedFilePath === null) findings.push(finding("P0", "NODE_PATH_UNSAFE", `${ref}.path`, "path must be a safe relative path without dot segments", { example: "src/tax.ts" }));
    if (!reason) findings.push(finding("P0", "NODE_REASON", `${ref}.reason`, "reason is required", { example: "update tax rate" }));
    if (typeof estimatedLines !== "number" || !Number.isFinite(estimatedLines) || estimatedLines < 0) {
      findings.push(finding("P0", "NODE_LINES", `${ref}.estimatedLines`, "estimatedLines must be a finite number >= 0", { example: 1 }));
    } else {
      estimatedSum += estimatedLines;
    }
    if (normalizedFilePath !== null && !pathAllowed(normalizedFilePath, parsed.contract)) {
      findings.push(finding("P0", "NODE_OUT_OF_SCOPE", `${ref}.path`, `${filePath} is outside the scope contract`, { example: "allowedPaths: [\"src/\"]" }));
    }
    if (normalizedFilePath !== null && seenPaths.has(normalizedFilePath)) {
      findings.push(finding("P0", "NODE_PATH_DUPLICATE", `${ref}.path`, "node paths must be unique", { example: normalizedFilePath }));
    } else if (normalizedFilePath !== null) {
      seenPaths.add(normalizedFilePath);
    }
    if (node.isNewFile === true && parsed.contract.allowNewFiles === false) {
      findings.push(finding("P0", "NODE_NEW_FILE", `${ref}.isNewFile`, "new files are forbidden by the contract", { example: false }));
    }
    if (node.isDelete === true && parsed.contract.allowDeleteFiles === false) {
      findings.push(finding("P0", "NODE_DELETE", `${ref}.isDelete`, "deletes are forbidden by the contract", { example: false }));
    }
    if (node.diffType !== undefined && !["add", "modify", "delete"].includes(node.diffType)) {
      findings.push(finding("P0", "NODE_DIFF_TYPE", `${ref}.diffType`, "diffType must be add, modify, or delete", { example: "modify" }));
    }
    if (normalizedFilePath !== null && reason
      && typeof estimatedLines === "number" && Number.isFinite(estimatedLines) && estimatedLines >= 0) {
      normalizedNodes.push({
        path: normalizedFilePath, reason, estimatedLines,
        diffType: node.diffType ?? (node.isDelete === true ? "delete" : node.isNewFile === true ? "add" : "modify"),
        isNewFile: node.isNewFile === true, isDelete: node.isDelete === true,
      });
    }
  }
  if (estimatedSum > parsed.contract.maxChangedLines) {
    findings.push(finding("P0", "NODE_BUDGET", "input.nodes", `estimated ${estimatedSum} lines exceed maxChangedLines ${parsed.contract.maxChangedLines}`, { example: "maxChangedLines: 50" }));
  }
  if (findings.length) return { findings };
  return { contract: parsed.contract, nodes: normalizedNodes, estimatedSum };
}

function officialMatchAllowed(slug, demand) {
  const active = demand.mode !== "bypass";
  const codeGoal = demand.goalKind === "code" || demand.goalKind === "mixed";
  if (slug === "calctool") return demand.goalKind === "calculator" || demand.requiresCalculator;
  if (slug === "confirm-protocol") return demand.requiresConfirmation || demand.risk === "high";
  if (slug === "archguard") return codeGoal && (demand.hasArchitectureContract || demand.newProject);
  if (slug === "blueprint") return active && ["probe", "swarm"].includes(demand.mode)
    && demand.contractUnclear && !demand.hasBlueprint;
  if (slug === "swarm") return active && demand.mode === "swarm";
  if (slug === "validator") return active && (demand.risk === "high" || demand.requiresValidation);
  if (slug === "mergeguard") return active && demand.requiresMerge;
  return slug !== "aimlock";
}

function validateResolvedSkills(input, demand) {
  if (!Array.isArray(input?.serverResolvedSkills)) {
    return { findings: [finding("P0", "ROUTE_RESOLUTION_REQUIRED", "input.serverResolvedSkills", "server-resolved skill matches are required", { example: [] })] };
  }
  if (demand.mode === "bypass" && input.serverResolvedSkills.length > 1) {
    return { findings: [finding("P0", "BYPASS_SINGLE_SKILL", "input.serverResolvedSkills", "bypass may recommend at most one specialist skill", { example: [] })] };
  }
  const specified = new Set(Array.isArray(input.userSpecifiedSkills) ? input.userSpecifiedSkills : []);
  const findings = [];
  for (const [index, skill] of input.serverResolvedSkills.entries()) {
    const ref = `input.serverResolvedSkills[${index}]`;
    if (!isObject(skill) || !/^[A-Za-z0-9]{10}$/.test(text(skill.runtimeCode))
      || !text(skill.slug).trim() || typeof skill.call !== "boolean" || typeof skill.analyze !== "boolean") {
      findings.push(finding("P0", "ROUTE_MATCH_SHAPE", ref, "resolved skill shape is invalid", { example: { runtimeCode: "AbCdEfGh12", slug: "skill", call: true, analyze: false } }));
      continue;
    }
    if (!skill.call && !(skill.analyze && specified.has(skill.runtimeCode))) {
      findings.push(finding("P0", "ROUTE_MATCH_AUTHORITY", ref, "resolved skill must be callable or an explicitly named analysis candidate", { example: true }));
    }
    if (skill.official !== false && !officialMatchAllowed(skill.slug, demand)) {
      findings.push(finding("P0", "ROUTE_CAPABILITY_MISMATCH", ref, `${skill.slug} does not match this demand`, { example: demand.goalKind }));
    }
  }
  return findings.length ? { findings } : { skills: input.serverResolvedSkills };
}

function routeSkills(input) {
  const mode = text(input?.mode).trim();
  const goalKind = text(input?.goalKind).trim();
  const risk = requireChoice(input, "risk", RISKS);
  const requiredBooleans = ["hasBlueprint", "contractUnclear", "hasArchitectureContract", "newProject",
    "requiresConfirmation", "requiresCalculator", "requiresMerge", "requiresValidation"]
    .map((key) => requireBoolean(input, key));
  const findings = collect([risk, ...requiredBooleans]);
  if (!MODES.has(mode)) findings.push(finding("P0", "MODE_REQUIRED", "input.mode", "mode must be bypass, lock, probe, or swarm", { example: "bypass" }));
  if (!GOAL_KINDS.has(goalKind)) findings.push(finding("P0", "GOAL_KIND", "input.goalKind", "goalKind must be code, calculator, mixed, or docs", { example: "code" }));
  if (input?.officialCatalog !== undefined || input?.useRegistry !== undefined) {
    findings.push(finding("P0", "FULL_CATALOG_FORBIDDEN", "input", "full catalogs and local registries are forbidden; the server injects only matched skills", { example: false }));
  }
  if (findings.length) return { findings };
  const demand = { mode, goalKind, risk: risk.value, hasBlueprint: input.hasBlueprint,
    contractUnclear: input.contractUnclear,
    hasArchitectureContract: input.hasArchitectureContract, newProject: input.newProject,
    requiresConfirmation: input.requiresConfirmation || risk.value === "high", requiresCalculator: input.requiresCalculator,
    requiresMerge: input.requiresMerge, requiresValidation: input.requiresValidation };
  const resolved = validateResolvedSkills(input, demand);
  if (resolved.findings) return resolved;
  return { mode, hops: resolved.skills };
}

function snapshotBinding(input) {
  const validated = validateNodes(input);
  if (validated.findings) return validated;
  const paths = validated.nodes.map((node) => node.path).sort();
  return {
    contract: validated.contract, nodes: validated.nodes, paths,
    contractDigest: digest(validated.contract), nodeDigest: digest(validated.nodes),
    pathDigest: digest(paths),
  };
}

function snapshotPlan(input) {
  const runId = requireSnapshotIdentifier(input, "runId");
  const findings = collect([runId]);
  if (input?.createBranch === true || input?.gitBranch === true || input?.worktree === true) findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "Aimlock forbids git branches and worktrees; snapshot with file copies", { example: false }));
  const binding = snapshotBinding(input);
  if (binding.findings) findings.push(...binding.findings);
  if (findings.length) return { findings };
  const snapshotId = `snap-${runId.value}`;
  return { snapshot: {
    snapshotId, method: "file-copy", snapshotRoot: `.aimlock/snapshots/${runId.value}`,
    paths: binding.paths, contractDigest: binding.contractDigest,
    nodeDigest: binding.nodeDigest, pathDigest: binding.pathDigest,
    forbidGitBranch: true, forbidWorktree: true,
  } };
}

function mutateGate(input) {
  const accepted = requireBoolean(input, "accepted");
  const findings = collect([accepted]);
  if (input?.createBranch === true || input?.gitBranch === true) findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "mutate must not create a git branch", { example: false }));
  if (accepted.value === false) findings.push(finding("P0", "MUTATE_NOT_ACCEPTED", "input.accepted", "mutate is forbidden until nodes are accepted", { example: true }));
  const binding = snapshotBinding(input);
  if (binding.findings) findings.push(...binding.findings);
  const receipt = input?.receipt;
  if (!isObject(receipt)) {
    findings.push(finding("P0", "SNAPSHOT_RECEIPT", "input.receipt", "a snapshot-verify receipt is required", { example: { schemaVersion: SNAPSHOT_RECEIPT_SCHEMA } }));
  } else if (!binding.findings) {
    const expectedKeys = ["contractDigest", "fileManifestDigest", "nodeDigest", "pathDigest", "paths", "receiptDigest", "schemaVersion", "snapshotId"];
    const core = {
      schemaVersion: receipt.schemaVersion, snapshotId: receipt.snapshotId,
      contractDigest: receipt.contractDigest, nodeDigest: receipt.nodeDigest,
      pathDigest: receipt.pathDigest, fileManifestDigest: receipt.fileManifestDigest,
    };
    const validId = requireSnapshotIdentifier({ snapshotId: receipt.snapshotId }, "snapshotId");
    const validReceipt = Object.keys(receipt).sort().join("\n") === expectedKeys.join("\n")
      && !validId.error && receipt.schemaVersion === SNAPSHOT_RECEIPT_SCHEMA
      && receipt.contractDigest === binding.contractDigest
      && receipt.nodeDigest === binding.nodeDigest && receipt.pathDigest === binding.pathDigest
      && Array.isArray(receipt.paths) && digest(receipt.paths) === binding.pathDigest
      && SHA256_PATTERN.test(receipt.fileManifestDigest)
      && receipt.receiptDigest === digest(core);
    if (!validReceipt) findings.push(finding("P0", "SNAPSHOT_RECEIPT_BINDING", "input.receipt", "snapshot receipt does not match the accepted contract, nodes, and paths", { example: binding.pathDigest }));
  }
  if (findings.length) return { findings };
  return { allowed: true, snapshotId: receipt.snapshotId, receiptDigest: receipt.receiptDigest };
}

function validateTestEvidence(value, ref) {
  const findings = [];
  if (!isObject(value)) return [finding("P0", "TEST_EVIDENCE_OBJECT", ref, "TestEvidence must be an object", { example: { schemaVersion: TEST_EVIDENCE_SCHEMA } })];
  if (value.schemaVersion !== TEST_EVIDENCE_SCHEMA) findings.push(finding("P0", "TEST_EVIDENCE_SCHEMA", `${ref}.schemaVersion`, `Expected ${TEST_EVIDENCE_SCHEMA}`, { example: TEST_EVIDENCE_SCHEMA }));
  if (!text(value.evidenceId).trim()) findings.push(finding("P0", "TEST_EVIDENCE_ID", `${ref}.evidenceId`, "evidenceId is required", { example: "test-1" }));
  if (!["test", "build", "lint", "security", "benchmark"].includes(value.kind)) findings.push(finding("P0", "TEST_EVIDENCE_KIND", `${ref}.kind`, "kind is not supported", { example: "test" }));
  if (!["local", "trusted-runner"].includes(value.runner)) findings.push(finding("P0", "TEST_EVIDENCE_RUNNER", `${ref}.runner`, "runner must be local or trusted-runner", { example: "local" }));
  if (!text(value.command).trim()) findings.push(finding("P0", "TEST_EVIDENCE_COMMAND", `${ref}.command`, "command is required", { example: "pnpm test" }));
  if (!Number.isInteger(value.exitCode)) findings.push(finding("P0", "TEST_EVIDENCE_EXIT", `${ref}.exitCode`, "exitCode must be an integer", { example: 0 }));
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs) || value.durationMs < 0) findings.push(finding("P0", "TEST_EVIDENCE_DURATION", `${ref}.durationMs`, "durationMs must be a finite number >= 0", { example: 100 }));
  if (!text(value.summary).trim()) findings.push(finding("P0", "TEST_EVIDENCE_SUMMARY", `${ref}.summary`, "summary is required", { example: "all tests passed" }));
  if (value.artifactSha256 !== undefined && !SHA256_PATTERN.test(value.artifactSha256)) findings.push(finding("P0", "TEST_EVIDENCE_ARTIFACT", `${ref}.artifactSha256`, "artifactSha256 must be a lowercase SHA-256 digest", { example: "a".repeat(64) }));
  return findings;
}

function continuity(input) {
  const changedLines = requireNumber(input, "changedLines");
  const maxChangedLines = requireNumber(input, "maxChangedLines");
  const testsPassed = requireBoolean(input, "testsPassed");
  const omissionScanDone = requireBoolean(input, "omissionScanDone");
  const findings = collect([changedLines, maxChangedLines, testsPassed, omissionScanDone]);
  if (findings.length) return { findings };
  // Per-node expansion check (document 3.4): warn when a single node exceeds 50% of maxChangedLines
  const changedNodes = Array.isArray(input.changedNodes) ? input.changedNodes : [];
  const expansionWarnings = [];
  for (const [idx, node] of changedNodes.entries()) {
    if (!isObject(node)) continue;
    const nodeLines = typeof node.changedLines === "number" ? node.changedLines : 0;
    const threshold = Math.floor(maxChangedLines.value * 0.5);
    if (nodeLines > threshold && maxChangedLines.value > 0) {
      expansionWarnings.push(finding("P1", "NODE_EXPANSION", `input.changedNodes[${idx}]`, `node '${node.path}' changedLines ${nodeLines} exceeds 50% of maxChangedLines (${maxChangedLines.value})`, { example: { path: node.path, diffType: node.diffType ?? "modified", changedLines: threshold } }));
    }
  }
  if (changedLines.value > maxChangedLines.value) return { trafficLight: "red", reason: "changed lines exceed the contract budget", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  if (testsPassed.value === false) return { trafficLight: "red", reason: "continuity tests failed", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  const testEvidence = Array.isArray(input.testEvidence) ? input.testEvidence : [];
  if (testsPassed.value === true && testEvidence.length === 0) return { trafficLight: "yellow", reason: "tests passed but no evidence provided", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  const evidenceFindings = testEvidence.flatMap((evidence, index) => validateTestEvidence(evidence, `input.testEvidence[${index}]`));
  if (evidenceFindings.length) return { trafficLight: "red", reason: "test evidence is invalid", evidenceFindings, ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  if (testEvidence.some((evidence) => evidence.exitCode !== 0)) return { trafficLight: "red", reason: "test evidence contains a failed command", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  if (omissionScanDone.value === false) return { trafficLight: "yellow", reason: "omission scan not done", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
  return { trafficLight: "green", reason: "within budget, tests passed, omission scan done", ...(expansionWarnings.length ? { expansionWarnings } : {}) };
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
  if (goalComplete.value) return { armed: false, intervalSeconds: 0, mode: "protocol", callerTimerRequired: false, note: "goal is complete; no caller timer is required" };
  return {
    armed: false,
    intervalSeconds: KEEP_ALIVE_SECONDS,
    mode: "protocol",
    callerTimerRequired: true,
    message: KEEP_ALIVE_MESSAGE,
    note: "Aimlock is stateless and does not arm a timer; the caller must schedule and send this message every 90 seconds",
  };
}

function deliveryDoc(input) {
  const userConfirmed = requireBoolean(input, "userConfirmed");
  if (userConfirmed.error) return { findings: [userConfirmed.error] };
  if (userConfirmed.value === false) return { required: false, skip: true };
  return { required: true, skip: false, instruction: "workers write local notes; main agent merges one document" };
}

function validateRunJson(project) {
  const f = [];
  if (!isObject(project)) return [finding("P0", "RUN_OBJECT", "input.project", "project must be an object", { example: { goal: "update tax", mode: "lock", tasks: [] } })];
  if (!text(project.goal).trim()) f.push(finding("P0", "RUN_GOAL", "input.project.goal", "goal is required", { example: "update tax rate" }));
  const mode = text(project.mode);
  if (!MODES.has(mode)) f.push(finding("P0", "RUN_MODE", "input.project.mode", "mode must be bypass, lock, probe, or swarm", { example: "lock" }));
  if (!Array.isArray(project.tasks)) f.push(finding("P0", "RUN_TASKS", "input.project.tasks", "tasks must be an array", { example: [{ path: "src/tax.ts" }] }));
  if (mode === "bypass") {
    const activeFields = Object.keys(project).filter((key) => !["goal", "mode", "tasks"].includes(key));
    if (activeFields.length || (Array.isArray(project.tasks) && project.tasks.length > 0)) {
      f.push(finding("P0", "BYPASS_ACTIVE_ARTIFACT", "input.project", "bypass must not contain a contract, tasks, snapshots, or active-chain artifacts", { example: { goal: "small edit", mode: "bypass", tasks: [] } }));
    }
  } else if (MODES.has(mode)) {
    const parsed = readContract({ contract: project.contract });
    if (parsed.findings) f.push(...parsed.findings);
  }
  return f;
}

function validateRequest(request) {
  const f = [];
  if (!isObject(request)) return [finding("P0", "REQUEST_OBJECT", "request", "request must be an object", { example: { schemaVersion: REQUEST_SCHEMA, requestId: "req-1", operation: "capabilities" } })];
  if (![LEGACY_REQUEST_SCHEMA, REQUEST_SCHEMA].includes(request.schemaVersion)) f.push(finding("P0", "REQUEST_SCHEMA", "request.schemaVersion", `Expected ${LEGACY_REQUEST_SCHEMA} or ${REQUEST_SCHEMA}`, { example: REQUEST_SCHEMA }));
  if (!text(request.requestId)) f.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.requestId", "requestId is required", { example: "req-1" }));
  if (!text(request.operation)) f.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.operation", "operation is required", { example: "capabilities" }));
  return f;
}

function legacyCompatibleInput(operation, input) {
  if (operation === "classify") {
    return { ...input, risk: input.risk ?? "medium", explicitAimlockRequested: input.explicitAimlockRequested ?? false };
  }
  if (operation === "skill-route") {
    return {
      ...input,
      contractUnclear: input.contractUnclear ?? input.hasBlueprint === false,
      hasArchitectureContract: input.hasArchitectureContract ?? false,
      newProject: input.newProject ?? false,
      requiresConfirmation: input.requiresConfirmation ?? false,
    };
  }
  return input;
}

function handleClassify(requestId, input) {
  const declaredRisk = requireChoice(input, "risk", RISKS);
  if (declaredRisk.error) return blockedResponse(requestId, [declaredRisk.error]);
  // 第一层：确定性规则分类（产物类型/风险/链路）
  const demand = classifyDemand({ ...input, risk: declaredRisk.value });
  if (demand.findings) return blockedResponse(requestId, demand.findings);
  // 如果规则未命中，返回追问
  if (demand.source === "needs-clarification") {
    return okResponse(requestId, { ...demand, nextStep: { operation: "classify", instruction: "Answer the clarification question, then re-classify." } });
  }
  const result = classifyMode({ ...input, risk: demand.risk });
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    ...result,
    product: demand.product, risk: demand.risk, chain: demand.chain, confidence: demand.confidence, classificationSource: demand.source,
    nextStep: result.mode === "bypass"
      ? { operation: "skill-route", instruction: "Resolve at most one specialist skill; do not start the Aimlock chain." }
      : demand.chain === "chat" ? { operation: null, instruction: "Pure chat; no chain needed." }
        : { operation: "scope-contract", instruction: "Lock the active Aimlock scope before routing." },
  });
}

function handleContract(requestId, input) {
  const parsed = readContract(input);
  if (parsed.findings) return blockedResponse(requestId, parsed.findings);
  return okResponse(requestId, { contract: parsed.contract, nextStep: { operation: "skill-route", instruction: "Match hops, then probe or mutate inside the contract." } });
}
function handleRoute(requestId, input) {
  const routed = routeSkills(input);
  if (routed.findings) return blockedResponse(requestId, routed.findings);
  if (routed.mode === "bypass") {
    return okResponse(requestId, { useAimlock: false, recommendedSkills: routed.hops,
      nextStep: { operation: null, instruction: "Handle directly or invoke only the returned specialist." } });
  }
  if (routed.hops.length === 0) {
    return okResponse(requestId, { hops: [],
      nextStep: { operation: "propose-nodes", instruction: "No specialist is needed; return modification nodes read-only." } });
  }
  return okResponse(requestId, { hops: routed.hops,
    nextStep: { operation: "chain-plan", instruction: "Plan only the returned server-resolved skill ids." } });
}
function handlePropose(requestId, input) {
  const result = validateNodes(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, { nodes: result.nodes, estimatedSum: result.estimatedSum, contract: result.contract, nextStep: { operation: "accept-nodes", instruction: "Accept in-scope nodes, or escalate conflicts." } });
}
function handleAccept(requestId, input) {
  const result = validateNodes(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  const conflicts = Array.isArray(input.conflicts) ? input.conflicts : null;
  if (input.conflicts !== undefined && !Array.isArray(input.conflicts))
    return blockedResponse(requestId, [finding("P0", "CONFLICTS_ARRAY", "input.conflicts", "conflicts must be an array when present", { example: [{ path: "src/tax.ts", reason: "conflict" }] })]);
  const autoAccept = !conflicts || conflicts.length === 0;
  return okResponse(requestId, { autoAccept, escalate: !autoAccept, nodes: result.nodes,
    nextStep: autoAccept ? { operation: "snapshot-plan", instruction: "Snapshot the target files, then mutate-gate." }
      : { operation: "accept-nodes", instruction: "Resolve conflicts with the main agent before mutate." } });
}
function handleSnapshot(requestId, input) {
  const result = snapshotPlan(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, { snapshot: result.snapshot, nextStep: { operation: "snapshot-verify", instruction: "Copy files into snapshotRoot, hash every source and snapshot copy, then verify equality." } });
}
function handleMutate(requestId, input) {
  const result = mutateGate(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, { allowed: true, snapshotId: result.snapshotId, nextStep: { operation: "continuity-check", instruction: "After mutate, traffic-light budget, tests, and omission scan." } });
}
function handleContinuity(requestId, input) {
  const result = continuity(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  const done = result.trafficLight === "green";
  const payload = { trafficLight: result.trafficLight, reason: result.reason };
  if (result.expansionWarnings && result.expansionWarnings.length) payload.expansionWarnings = result.expansionWarnings;
  if (result.evidenceFindings && result.evidenceFindings.length) payload.evidenceFindings = result.evidenceFindings;
  return okResponse(requestId, { ...payload,
    nextStep: done ? { operation: "keep-alive", instruction: "If the whole aim is complete, set goalComplete true." }
      : { operation: "mutate-gate", instruction: "Red or yellow: roll back from the snapshot and fix inside the contract." } });
}

function snapshotVerify(input) {
  const sid = requireSnapshotIdentifier(input, "snapshotId");
  if (sid.error) return { findings: [sid.error] };
  const binding = snapshotBinding(input);
  if (binding.findings) return binding;
  const files = input?.files;
  if (!Array.isArray(files) || files.length === 0) return { findings: [finding("P0", "VERIFY_FILES", "input.files", "files must be a non-empty array", { example: [{ path: "src/tax.ts", sourceHash: "a".repeat(64), snapshotHash: "a".repeat(64) }] })] };
  const findings = [];
  const normalizedFiles = [];
  for (const [i, f] of files.entries()) {
    const ref = `input.files[${i}]`;
    const normalizedPath = isObject(f) ? safeRelativePath(f.path) : null;
    if (!isObject(f) || normalizedPath === null) {
      findings.push(finding("P0", "VERIFY_FILE_OBJECT", ref, "each file must have a non-empty path", { example: { path: "src/tax.ts", sourceHash: "a".repeat(64), snapshotHash: "a".repeat(64) } }));
      continue;
    }
    if (!SHA256_PATTERN.test(f.sourceHash)) findings.push(finding("P0", "VERIFY_SOURCE_HASH", `${ref}.sourceHash`, "sourceHash must be a lowercase SHA-256 digest", { example: "a".repeat(64) }));
    if (!SHA256_PATTERN.test(f.snapshotHash)) findings.push(finding("P0", "VERIFY_SNAPSHOT_HASH", `${ref}.snapshotHash`, "snapshotHash must be a lowercase SHA-256 digest", { example: "a".repeat(64) }));
    if (SHA256_PATTERN.test(f.sourceHash) && SHA256_PATTERN.test(f.snapshotHash) && f.sourceHash !== f.snapshotHash) findings.push(finding("P0", "SNAPSHOT_HASH_MISMATCH", ref, `${f.path} differs from its snapshot copy`, { example: { sourceHash: f.sourceHash, snapshotHash: f.sourceHash } }));
    if (SHA256_PATTERN.test(f.sourceHash) && SHA256_PATTERN.test(f.snapshotHash)) {
      normalizedFiles.push({ path: normalizedPath, sourceHash: f.sourceHash, snapshotHash: f.snapshotHash });
    }
  }
  normalizedFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (normalizedFiles.map((file) => file.path).join("\n") !== binding.paths.join("\n")) {
    findings.push(finding("P0", "SNAPSHOT_PATH_SET", "input.files", "snapshot files must exactly match the accepted node paths", { example: binding.paths }));
  }
  if (findings.length) return { findings };
  const core = {
    schemaVersion: SNAPSHOT_RECEIPT_SCHEMA, snapshotId: sid.value,
    contractDigest: binding.contractDigest, nodeDigest: binding.nodeDigest,
    pathDigest: binding.pathDigest, fileManifestDigest: digest(normalizedFiles),
  };
  return { verified: true, snapshotId: sid.value, fileCount: files.length,
    receipt: { ...core, paths: binding.paths, receiptDigest: digest(core) } };
}
function runStatus(input) {
  const rid = requireText(input, "runId");
  if (rid.error) return { findings: [rid.error] };
  const boundary = "Aimlock is stateless; run state must be supplied by the caller and is never persisted by this operation.";
  if (input.state === undefined) return { runId: rid.value, known: false, run: { status: "unknown", currentPhase: null, history: [] }, boundary };
  if (!isObject(input.state)) return { findings: [finding("P0", "RUN_STATE_OBJECT", "input.state", "state must be an object when supplied", { example: { status: "running", currentPhase: "validate", history: [] } })] };
  const findings = [];
  if (!["running", "blocked", "complete"].includes(input.state.status)) findings.push(finding("P0", "RUN_STATE_STATUS", "input.state.status", "status must be running, blocked, or complete", { example: "running" }));
  if (!text(input.state.currentPhase).trim()) findings.push(finding("P0", "RUN_STATE_PHASE", "input.state.currentPhase", "currentPhase is required", { example: "validate" }));
  if (!Array.isArray(input.state.history)) findings.push(finding("P0", "RUN_STATE_HISTORY", "input.state.history", "history must be an array", { example: [] }));
  if (findings.length) return { findings };
  return { runId: rid.value, known: true, run: { status: input.state.status, currentPhase: input.state.currentPhase, history: input.state.history }, boundary };
}

function finish(requestId, result, payload) {
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, payload ?? result);
}

async function executeRun(request) {
  const requestFindings = validateRequest(request);
  if (requestFindings.length) {
    return { ...blockedResponse(request?.requestId ?? "unknown", requestFindings), errorSchema: ERROR_SCHEMA };
  }
  const { requestId, operation } = request;
  const rawInput = isObject(request.input) ? request.input : {};
  const input = request.schemaVersion === LEGACY_REQUEST_SCHEMA
    ? legacyCompatibleInput(operation, rawInput) : rawInput;
  if (operation === "capabilities") {
    return okResponse(requestId, {
      capabilities: {
        pure: true, stateless: true, networkRequired: false, filesystemRequired: false,
        operations: [...PURE_OPERATIONS], operationSchemas: OPERATION_SCHEMAS,
        modes: ["bypass", "lock", "probe", "swarm"], forbidGitBranch: true,
        keepAliveSeconds: KEEP_ALIVE_SECONDS, keepAliveMessage: KEEP_ALIVE_MESSAGE,
        routing: "server-resolved-on-demand", userSpecifiedField: "userSpecifiedSkills",
        localTrustedExecution: {
          requiredFor: ["filesystem-probe", "read-budget", "mutate-pass", "guarded-write", "autocoord-lease"],
          operations: ["capabilities", "probe", "reassess", "budget-init", "budget-read", "budget-status",
            "budget-extend", "gate-issue", "gate-verify", "guarded-write"],
          command: "cli-aimlock local <operation> <repositoryRoot>",
          schemaDiscovery: "cli-aimlock local capabilities <repositoryRoot>",
          boundary: "Only host writes routed through guarded-write are physically intercepted.",
        },
      },
      skill: { name: COMPILER_NAME, version: COMPILER_VERSION },
      firstUseNotice: FIRST_USE_NOTICE,
      nextStep: { operation: "intake", instruction: "Ask the intake questions one at a time. Do not mutate files yet." },
    });
  }
  if (operation === "help") {
    return okResponse(requestId, {
      help: { name: COMPILER_NAME, version: COMPILER_VERSION, operations: OPERATION_CATALOG, operationSchemas: OPERATION_SCHEMAS },
      nextStep: { operation: "intake", instruction: "Ask the intake questions one at a time." },
    });
  }
  if (operation === "intake") {
    const answers = input?.answers;
    if (Array.isArray(answers) && answers.length > 0) {
      // Normalize {question, answer} pairs into {id, answer} by matching prompt text
      const normalized = answers.map((a) => {
        if (a.id) return { id: a.id, answer: a.answer };
        if (a.question) {
          const match = INTAKE_QUESTIONS.find((q) => q.prompt === a.question || q.id === a.question);
          if (match) return { id: match.id, answer: a.answer };
        }
        return { id: a.id ?? null, answer: a.answer };
      });
      const requiredIds = new Set(INTAKE_QUESTIONS.filter((q) => q.required).map((q) => q.id));
      const providedIds = new Set(normalized.filter((a) => a.id).map((a) => a.id));
      const missing = [...requiredIds].filter((id) => !providedIds.has(id));
      if (missing.length) return blockedResponse(requestId, [finding("P0", "INTAKE_MISSING", "input.answers", `missing required answers: ${missing.join(", ")}`, { example: INTAKE_QUESTIONS.map((q) => ({ id: q.id, answer: q.example })) })]);
      const answerMap = Object.fromEntries(normalized.filter((a) => a.id).map((a) => [a.id, a.answer]));
      return okResponse(requestId, { answers: answerMap, nextStep: { operation: "classify", instruction: "Classify bypass/lock/probe/swarm from the answers. Do not mutate yet." } });
    }
    return okResponse(requestId, { questions: INTAKE_QUESTIONS, nextStep: { operation: "classify", instruction: "Classify bypass/lock/probe/swarm from the answers. Do not mutate yet." } });
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
  if (operation === "snapshot-verify") return finish(requestId, snapshotVerify(input));
  if (operation === "run-status") return finish(requestId, runStatus(input));
  if (operation === "chain-plan") {
    const result = buildChainPlan({ ...input,
      confirmationRequestId: input.confirmationRequestId ?? requestId });
    if (result.findings) return blockedResponse(requestId, result.findings);
    return okResponse(requestId, { ...result, nextStep: result.ready.length ? { operation: result.ready[0], instruction: `Execute first ready step: ${result.ready[0]}` } : { operation: "chain-status", instruction: "All steps blocked or complete." } });
  }
  if (operation === "chain-status") return finish(requestId, chainStatus(input));
  if (operation === "feedback") return finish(requestId, submitFeedback(input));
  if (operation === "validate-json") {
    const findings = validateRunJson(input.project);
    if (findings.length) return blockedResponse(requestId, findings);
    return okResponse(requestId, { valid: true, nextStep: { operation: "classify", instruction: "Run JSON is valid." } });
  }
  return failed(requestId, "UNSUPPORTED_OPERATION", `Unsupported operation: ${operation}`);
}

export async function run(request) {
  const result = await executeRun(request);
  if (isObject(request) && request.schemaVersion === LEGACY_REQUEST_SCHEMA && isObject(result)) {
    return { ...result, schemaVersion: LEGACY_RESPONSE_SCHEMA };
  }
  return result;
}

export {
  COMPILER_VERSION, CONTRACT_SCHEMA, PURE_OPERATIONS, OPERATION_CATALOG, INTAKE_QUESTIONS, OPERATION_SCHEMAS,
  KEEP_ALIVE_SECONDS, KEEP_ALIVE_MESSAGE, FIRST_USE_NOTICE, BYPASS_NOTICE,
  classifyMode, readContract, validateNodes, routeSkills, snapshotPlan, mutateGate,
  continuity, interrupt, keepAlive, deliveryDoc, validateRunJson, snapshotVerify, runStatus, okResponse, blockedResponse, finding,
};
