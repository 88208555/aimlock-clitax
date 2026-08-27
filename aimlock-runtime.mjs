// aimlock Router：统一路由入口 + 技能注册表 + 执行链编排
// 与 aimlock-runtime.mjs 配合；发布时由 pack 脚本拼接为自包含文件

const REGISTRY_VERSION = "1.2.0";

// ---------- 技能注册表（8 技能） ----------
// 每个技能必须有 whenToCall / whenNotToCall / prerequisites / chainPosition 四项
const SKILL_REGISTRY = Object.freeze({
  version: REGISTRY_VERSION,
  skills: Object.freeze({
    aimlock: { segment: "入口段", whenToCall: ["涉及代码/文件变更"], whenNotToCall: ["纯闲聊", "纯查询"], prerequisites: [], chainPosition: 0 },
    blueprint: { segment: "规划段", whenToCall: ["多节点工程", "跨模块变更"], whenNotToCall: ["单文件小改"], prerequisites: ["aimlock"], chainPosition: 1 },
    swarm: { segment: "执行段", whenToCall: ["并行/多任务拆单"], whenNotToCall: ["单文件单实现者"], prerequisites: ["aimlock"], chainPosition: 2 },
    calctool: { segment: "生成段", whenToCall: ["计算工具", "公式固化", "指标测算"], whenNotToCall: ["纯展示页面", "无计算逻辑"], prerequisites: ["aimlock"], chainPosition: 2 },
    "confirm-protocol": { segment: "交互层", whenToCall: ["需要用户结构化确认"], whenNotToCall: ["无需确认", "纯查询"], prerequisites: ["aimlock"], chainPosition: 3 },
    archguard: { segment: "执行守卫段", whenToCall: ["新项目建架构合同", "已有合同的代码写入"], whenNotToCall: ["无合同的存量项目", "纯文档", "只读分析"], prerequisites: ["aimlock"], chainPosition: 4 },
    mergeguard: { segment: "合并段", whenToCall: ["分支合并", "规则校验"], whenNotToCall: ["无版本对比需求"], prerequisites: ["swarm"], chainPosition: 5 },
    validator: { segment: "验证段", whenToCall: ["交付前终审"], whenNotToCall: ["中间过程自检"], prerequisites: [], chainPosition: 6 },
  }),
});

// ---------- 内置链路模板 ----------
const CHAIN_TEMPLATES = Object.freeze({
  "code-risky": ["aimlock", "blueprint", "swarm", "mergeguard", "validator"],
  "code-risky-contract": ["aimlock", "blueprint", "swarm", "archguard", "mergeguard", "validator"],
  "calculator": ["aimlock", "calctool", "validator"],
  "page-new": ["aimlock", "archguard", "blueprint", "swarm", "validator"],
  "merge": ["mergeguard", "validator"],
  "probe-only": ["aimlock"],
  "chat": [],
});

// ---------- 需求分类规则表（第一层：确定性匹配） ----------
const CLASSIFY_RULES = [
  { pattern: /计算器|公式|测算|对账|指标固化|在线测算|计算工具/i, product: "calculator", risk: "low", chain: "calculator" },
  { pattern: /分支合并|合并代码|merge|冲突解决/i, product: "merge", risk: "medium", chain: "merge" },
  { pattern: /纯查询|查看|读取|了解|咨询|闲聊/i, product: "none", risk: "low", chain: "chat" },
  { pattern: /只读分析|分析代码|代码审查|review/i, product: "analysis", risk: "low", chain: "probe-only" },
  { pattern: /新建页面|新建工具|新增功能|创建/i, product: "page", risk: "low", chain: "page-new" },
  { pattern: /修改|更新|重构|修复|bug|调整|优化|改/i, product: "code", risk: "medium", chain: "code-risky" },
];
const HIGH_RISK_PATTERNS = [/生产数据|支付|用户隐私|财务|密码|密钥|线上环境|production/i];

// ---------- 分类器 ----------
function classifyDemand(input) {
  const goal = String(input?.goal ?? "").trim();
  if (!goal) return { findings: [{ severity: "P0", ruleId: "CLASSIFY_GOAL", entityRef: "input.goal", message: "goal is required for classification", evidence: { example: "修改税率常量" } }] };
  // 第一层：确定性规则匹配
  for (const rule of CLASSIFY_RULES) {
    if (rule.pattern.test(goal)) {
      const isHighRisk = HIGH_RISK_PATTERNS.some((p) => p.test(goal));
      return { product: rule.product, risk: isHighRisk ? "high" : rule.risk, chain: rule.chain, confidence: 1.0, source: "rule" };
    }
  }
  const assisted = input?.modelClassification;
  const allowedProducts = new Set(["calculator", "merge", "none", "analysis", "page", "code"]);
  const allowedRisks = new Set(["low", "medium", "high"]);
  const allowedChains = new Set(Object.keys(CHAIN_TEMPLATES));
  if (assisted && typeof assisted === "object" && Number(assisted.confidence) >= 0.75
    && allowedProducts.has(assisted.product) && allowedRisks.has(assisted.risk)
    && allowedChains.has(assisted.chain)) {
    return { product: assisted.product, risk: assisted.risk, chain: assisted.chain,
      confidence: Number(assisted.confidence), source: "model-assisted" };
  }
  // 第二层：未命中 → 需要追问
  return { product: null, risk: "unknown", chain: null, confidence: 0, source: "needs-clarification",
    question: "请描述您想实现的产物类型？", options: ["计算工具", "代码修改", "新建页面", "分支合并", "只读分析"] };
}

// ---------- 执行链计划 ----------
function buildChainPlan(input) {
  const chainName = String(input?.chain ?? "").trim();
  const hasArchitectureContract = input?.hasArchitectureContract === true;
  const resolvedChain = chainName === "code-risky" && hasArchitectureContract
    ? "code-risky-contract" : chainName;
  const template = CHAIN_TEMPLATES[resolvedChain];
  if (!template) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_TEMPLATE", entityRef: "input.chain", message: `unknown chain: ${chainName}; valid: ${Object.keys(CHAIN_TEMPLATES).join(", ")}`, evidence: { example: "code-risky" } }] };
  }
  const skip = new Set(Array.isArray(input?.skip) ? input.skip : []);
  const risk = String(input?.risk ?? "low").trim();
  const steps = template.filter((s) => !skip.has(s));
  // 高风险锁定：validator 不可跳过
  if (risk === "high" && skip.has("validator")) {
    return { findings: [{ severity: "P0", ruleId: "HIGH_RISK_LOCK", entityRef: "input.skip", message: "validator cannot be skipped for high-risk demands", evidence: { example: "remove 'validator' from skip" } }] };
  }
  const completedList = Array.isArray(input?.completed) ? input.completed : [];
  if (new Set(completedList).size !== completedList.length
    || completedList.some((step) => !steps.includes(step))) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_COMPLETED_INVALID", entityRef: "input.completed", message: "completed must contain unique steps from the selected chain", evidence: { example: steps.slice(0, 1) } }] };
  }
  const expectedPrefix = steps.slice(0, completedList.length);
  if (expectedPrefix.some((step, index) => step !== completedList[index])) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_ORDER", entityRef: "input.completed", message: "completed steps must be an exact chain prefix", evidence: { example: expectedPrefix } }] };
  }
  const current = steps[completedList.length] ?? null;
  const ready = current ? [current] : [];
  const blocked = current ? steps.slice(completedList.length + 1)
    .map((step) => ({ step, waitingFor: [current] })) : [];
  const architectureRecommendation = chainName === "code-risky" && !hasArchitectureContract
    ? "Existing project has no architecture contract: continue without blocking and recommend contract-create for the next scoped change."
    : null;
  return { chain: steps, ready, blocked, current, totalSteps: steps.length,
    completedSteps: completedList.length, risk, registryVersion: REGISTRY_VERSION, architectureRecommendation };
}

// ---------- 注册表操作 ----------
function registerSkill(input) {
  const skillId = String(input?.skillId ?? "").trim();
  const whenToCall = input?.whenToCall;
  const whenNotToCall = input?.whenNotToCall;
  const prerequisites = input?.prerequisites;
  const chainPosition = input?.chainPosition;
  const findings = [];
  if (!skillId) findings.push({ severity: "P0", ruleId: "REGISTER_ID", entityRef: "input.skillId", message: "skillId is required", evidence: { example: "my-skill" } });
  if (!Array.isArray(whenToCall) || whenToCall.length === 0) findings.push({ severity: "P0", ruleId: "REGISTER_WHEN", entityRef: "input.whenToCall", message: "whenToCall must be a non-empty array", evidence: { example: ["trigger condition"] } });
  if (!Array.isArray(whenNotToCall) || whenNotToCall.length === 0) findings.push({ severity: "P0", ruleId: "REGISTER_WHEN_NOT", entityRef: "input.whenNotToCall", message: "whenNotToCall must be a non-empty array", evidence: { example: ["exclusion condition"] } });
  if (!Array.isArray(prerequisites)) findings.push({ severity: "P0", ruleId: "REGISTER_PREREQ", entityRef: "input.prerequisites", message: "prerequisites must be an array (empty if none)", evidence: { example: [] } });
  if (typeof chainPosition !== "number" || chainPosition < 0) findings.push({ severity: "P0", ruleId: "REGISTER_POSITION", entityRef: "input.chainPosition", message: "chainPosition must be a non-negative integer", evidence: { example: 2 } });
  if (SKILL_REGISTRY.skills[skillId]) findings.push({ severity: "P0", ruleId: "REGISTER_DUPLICATE", entityRef: "input.skillId", message: "skillId is already registered", evidence: { example: "new-skill" } });
  if (findings.length) return { findings };
  const registryEntry = { segment: String(input?.segment ?? "扩展段"), whenToCall: [...whenToCall],
    whenNotToCall: [...whenNotToCall], prerequisites: [...prerequisites], chainPosition };
  return { registered: true, applied: false, persistenceRequired: true, skillId,
    registryVersion: REGISTRY_VERSION, registryEntry,
    instruction: "Persist this validated registryEntry in the server registry before routing it." };
}

// ---------- 反馈操作 ----------
function submitFeedback(input) {
  const fromSkill = String(input?.fromSkill ?? "").trim();
  const toSkill = String(input?.toSkill ?? "").trim();
  const reason = String(input?.reason ?? "").trim();
  const demand = String(input?.demand ?? "").trim();
  const findings = [];
  if (!fromSkill) findings.push({ severity: "P0", ruleId: "FEEDBACK_FROM", entityRef: "input.fromSkill", message: "fromSkill is required", evidence: { example: "calctool" } });
  if (!toSkill) findings.push({ severity: "P0", ruleId: "FEEDBACK_TO", entityRef: "input.toSkill", message: "toSkill is required", evidence: { example: "swarm" } });
  if (!reason) findings.push({ severity: "P0", ruleId: "FEEDBACK_REASON", entityRef: "input.reason", message: "reason is required", evidence: { example: "should have routed to calctool for formula work" } });
  if (findings.length) return { findings };
  const feedbackId = String(input?.feedbackId ?? "").trim();
  if (!feedbackId) return { findings: [{ severity: "P0", ruleId: "FEEDBACK_ID", entityRef: "input.feedbackId", message: "feedbackId is required for auditable persistence", evidence: { example: "route-feedback-0001" } }] };
  return { recorded: true, applied: false, persistenceRequired: true, feedbackId,
    record: { feedbackId, fromSkill, toSkill, reason, demand }, registryVersion: REGISTRY_VERSION,
    instruction: "Persist this feedback record before updating any routing rule." };
}

// ---------- 链路进度查询 ----------
function chainStatus(input) {
  const chainId = String(input?.chainId ?? "").trim();
  const steps = Array.isArray(input?.steps) ? input.steps : [];
  const completed = Array.isArray(input?.completed) ? input.completed : [];
  if (!chainId || steps.length === 0 || new Set(steps).size !== steps.length
    || completed.length > steps.length || completed.some((step, index) => step !== steps[index])) {
    return { findings: [{ severity: "P0", ruleId: "CHAIN_STATUS_INVALID", entityRef: "input", message: "chainId is required and completed must be an exact prefix of unique steps", evidence: { example: { chainId: "chain-1", steps: ["aimlock", "validator"], completed: ["aimlock"] } } }] };
  }
  const current = steps.find((s) => !completed.includes(s)) ?? null;
  return { chainId, steps, completed, current, totalSteps: steps.length, completedSteps: completed.length, isComplete: completed.length >= steps.length && steps.length > 0 };
}

export { REGISTRY_VERSION, SKILL_REGISTRY, CHAIN_TEMPLATES, CLASSIFY_RULES, HIGH_RISK_PATTERNS, classifyDemand, buildChainPlan, registerSkill, submitFeedback, chainStatus };
// aimlock runtime v7.0.0 — 统一路由入口 + 变更门禁。Self-contained after build concat.
const REQUEST_SCHEMA = "aimlock.skill.request/1.0";
const RESPONSE_SCHEMA = "aimlock.skill.response/1.0";
const ERROR_SCHEMA = "aimlock.skill.error/1.0";
const CONTRACT_SCHEMA = "aimlock.scope-contract/1.0";
const COMPILER_NAME = "aimlock";
const COMPILER_VERSION = "v7.0.19";
const KEEP_ALIVE_SECONDS = 90;
const KEEP_ALIVE_MESSAGE = "智能目标持续执行中，请勿关闭！";
const LOCK_LINE_BUDGET = 20;
const PROBE_LINE_BUDGET = 80;
const PROBE_FILE_BUDGET = 3;
const CATALOG_SCHEMA = "cli.tax.skill-catalog/1.0";
const TEST_EVIDENCE_SCHEMA = "cli.tax.test-evidence/1.0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const OPERATIONS = [
  "capabilities", "help", "intake", "classify", "scope-contract", "skill-route",
  "propose-nodes", "accept-nodes", "snapshot-plan", "mutate-gate",
  "continuity-check", "interrupt", "keep-alive", "delivery-doc", "validate-json",
  "snapshot-verify", "run-status",
  "chain-plan", "chain-status", "registry-register", "feedback",
];
const PURE_OPERATIONS = new Set(OPERATIONS);
const OPERATION_CATALOG = Object.freeze(OPERATIONS.map((operation) => ({ operation, summary: operation })));

const OPERATION_SCHEMAS = Object.freeze({
  "classify": {
    input: {
      type: "object",
      required: ["goal", "targetFiles", "estimatedChangedLines", "crossModule", "needParallel"],
      properties: {
        goal: { type: "string", minLength: 1 },
        targetFiles: { type: "array", items: { type: "string" } },
        estimatedChangedLines: { type: "number", minimum: 0 },
        crossModule: { type: "boolean" },
        needParallel: { type: "boolean" },
        modelClassification: {
          type: "object", optional: true,
          required: ["product", "risk", "chain", "confidence"],
          properties: {
            product: { type: "string", enum: ["calculator", "merge", "none", "analysis", "page", "code"] },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            chain: { type: "string", enum: Object.keys(CHAIN_TEMPLATES) },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
    output: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["lock", "probe", "swarm"] },
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
      required: ["mode", "goalKind", "hasBlueprint"],
      properties: {
        mode: { type: "string", enum: ["lock", "probe", "swarm"] },
        goalKind: { type: "string", enum: ["code", "calculator", "mixed", "docs"] },
        hasBlueprint: { type: "boolean" },
        hasArchitectureContract: { type: "boolean", optional: true },
        newProject: { type: "boolean", optional: true },
        requiresConfirmation: { type: "boolean", optional: true },
        useRegistry: { type: "boolean", optional: true, description: "use server-side registry instead of full catalog" },
        officialCatalog: { type: "object", optional: true, description: "full catalog object (legacy mode)" },
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
      required: ["accepted", "snapshotId", "snapshotVerified", "contract", "nodes"],
      properties: {
        accepted: { type: "boolean", description: "must be true to proceed" },
        snapshotId: { type: "string" },
        snapshotVerified: { type: "boolean", description: "must be true after snapshot-verify succeeds" },
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
      required: ["runId", "paths"],
      properties: {
        runId: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "non-empty array of file paths to snapshot" },
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
      required: ["snapshotId", "files"],
      properties: {
        snapshotId: { type: "string" },
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
      required: ["chain", "risk"],
      properties: {
        chain: { type: "string", enum: ["code-risky", "calculator", "page-new", "merge", "probe-only", "chat"] },
        risk: { type: "string", enum: ["low", "medium", "high"] },
        skip: { type: "array", items: { type: "string" }, optional: true },
        completed: { type: "array", items: { type: "string" }, optional: true },
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
  "registry-register": {
    input: {
      type: "object",
      required: ["skillId", "whenToCall", "whenNotToCall", "prerequisites", "chainPosition"],
      properties: {
        skillId: { type: "string" },
        whenToCall: { type: "array", items: { type: "string" }, minItems: 1 },
        whenNotToCall: { type: "array", items: { type: "string" }, minItems: 1 },
        prerequisites: { type: "array", items: { type: "string" } },
        chainPosition: { type: "number", description: "non-negative integer" },
        segment: { type: "string", optional: true },
      },
    },
    output: {
      type: "object",
      properties: {
        registered: { type: "boolean" },
        applied: { type: "boolean" },
        persistenceRequired: { type: "boolean" },
        skillId: { type: "string" },
        registryVersion: { type: "string" },
        registryEntry: { type: "object" },
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
            mode: { type: "string", enum: ["lock", "probe", "swarm"] },
            contract: { type: "object" },
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
const MODES = new Set(["lock", "probe", "swarm"]);

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
function collect(parts) { return parts.filter((p) => p.error).map((p) => p.error); }

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
  const lockable = fileCount === 1 && lines.value <= LOCK_LINE_BUDGET && crossModule.value === false && needParallel.value === false;
  const probeable = fileCount <= PROBE_FILE_BUDGET && lines.value <= PROBE_LINE_BUDGET && needParallel.value === false;
  const mode = lockable ? "lock" : probeable ? "probe" : "swarm";
  return { mode, reason: lockable ? "single-file change within lock budget" : probeable ? "bounded change needs read-only probe before mutate" : "cross-module, parallel, or over-budget work uses swarm", goal: goal.value, targetFiles: targetFiles.value, estimatedChangedLines: lines.value };
}

function normalizedPrefix(value) {
  const normalized = text(value).trim().replace(/\/{2,}/g, "/").replace(/\/+$/g, "");
  return normalized || "/";
}
function matchesPrefix(filePath, prefixes) {
  const normalizedPath = normalizedPrefix(filePath);
  return prefixes.some((value) => {
    const prefix = normalizedPrefix(value);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  });
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
  const forbiddenPaths = Array.isArray(contract.forbiddenPaths) ? { value: contract.forbiddenPaths.filter((item) => typeof item === "string") } : { value: [] };
  if (Array.isArray(contract.forbiddenPaths) === false && contract.forbiddenPaths !== undefined) {
    return { findings: [finding("P0", "CONTRACT_FORBIDDEN", "input.contract.forbiddenPaths", "forbiddenPaths must be a string array when present", { example: ["tests/"] })] };
  }
  const maxChangedLines = requireNumber(contract, "maxChangedLines");
  const allowNewFiles = requireBoolean(contract, "allowNewFiles");
  const allowDeleteFiles = requireBoolean(contract, "allowDeleteFiles");
  const findings = collect([allowedPaths, maxChangedLines, allowNewFiles, allowDeleteFiles]);
  if (allowedPaths.value && allowedPaths.value.length === 0) findings.push(finding("P0", "CONTRACT_ALLOWED", "input.contract.allowedPaths", "allowedPaths must not be empty", { example: ["src/"] }));
  if (maxChangedLines.value === 0) findings.push(finding("P0", "CONTRACT_BUDGET", "input.contract.maxChangedLines", "maxChangedLines must be > 0", { example: 50 }));
  if (findings.length) return { findings };
  return { contract: { schemaVersion: CONTRACT_SCHEMA, allowedPaths: allowedPaths.value, forbiddenPaths: forbiddenPaths.value, maxChangedLines: maxChangedLines.value, allowNewFiles: allowNewFiles.value, allowDeleteFiles: allowDeleteFiles.value } };
}

function validateNodes(input) {
  const parsed = readContract(input);
  if (parsed.findings) return parsed;
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    return { findings: [finding("P0", "NODES_REQUIRED", "input.nodes", "nodes must be a non-empty array", { example: [{ path: "src/tax.ts", reason: "update rate", estimatedLines: 1 }] })] };
  }
  const findings = [];
  let estimatedSum = 0;
  for (const [index, node] of input.nodes.entries()) {
    const ref = `input.nodes[${index}]`;
    if (!isObject(node)) {
      findings.push(finding("P0", "NODE_OBJECT", ref, "node must be an object", { example: { path: "src/tax.ts", reason: "update rate", estimatedLines: 1 } }));
      continue;
    }
    const filePath = text(node.path).trim();
    const reason = text(node.reason).trim();
    const estimatedLines = node.estimatedLines;
    if (!filePath) findings.push(finding("P0", "NODE_PATH", `${ref}.path`, "path is required", { example: "src/tax.ts" }));
    if (!reason) findings.push(finding("P0", "NODE_REASON", `${ref}.reason`, "reason is required", { example: "update tax rate" }));
    if (typeof estimatedLines !== "number" || !Number.isFinite(estimatedLines) || estimatedLines < 0) {
      findings.push(finding("P0", "NODE_LINES", `${ref}.estimatedLines`, "estimatedLines must be a finite number >= 0", { example: 1 }));
    } else {
      estimatedSum += estimatedLines;
    }
    if (filePath && !pathAllowed(filePath, parsed.contract)) {
      findings.push(finding("P0", "NODE_OUT_OF_SCOPE", `${ref}.path`, `${filePath} is outside the scope contract`, { example: "allowedPaths: [\"src/\"]" }));
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
  }
  if (estimatedSum > parsed.contract.maxChangedLines) {
    findings.push(finding("P0", "NODE_BUDGET", "input.nodes", `estimated ${estimatedSum} lines exceed maxChangedLines ${parsed.contract.maxChangedLines}`, { example: "maxChangedLines: 50" }));
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
  if (rule.requiresArchitectureContractOrNewProject
    && !demand.hasArchitectureContract && !demand.newProject) {
    return { call: false, reason: rule.reasonSkip };
  }
  return { call: true, reason: rule.reasonCall };
}

function matchCatalogHops(catalog, demand) {
  const specified = new Set(demand.userSpecifiedSkills);
  const current = catalog.skills.find((skill) => skill.runtimeCode === catalog.currentRuntimeCode);
  const currentRole = current?.role ?? "user-specified";
  return catalog.skills.map((skill) => {
    if (skill.runtimeCode === catalog.currentRuntimeCode) return { ...skill, call: false, analyze: false, reason: "self" };
    if (!skill.official && !specified.has(skill.runtimeCode)) return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    if (!catalog.hopsEnabled) return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    if (!skill.official) return { ...skill, call: false, analyze: true, reason: "user-specified: confirm capabilities match the demand before invoke" };
    const rule = catalog.hopRules.find((item) => item.role === skill.role);
    if (!rule) return { ...skill, call: false, analyze: false, reason: "extension-unrelated" };
    return { ...skill, analyze: false, ...hopAllowed(rule, demand, currentRole) };
  });
}

function routeSkills(input) {
  const modeText = text(input?.mode).trim();
  const kindText = text(input?.goalKind).trim();
  const findings = [];
  if (!MODES.has(modeText)) findings.push(finding("P0", "MODE_REQUIRED", "input.mode", "mode must be lock, probe, or swarm", { example: "lock" }));
  if (!GOAL_KINDS.has(kindText)) findings.push(finding("P0", "GOAL_KIND", "input.goalKind", "goalKind must be code, calculator, mixed, or docs", { example: "code" }));
  const hasBlueprint = requireBoolean(input, "hasBlueprint");
  if (hasBlueprint.error) findings.push(hasBlueprint.error);
  const specified = input?.userSpecifiedSkills;
  const hasArchitectureContract = input?.hasArchitectureContract === true;
  const newProject = input?.newProject === true;
  const requiresConfirmation = input?.requiresConfirmation === true;
  if (specified !== undefined && (!Array.isArray(specified) || specified.some((item) => typeof item !== "string")))
    findings.push(finding("P0", "USER_SPECIFIED", "input.userSpecifiedSkills", "userSpecifiedSkills must be a string array when present", { example: ["other-skill"] }));
  // Router 模式：使用服务端注册表（不再要求调用方回传完整 officialCatalog）
  if (input?.useRegistry === true || input?.registryVersion) {
    if (findings.length) return { findings };
    const hops = Object.entries(SKILL_REGISTRY.skills).map(([id, reg]) => {
      if (id === "aimlock") return { skillId: id, call: false, reason: "self" };
      const explicitlyRequested = specified?.includes(id) === true;
      if (id === "blueprint") return { skillId: id,
        call: newProject || (modeText !== "lock" && !hasBlueprint.value),
        reason: newProject ? "plan after architecture contract" : "planning contract when needed", segment: reg.segment };
      if (id === "swarm") return { skillId: id, call: modeText === "swarm",
        reason: "parallel dispatch only for swarm mode", segment: reg.segment };
      if (id === "calctool") return { skillId: id,
        call: kindText === "calculator" || kindText === "mixed",
        reason: "calculator capability match", segment: reg.segment };
      if (id === "confirm-protocol") return { skillId: id, call: requiresConfirmation,
        reason: requiresConfirmation ? "structured user confirmation required" : "no confirmation requested", segment: reg.segment };
      if (id === "archguard") return { skillId: id,
        call: (kindText === "code" || kindText === "mixed")
          && (hasArchitectureContract || newProject),
        reason: newProject ? "create contract before planning"
          : hasArchitectureContract ? "checkpoint code against existing contract"
            : "existing project has no contract; recommend without blocking", segment: reg.segment };
      if (id === "mergeguard") return { skillId: id, call: explicitlyRequested,
        reason: explicitlyRequested ? "user requested merge guard" : "no merge requested", segment: reg.segment };
      if (id === "validator") return { skillId: id, call: kindText !== "docs" || modeText !== "lock",
        reason: "final deterministic delivery gate", segment: reg.segment };
      return { skillId: id, call: false, reason: "capability-unrelated", segment: reg.segment };
    });
    return { hops, registryVersion: REGISTRY_VERSION };
  }
  // 兼容模式：回传完整 officialCatalog（向后兼容）
  const catalog = input?.officialCatalog;
  if (!isObject(catalog) || catalog.schemaVersion !== CATALOG_SCHEMA) {
    if (typeof input?.catalogVersion === "string" && !isObject(catalog))
      findings.push(finding("P1", "CATALOG_CACHED", "input.officialCatalog", "catalogVersion provided but officialCatalog missing; use cached catalog", { example: "use cached officialCatalog from capabilities response" }));
    else findings.push(finding("P0", "CATALOG_REQUIRED", "input.officialCatalog", "officialCatalog from capabilities is required (or set useRegistry: true)", { example: { schemaVersion: "cli.tax.skill-catalog/1.0", skills: [], hopRules: [] } }));
  }
  if (isObject(catalog) && (!Array.isArray(catalog.skills) || !Array.isArray(catalog.hopRules)))
    findings.push(finding("P0", "CATALOG_SHAPE", "input.officialCatalog", "officialCatalog.skills and hopRules must be arrays", { example: { skills: [], hopRules: [] } }));
  if (findings.length) return { findings };
  return { hops: matchCatalogHops(catalog, { mode: modeText, goalKind: kindText,
    hasBlueprint: hasBlueprint.value, hasArchitectureContract, newProject,
    userSpecifiedSkills: specified ?? [] }) };
}

function snapshotPlan(input) {
  const runId = requireText(input, "runId");
  const paths = requireStringArray(input, "paths");
  const findings = collect([runId, paths]);
  if (input?.createBranch === true || input?.gitBranch === true || input?.worktree === true) findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "Aimlock forbids git branches and worktrees; snapshot with file copies", { example: false }));
  if (paths.value && paths.value.length === 0) findings.push(finding("P0", "SNAPSHOT_PATHS", "input.paths", "paths to snapshot must not be empty", { example: ["src/tax.ts"] }));
  if (findings.length) return { findings };
  return { snapshot: { snapshotId: `snap-${runId.value}`, method: "file-copy", snapshotRoot: `.aimlock/snapshots/${runId.value}`, paths: paths.value, forbidGitBranch: true, forbidWorktree: true } };
}

function mutateGate(input) {
  const accepted = requireBoolean(input, "accepted");
  const snapshotId = requireText(input, "snapshotId");
  const snapshotVerified = requireBoolean(input, "snapshotVerified");
  const findings = collect([accepted, snapshotId, snapshotVerified]);
  if (input?.createBranch === true || input?.gitBranch === true) findings.push(finding("P0", "BRANCH_FORBIDDEN", "input", "mutate must not create a git branch", { example: false }));
  if (accepted.value === false) findings.push(finding("P0", "MUTATE_NOT_ACCEPTED", "input.accepted", "mutate is forbidden until nodes are accepted", { example: true }));
  if (snapshotVerified.value === false) findings.push(finding("P0", "SNAPSHOT_NOT_VERIFIED", "input.snapshotVerified", "mutate is forbidden until snapshot-verify succeeds", { example: true }));
  const nodes = validateNodes(input);
  if (nodes.findings) findings.push(...nodes.findings);
  if (findings.length) return { findings };
  return { allowed: true, snapshotId: snapshotId.value };
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
  if (!MODES.has(text(project.mode))) f.push(finding("P0", "RUN_MODE", "input.project.mode", "mode must be lock, probe, or swarm", { example: "lock" }));
  const parsed = readContract({ contract: project.contract });
  if (parsed.findings) f.push(...parsed.findings);
  if (!Array.isArray(project.tasks)) f.push(finding("P0", "RUN_TASKS", "input.project.tasks", "tasks must be an array", { example: [{ path: "src/tax.ts" }] }));
  return f;
}

function validateRequest(request) {
  const f = [];
  if (!isObject(request)) return [finding("P0", "REQUEST_OBJECT", "request", "request must be an object", { example: { schemaVersion: "aimlock.skill.request/1.0", requestId: "req-1", operation: "capabilities" } })];
  if (request.schemaVersion !== REQUEST_SCHEMA) f.push(finding("P0", "REQUEST_SCHEMA", "request.schemaVersion", `Expected ${REQUEST_SCHEMA}`, { example: REQUEST_SCHEMA }));
  if (!text(request.requestId)) f.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.requestId", "requestId is required", { example: "req-1" }));
  if (!text(request.operation)) f.push(finding("P0", "REQUEST_REQUIRED_FIELD", "request.operation", "operation is required", { example: "capabilities" }));
  return f;
}

function handleClassify(requestId, input) {
  // 第一层：确定性规则分类（产物类型/风险/链路）
  const demand = classifyDemand(input);
  if (demand.findings) return blockedResponse(requestId, demand.findings);
  // 如果规则未命中，返回追问
  if (demand.source === "needs-clarification") {
    return okResponse(requestId, { ...demand, nextStep: { operation: "classify", instruction: "Answer the clarification question, then re-classify." } });
  }
  // 规则命中 → 同时走原有 lock/probe/swarm 分档
  const result = classifyMode(input);
  if (result.findings) return blockedResponse(requestId, result.findings);
  return okResponse(requestId, {
    ...result,
    product: demand.product, risk: demand.risk, chain: demand.chain, confidence: demand.confidence, classificationSource: demand.source,
    nextStep: demand.chain === "chat" ? { operation: null, instruction: "Pure chat; no chain needed." }
      : demand.chain === "probe-only" ? { operation: "scope-contract", instruction: "Read-only probe; write scope contract then analyze." }
      : { operation: "chain-plan", instruction: "Generate the execution chain plan for this demand." },
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
  return okResponse(requestId, { hops: routed.hops, nextStep: { operation: "propose-nodes", instruction: "Workers return modification nodes read-only. Do not mutate yet." } });
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
  const sid = requireText(input, "snapshotId");
  if (sid.error) return { findings: [sid.error] };
  const files = input?.files;
  if (!Array.isArray(files) || files.length === 0) return { findings: [finding("P0", "VERIFY_FILES", "input.files", "files must be a non-empty array", { example: [{ path: "src/tax.ts", sourceHash: "a".repeat(64), snapshotHash: "a".repeat(64) }] })] };
  const findings = [];
  for (const [i, f] of files.entries()) {
    const ref = `input.files[${i}]`;
    if (!isObject(f) || !text(f.path).trim()) {
      findings.push(finding("P0", "VERIFY_FILE_OBJECT", ref, "each file must have a non-empty path", { example: { path: "src/tax.ts", sourceHash: "a".repeat(64), snapshotHash: "a".repeat(64) } }));
      continue;
    }
    if (!SHA256_PATTERN.test(f.sourceHash)) findings.push(finding("P0", "VERIFY_SOURCE_HASH", `${ref}.sourceHash`, "sourceHash must be a lowercase SHA-256 digest", { example: "a".repeat(64) }));
    if (!SHA256_PATTERN.test(f.snapshotHash)) findings.push(finding("P0", "VERIFY_SNAPSHOT_HASH", `${ref}.snapshotHash`, "snapshotHash must be a lowercase SHA-256 digest", { example: "a".repeat(64) }));
    if (SHA256_PATTERN.test(f.sourceHash) && SHA256_PATTERN.test(f.snapshotHash) && f.sourceHash !== f.snapshotHash) findings.push(finding("P0", "SNAPSHOT_HASH_MISMATCH", ref, `${f.path} differs from its snapshot copy`, { example: { sourceHash: f.sourceHash, snapshotHash: f.sourceHash } }));
  }
  if (findings.length) return { findings };
  return { verified: true, snapshotId: sid.value, fileCount: files.length };
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
        operations: [...PURE_OPERATIONS], operationSchemas: OPERATION_SCHEMAS,
        modes: ["lock", "probe", "swarm"], forbidGitBranch: true,
        keepAliveSeconds: KEEP_ALIVE_SECONDS, keepAliveMessage: KEEP_ALIVE_MESSAGE,
        defaultAllowlist: "official", userSpecifiedField: "userSpecifiedSkills", catalogSchema: CATALOG_SCHEMA,
        registryVersion: REGISTRY_VERSION, registry: SKILL_REGISTRY,
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
      return okResponse(requestId, { answers: answerMap, nextStep: { operation: "classify", instruction: "Classify lock/probe/swarm from the answers. Do not mutate yet." } });
    }
    return okResponse(requestId, { questions: INTAKE_QUESTIONS, nextStep: { operation: "classify", instruction: "Classify lock/probe/swarm from the answers. Do not mutate yet." } });
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
    const result = buildChainPlan(input);
    if (result.findings) return blockedResponse(requestId, result.findings);
    return okResponse(requestId, { ...result, nextStep: result.ready.length ? { operation: result.ready[0], instruction: `Execute first ready step: ${result.ready[0]}` } : { operation: "chain-status", instruction: "All steps blocked or complete." } });
  }
  if (operation === "chain-status") return finish(requestId, chainStatus(input));
  if (operation === "registry-register") return finish(requestId, registerSkill(input));
  if (operation === "feedback") return finish(requestId, submitFeedback(input));
  if (operation === "validate-json") {
    const findings = validateRunJson(input.project);
    if (findings.length) return blockedResponse(requestId, findings);
    return okResponse(requestId, { valid: true, nextStep: { operation: "classify", instruction: "Run JSON is valid." } });
  }
  return failed(requestId, "UNSUPPORTED_OPERATION", `Unsupported operation: ${operation}`);
}

export {
  COMPILER_VERSION, CONTRACT_SCHEMA, PURE_OPERATIONS, OPERATION_CATALOG, INTAKE_QUESTIONS, OPERATION_SCHEMAS,
  CATALOG_SCHEMA, KEEP_ALIVE_SECONDS, KEEP_ALIVE_MESSAGE, FIRST_USE_NOTICE,
  classifyMode, readContract, validateNodes, routeSkills, matchCatalogHops, snapshotPlan, mutateGate,
  continuity, interrupt, keepAlive, deliveryDoc, validateRunJson, snapshotVerify, runStatus, okResponse, blockedResponse, finding,
};
