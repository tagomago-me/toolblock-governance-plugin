import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "typebox";
import YAML from "yaml";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_DIR = path.join(__dirname, "policies");
const DEFAULT_AUDIT_LOG = path.join(__dirname, "logs", "policy-engine.jsonl");
const DEFAULT_EVIDENCE_LEDGER = path.join(__dirname, "logs", "evidence-ledger.jsonl");
const RECORD_EVIDENCE_GATEWAY_METHOD = "preflight.record_evidence";
const RECORD_EVIDENCE_TOOL_NAME = "preflight_record_evidence";
const POLICY_WRITE_FILE_TOOL_NAME = "policy_write_file";
const POLICY_WRITE_FILE_GATEWAY_METHOD = "policy_engine.write_file";

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", POLICY_WRITE_FILE_TOOL_NAME]);
const EXEC_TOOLS = new Set(["bash", "exec", "exec_command", "shell"]);

const RECORD_EVIDENCE_TOOL_SCHEMA = Type.Object(
  {
    source_type: Type.String({ minLength: 1 }),
    source_ref: Type.String({ minLength: 1 }),
    query_or_path: Type.Optional(Type.String()),
    summary: Type.String({ minLength: 1 }),
    supports_claim: Type.String({ minLength: 1 }),
    run_id: Type.Optional(Type.String()),
    session_id: Type.Optional(Type.String()),
    session_key: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const POLICY_WRITE_FILE_TOOL_SCHEMA = Type.Object(
  {
    path: Type.String({ minLength: 1 }),
    content: Type.String(),
    preflight_claim: Type.Optional(Type.Any()),
    run_id: Type.Optional(Type.String()),
    session_id: Type.Optional(Type.String()),
    session_key: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const WRITE_COMMAND_PATTERNS = [
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\bmkdir\b/,
  /\brmdir\b/,
  /\btouch\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bsed\s+-i\b/,
  /\bperl\s+-i\b/,
  /\btee\b/,
  /\btruncate\b/,
  /\binstall\b/,
  /\bterraform\b/,
  /\bkubectl\b/,
  /\bdocker\b/,
  /\bsystemctl\b/,
  /\bservice\b/,
  /\bgit\s+(commit|push|tag|merge|rebase|cherry-pick|reset|checkout|switch)\b/,
  /\bpython3\s+~?\/?.*plane\.py\s+(state|move|comment)\b/,
  /(^|[^\d])>(?!&\d)/,
  />>/,
];

const READ_ONLY_COMMAND_PATTERNS = [
  /^\s*(cat|less|more|head|tail|pwd|env|printenv|which|whereis|whoami|date)\b/,
  /^\s*(rg|grep|find|ls|tree|stat|file|wc|sort|uniq|cut|awk|jq|sed\s+-n)\b/,
  /^\s*git\s+(status|diff|show|log|branch|rev-parse)\b/,
  /^\s*python3?\s+[^|;&]*\b(-c\s+)?["']?print\b/,
  /^\s*openclaw\s+(status|cron\s+list|sessions\s+list)\b/,
];

class EvidenceLedger {
  constructor(ledgerPath = DEFAULT_EVIDENCE_LEDGER) {
    this.ledgerPath = ledgerPath;
    this.records = new Map();
    this.dirty = false;
    this.loadFromDisk();
  }

  loadFromDisk() {
    if (!fs.existsSync(this.ledgerPath)) return;
    try {
      const lines = fs.readFileSync(this.ledgerPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record?.id) this.records.set(record.id, record);
      }
    } catch {
      this.records.clear();
    }
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
  }

  record(evidence) {
    const record = {
      ...evidence,
      id:
        evidence?.id ||
        `${evidence?.runId ?? evidence?.sessionId ?? evidence?.sessionKey ?? "unknown"}:${evidence?.sourceRef ?? "unknown"}:${Date.now()}`,
    };
    this.records.set(record.id, record);
    this.dirty = true;
    this.flush();
    return record;
  }

  flush() {
    if (!this.dirty) return;
    try {
      this.ensureDir();
      const lines = Array.from(this.records.values()).map((record) => JSON.stringify(record));
      fs.writeFileSync(this.ledgerPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
      this.dirty = false;
    } catch {
      // Ledger persistence is best-effort in degraded mode.
    }
  }

  getRecordsForRun(runId) {
    return Array.from(this.records.values()).filter((record) => record.runId === runId);
  }

  getRecordsForSessionId(sessionId) {
    return Array.from(this.records.values()).filter((record) => record.sessionId === sessionId);
  }

  getRecordsForSessionKey(sessionKey) {
    return Array.from(this.records.values()).filter((record) => record.sessionKey === sessionKey);
  }

  getRecordsForTargetPath(targetPath) {
    return Array.from(this.records.values()).filter((record) => matchesEvidenceTarget(record, targetPath));
  }

  findRecords({ runId, sessionId, sessionKey } = {}) {
    const lookups = [
      { scope: "runId", key: normalizeLookupValue(runId), getter: (key) => this.getRecordsForRun(key) },
      { scope: "sessionId", key: normalizeLookupValue(sessionId), getter: (key) => this.getRecordsForSessionId(key) },
      { scope: "sessionKey", key: normalizeLookupValue(sessionKey), getter: (key) => this.getRecordsForSessionKey(key) },
    ];

    for (const lookup of lookups) {
      if (!lookup.key) continue;
      const records = lookup.getter(lookup.key);
      if (records.length) {
        return {
          scope: lookup.scope,
          key: lookup.key,
          records,
        };
      }
    }

    const fallback = lookups.find((lookup) => lookup.key);
    return {
      scope: fallback?.scope ?? "none",
      key: fallback?.key ?? null,
      records: [],
    };
  }

  findRecordsForTargetPaths(targetPaths = []) {
    for (const targetPath of targetPaths) {
      const records = this.getRecordsForTargetPath(targetPath);
      if (records.length) {
        return {
          scope: "targetPath",
          key: targetPath,
          records,
        };
      }
    }

    return {
      scope: "targetPath",
      key: targetPaths[0] ?? null,
      records: [],
    };
  }
}

let globalEvidenceLedger;

function getEvidenceLedger() {
  if (!globalEvidenceLedger) {
    globalEvidenceLedger = new EvidenceLedger();
  }
  return globalEvidenceLedger;
}

function resolveConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const normalizedMode = lower(cfg.mode);
  const mode =
    normalizedMode === "audit" || normalizedMode === "disabled" || normalizedMode === "enforce"
      ? normalizedMode
      : cfg.enabled === false
        ? "disabled"
        : "enforce";
  return {
    enabled: cfg.enabled !== false,
    mode,
    onlyAgents: Array.isArray(cfg.onlyAgents)
      ? cfg.onlyAgents.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
      : [],
    approvalTimeoutMs:
      typeof cfg.approvalTimeoutMs === "number" && Number.isFinite(cfg.approvalTimeoutMs)
        ? Math.max(1_000, Math.floor(cfg.approvalTimeoutMs))
        : 600_000,
    approvalTimeoutBehavior: cfg.approvalTimeoutBehavior === "allow" ? "allow" : "deny",
    policiesDir:
      typeof cfg.policiesDir === "string" && cfg.policiesDir.trim()
        ? path.resolve(cfg.policiesDir.trim())
        : DEFAULT_POLICY_DIR,
    auditLogPath:
      typeof cfg.auditLogPath === "string" && cfg.auditLogPath.trim()
        ? path.resolve(cfg.auditLogPath.trim())
        : DEFAULT_AUDIT_LOG,
  };
}

function readYaml(policyDir, file) {
  return YAML.parse(fs.readFileSync(path.join(policyDir, file), "utf8"));
}

function loadPolicies(policyDir) {
  return {
    preflight: readYaml(policyDir, "default.preflight.yaml"),
    risk: readYaml(policyDir, "default.risk.yaml"),
    evidence: readYaml(policyDir, "default.evidence.yaml"),
    routing: readYaml(policyDir, "default.routing.yaml"),
    placement: readYaml(policyDir, "default.placement.yaml"),
    lifecycle: readYaml(policyDir, "default.artifact-lifecycle.yaml"),
    treeMirror: readYaml(policyDir, "default.tree-mirror.yaml"),
    completion: readYaml(policyDir, "default.completion.yaml"),
  };
}

function lower(value) {
  return String(value ?? "").toLowerCase();
}

function normalizeLookupValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeOptionalText(value, fallback = "") {
  return normalizeLookupValue(value) ?? fallback;
}

function getCommandText(params) {
  if (!params || typeof params !== "object") return "";
  for (const key of ["cmd", "command", "script", "input"]) {
    if (typeof params[key] === "string") return params[key];
  }
  return "";
}

function normalizePathCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractTargetPaths(event) {
  const seen = new Set();
  const out = [];
  const add = (value) => {
    const next = normalizePathCandidate(value);
    if (!next || seen.has(next)) return;
    seen.add(next);
    out.push(next);
  };

  const params = event.params ?? {};
  for (const key of ["path", "file_path", "file", "target", "destination", "cwd", "workdir"]) {
    add(params[key]);
  }
  for (const candidate of event.derivedPaths ?? []) add(candidate);
  return out;
}

function normalizeEvidencePayload(rawPayload, fallback = {}) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  return {
    id: "",
    timestamp: new Date().toISOString(),
    runId: normalizeOptionalText(payload.run_id ?? payload.runId, normalizeOptionalText(fallback.runId, "unknown")),
    sessionId: normalizeOptionalText(
      payload.session_id ?? payload.sessionId,
      normalizeOptionalText(fallback.sessionId, "unknown"),
    ),
    sessionKey: normalizeOptionalText(
      payload.session_key ?? payload.sessionKey,
      normalizeOptionalText(fallback.sessionKey, "unknown"),
    ),
    sourceType: normalizeOptionalText(payload.source_type ?? payload.sourceType, "unknown"),
    sourceRef: normalizeOptionalText(payload.source_ref ?? payload.sourceRef, "unknown"),
    queryOrPath: normalizeOptionalText(payload.query_or_path ?? payload.queryOrPath, ""),
    summary: normalizeOptionalText(payload.summary, ""),
    supportsClaim: normalizeOptionalText(payload.supports_claim ?? payload.supportsClaim, ""),
  };
}

function recordEvidencePayload(rawPayload, fallback = {}) {
  return getEvidenceLedger().record(normalizeEvidencePayload(rawPayload, fallback));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isStateChangingExec(params) {
  const command = getCommandText(params);
  if (!command) return false;
  if (matchesAny(command, WRITE_COMMAND_PATTERNS)) return true;
  if (matchesAny(command, READ_ONLY_COMMAND_PATTERNS)) return false;
  return false;
}

function isGuardedTool(event, policies) {
  const toolName = lower(event.toolName);
  if (DIRECT_MUTATION_TOOLS.has(toolName)) return true;
  if (EXEC_TOOLS.has(toolName)) return isStateChangingExec(event.params);

  const groups = Object.values(policies.preflight.guarded_tools ?? {});
  return groups.some((group) =>
    (group?.match?.tools ?? []).some((candidate) => toolName.includes(lower(candidate))),
  );
}

function globishMatch(filePath, pattern) {
  const file = filePath.replaceAll("\\", "/");
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.startsWith("**/*.")) {
    return file.endsWith(normalized.slice(4));
  }
  if (normalized.startsWith("**/")) {
    const suffix = normalized.slice(3);
    return file.endsWith(suffix) || file.includes(`/${suffix}`);
  }
  if (normalized.endsWith("/**")) {
    return file.startsWith(normalized.slice(0, -3));
  }
  return file.includes(normalized.replaceAll("*", ""));
}

function classifyTarget(event, policies) {
  const toolName = lower(event.toolName);
  const command = lower(getCommandText(event.params));
  const paths = extractTargetPaths(event);
  const claimHints = getClaimActionHints(event);
  const targetClasses = policies.risk.target_classes ?? {};

  for (const [name, config] of Object.entries(targetClasses)) {
    const tools = config?.match?.tools ?? [];
    if (tools.some((candidate) => toolName.includes(lower(candidate)))) return name;

    const operations = config?.match?.operations ?? [];
    if (
      operations.some((candidate) => {
        const normalized = lower(candidate);
        return command.includes(normalized) || claimHints.includes(normalized);
      })
    ) {
      return name;
    }

    const includes = config?.match?.paths ?? [];
    const excludes = config?.match?.exclude ?? [];
    for (const candidatePath of paths) {
      if (excludes.some((pattern) => globishMatch(candidatePath, pattern))) continue;
      if (includes.some((pattern) => globishMatch(candidatePath, pattern))) return name;
    }
  }

  if (EXEC_TOOLS.has(toolName)) return "shell";
  return "unknown";
}

function classifyEnvironment(event) {
  const paths = extractTargetPaths(event).map(lower);
  if (
    paths.some(
      (value) =>
        value.startsWith("/tmp/") ||
        value.startsWith("/var/tmp/") ||
        value.startsWith("/test/"),
    )
  ) {
    return "test";
  }

  const command = lower(getCommandText(event.params));
  if (command.includes("--dry-run") || command.includes(" dry-run") || command.includes(" sandbox")) {
    return "test";
  }

  return "production";
}

function shiftRisk(baseRisk, environment, policies) {
  const order = policies.risk.risk_order ?? ["low", "medium", "high", "critical"];
  const shift = policies.risk.environments?.[environment]?.risk_shift ?? 0;
  const index = Math.max(0, order.indexOf(baseRisk));
  return order[Math.min(order.length - 1, index + shift)];
}

function classifyRisk(event, targetClass, environment, policies) {
  const baseRisk = policies.risk.target_classes?.[targetClass]?.risk ?? "medium";
  let risk = shiftRisk(baseRisk, environment, policies);
  const command = lower(getCommandText(event.params));

  for (const rule of policies.risk.critical_overrides ?? []) {
    const condition = rule.when ?? {};
    const environmentOk = !condition.environment || condition.environment === environment;
    const classOk = !condition.target_class || condition.target_class === targetClass;
    const operationOk =
      !(condition.operation_contains ?? []).length ||
      condition.operation_contains.some((token) => command.includes(lower(token)));
    if (environmentOk && classOk && operationOk) {
      risk = rule.risk;
    }
  }

  return risk;
}

function getClaim(params) {
  if (!params || typeof params !== "object") return {};
  const raw = params.preflight_claim ?? params.preflightClaim;
  return raw && typeof raw === "object" ? raw : {};
}

function getClaimActionHints(event) {
  const claim = getClaim(event.params);
  return [claim.action_type, claim.target_kind, claim.operation]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => lower(value));
}

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function evidenceTokens(value) {
  return lower(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function matchesEvidenceTarget(record, targetPath) {
  const candidates = [record?.queryOrPath, record?.sourceRef].filter(
    (value) => typeof value === "string" && value.trim(),
  );
  return candidates.some((value) => value.includes(targetPath) || targetPath.includes(value));
}

function evidenceRefMatchesRecord(ref, record) {
  const candidates = [record?.id, record?.sourceRef, record?.queryOrPath, record?.summary, record?.supportsClaim].filter(
    (value) => typeof value === "string" && value.trim(),
  );
  const refTokens = evidenceTokens(ref);
  return candidates.some((candidate) => {
    if (candidate === ref || candidate.includes(ref) || ref.includes(candidate)) return true;
    const candidateTokens = evidenceTokens(candidate);
    return refTokens.some((token) => candidateTokens.includes(token));
  });
}

function evaluateEvidenceCompatibility(event, hookContext) {
  const claim = getClaim(event.params);
  const targetPaths = extractTargetPaths(event);
  const ledger = getEvidenceLedger();
  const identity = {
    runId: normalizeLookupValue(event.runId ?? hookContext?.runId),
    sessionId: normalizeLookupValue(hookContext?.sessionId),
    sessionKey: normalizeLookupValue(hookContext?.sessionKey),
  };
  const identityLookup = ledger.findRecords({
    runId: identity.runId,
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
  });
  const canUseTargetFallback = !identity.runId && !identity.sessionId && !identity.sessionKey;
  const lookup =
    identityLookup.records.length || !canUseTargetFallback
      ? identityLookup
      : ledger.findRecordsForTargetPaths(targetPaths);
  const records = lookup.records;
  const claimEvidenceRefs = [
    ...asStringList(claim.evidence_refs),
    ...asStringList(claim.evidence_ref),
  ];

  if (!records.length) {
    return {
      hasRecordedEvidence: false,
      compatible: false,
      records,
      lookupScope: lookup.scope,
      lookupKey: lookup.key,
      compatibilityMismatches: ["missing_recorded_evidence"],
    };
  }

  const mismatches = [];

  if (typeof claim.target_file === "string" && claim.target_file.trim()) {
    const targetFile = claim.target_file.trim();
    const claimMatchesTarget =
      targetPaths.length === 0 || targetPaths.includes(targetFile) || targetPaths.some((pathValue) => pathValue.includes(targetFile) || targetFile.includes(pathValue));
    const claimMatchesEvidence = records.some((record) => matchesEvidenceTarget(record, targetFile));
    if (!claimMatchesTarget || !claimMatchesEvidence) {
      mismatches.push("target_file_not_supported_by_ledger");
    }
  }

  if (claimEvidenceRefs.length) {
    const refsMatchEvidence = claimEvidenceRefs.some((ref) =>
      records.some((record) => evidenceRefMatchesRecord(ref, record)),
    );
    if (!refsMatchEvidence) {
      mismatches.push("claim_evidence_refs_not_found_in_ledger");
    }
  }

  return {
    hasRecordedEvidence: true,
    compatible: mismatches.length === 0,
    records,
    lookupScope: lookup.scope,
    lookupKey: lookup.key,
    compatibilityMismatches: mismatches,
  };
}

function collectMissingFields(event, risk, policies) {
  const claim = getClaim(event.params);
  const requiredBase = policies.preflight.pre_action_claim?.required_fields ?? [];
  const requiredByRisk = policies.evidence.requirements_by_risk?.[risk]?.required ?? [];
  const required = [...new Set([...requiredBase, ...requiredByRisk])];

  return required.filter((field) => {
    if (field === "evidence_refs_min_2") {
      const refs = claim.evidence_refs ?? claim.evidence_ref;
      return !Array.isArray(refs) || refs.length < 2;
    }
    return claim[field] === undefined || claim[field] === null || claim[field] === "";
  });
}

function isPlaneCloseIntent(event) {
  const toolName = lower(event.toolName);
  const command = lower(getCommandText(event.params));
  return (
    toolName.includes("plane") ||
    command.includes("plane.py state") ||
    command.includes("plane.py move")
  ) && (command.includes("done") || command.includes("close") || command.includes("completed"));
}

function collectMissingCompletionFields(event, policies) {
  if (!isPlaneCloseIntent(event)) return [];
  const claim = getClaim(event.params);
  return (policies.completion.requires ?? []).filter(
    (field) => claim[field] === undefined || claim[field] === null || claim[field] === "",
  );
}

function detectHardBlock(event, environment, missingFields, policies) {
  const command = lower(getCommandText(event.params));
  for (const rule of policies.evidence.hard_blocks ?? []) {
    const condition = rule.when ?? {};
    const environmentOk = !condition.environment || condition.environment === environment;
    const destructive =
      condition.operation_kind !== "destructive" ||
      /\brm\b|\brmdir\b|delete|destroy/.test(command);
    const missingOk =
      !(condition.missing ?? []).length ||
      condition.missing.some((field) => missingFields.includes(field));
    if (environmentOk && destructive && missingOk && rule.decision === "block") {
      return rule.name;
    }
  }
  return null;
}

function resolveKnowledgeSources(targetClass, policies) {
  const routes = policies.routing.routes ?? {};
  if (targetClass === "workspace_control" || targetClass === "infrastructure") {
    return routes.system_or_openclaw?.order ?? [];
  }
  if (targetClass === "pmo_or_ticket_docs" || targetClass === "plane_change") {
    return routes.previous_problem?.order ?? [];
  }
  return routes.information?.order ?? [];
}

function appendAudit(logPath, event, metadata) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      metadata,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Do not fail the guarded action solely because audit append failed in test mode.
  }
}

function evaluatePolicy(event, policies, hookContext) {
  if (!isGuardedTool(event, policies)) {
    return { outcome: "pass", metadata: { guarded: false, readOnlyBypass: true } };
  }

  const environment = classifyEnvironment(event);
  const targetClass = classifyTarget(event, policies);
  const risk = classifyRisk(event, targetClass, environment, policies);
  const missingFields = [
    ...collectMissingFields(event, risk, policies),
    ...collectMissingCompletionFields(event, policies),
  ];
  const hardBlock = detectHardBlock(event, environment, missingFields, policies);
  const evidenceCheck = evaluateEvidenceCompatibility(event, hookContext);
  const metadata = {
    guarded: true,
    environment,
    targetClass,
    risk,
    missingFields,
    recommendedSources: resolveKnowledgeSources(targetClass, policies),
    targetPaths: extractTargetPaths(event),
    hasRecordedEvidence: evidenceCheck.hasRecordedEvidence,
    evidenceCompatible: evidenceCheck.compatible,
    evidence_claim_match: evidenceCheck.compatible,
    ledgerRecordCount: evidenceCheck.records.length,
    evidenceLookupScope: evidenceCheck.lookupScope,
    evidenceLookupKey: evidenceCheck.lookupKey,
    compatibilityMismatches: evidenceCheck.compatibilityMismatches,
  };

  if (hardBlock) {
    return {
      decision: "block",
      reason: "hard_block",
      outcome: "block",
      blockReason: `Policy hard block: ${hardBlock}.`,
      metadata,
    };
  }

  if (!evidenceCheck.hasRecordedEvidence) {
    return {
      decision: "require_approval",
      reason: "missing_recorded_evidence",
      outcome: "approval",
      description:
        `Missing recorded evidence in ledger for guarded action. Complete claim is insufficient. ` +
        `Run ${RECORD_EVIDENCE_TOOL_NAME} (gateway method ${RECORD_EVIDENCE_GATEWAY_METHOD}) before write/edit/exec/config/deploy.`,
      metadata,
    };
  }

  if (missingFields.length) {
    return {
      decision: "require_approval",
      reason: "incomplete_claim",
      outcome: "approval",
      description: `Incomplete preflight claim: ${missingFields.join(", ")}.`,
      metadata,
    };
  }

  if (!evidenceCheck.compatible) {
    return {
      decision: "require_approval",
      reason: "evidence_claim_mismatch",
      outcome: "approval",
      description: `Claim is not compatible with recorded ledger evidence: ${evidenceCheck.compatibilityMismatches.join(", ")}.`,
      metadata,
    };
  }

  return {
    decision: "pass",
    reason: "verified_recorded_evidence",
    outcome: "pass",
    metadata,
  };
}

function normalizePolicyWritePayload(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const preflightClaim =
    payload.preflight_claim && typeof payload.preflight_claim === "object"
      ? payload.preflight_claim
      : payload.preflightClaim && typeof payload.preflightClaim === "object"
        ? payload.preflightClaim
        : {};
  return {
    path: normalizeOptionalText(payload.path, ""),
    content: typeof payload.content === "string" ? payload.content : String(payload.content ?? ""),
    preflight_claim: preflightClaim,
    run_id: normalizeOptionalText(payload.run_id ?? payload.runId, ""),
    session_id: normalizeOptionalText(payload.session_id ?? payload.sessionId, ""),
    session_key: normalizeOptionalText(payload.session_key ?? payload.sessionKey, ""),
  };
}

function resolvePolicyToolContext(payload, ctx) {
  return {
    runId: normalizeOptionalText(payload.run_id ?? ctx?.runId, ""),
    sessionId: normalizeOptionalText(payload.session_id ?? ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.(), ""),
    sessionKey: normalizeOptionalText(payload.session_key ?? ctx?.sessionKey, ""),
    agentId: ctx?.agentId,
  };
}

function buildPolicyWriteEvent(payload, context, toolCallId) {
  return {
    toolName: "write",
    params: {
      path: payload.path,
      content: payload.content,
      preflight_claim: payload.preflight_claim,
    },
    derivedPaths: [payload.path],
    runId: context.runId || undefined,
    toolCallId,
  };
}

function buildPolicyDecisionToolResult(result) {
  if (result.outcome === "block") {
    return {
      content: [
        {
          type: "text",
          text: result.blockReason ?? "Policy hard block.",
        },
      ],
      details: {
        ok: false,
        status: "blocked",
        decision: result.decision,
        reason: result.reason,
        metadata: result.metadata,
      },
    };
  }

  if (result.outcome === "approval") {
    return {
      content: [
        {
          type: "text",
          text:
            `${result.description} This plugin-owned tool did not mutate the target. ` +
            "Use human approval policy outside this tool or record compatible evidence and retry.",
        },
      ],
      details: {
        ok: false,
        status: "approval_required",
        decision: result.decision,
        reason: result.reason,
        metadata: result.metadata,
      },
    };
  }

  return null;
}

function executePolicyWriteFile(rawPayload, options = {}) {
  const payload = normalizePolicyWritePayload(rawPayload);
  if (!payload.path) {
    return {
      content: [{ type: "text", text: "policy_write_file requires a non-empty path." }],
      details: { ok: false, status: "invalid_request", reason: "missing_path" },
    };
  }

  const context = resolvePolicyToolContext(payload, options.context);
  const event = buildPolicyWriteEvent(payload, context, options.toolCallId);
  const result = evaluatePolicy(event, options.policies, context);

  appendAudit(options.auditLogPath ?? DEFAULT_AUDIT_LOG, event, {
    ...result.metadata,
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    mode: options.mode ?? "enforce",
    outcome: result.outcome,
    executionSurface: POLICY_WRITE_FILE_TOOL_NAME,
  });

  if (options.mode === "audit") {
    fs.mkdirSync(path.dirname(payload.path), { recursive: true });
    fs.writeFileSync(payload.path, payload.content);
    return {
      content: [{ type: "text", text: `Policy audit mode wrote ${payload.content.length} bytes to ${payload.path}.` }],
      details: { ok: true, status: "written", auditOnly: true, path: payload.path, bytes: payload.content.length },
    };
  }

  const blockedOrApproval = buildPolicyDecisionToolResult(result);
  if (blockedOrApproval) return blockedOrApproval;

  fs.mkdirSync(path.dirname(payload.path), { recursive: true });
  fs.writeFileSync(payload.path, payload.content);
  return {
    content: [{ type: "text", text: `Policy write completed: ${payload.content.length} bytes to ${payload.path}.` }],
    details: {
      ok: true,
      status: "written",
      decision: result.decision,
      reason: result.reason,
      path: payload.path,
      bytes: payload.content.length,
      metadata: result.metadata,
    },
  };
}

export {
  EvidenceLedger,
  evaluatePolicy,
  executePolicyWriteFile,
  getEvidenceLedger,
  loadPolicies,
  resolveConfig,
};

export default definePluginEntry({
  id: "policy-engine",
  name: "Policy Engine",
  description: "Guards state-changing tool calls with policy-driven evidence and approval checks.",
  register(api) {
    let pluginConfig = resolveConfig(api.pluginConfig);
    let policies = loadPolicies(pluginConfig.policiesDir);

    api.registerTool?.({
      name: RECORD_EVIDENCE_TOOL_NAME,
      label: "Preflight Record Evidence",
      description:
        "Synchronously record consulted evidence in the policy ledger before a guarded mutation. Use after a real read/search and before write/edit/apply_patch/exec/gateway changes.",
      promptSnippet: "Record evidence before a guarded mutation",
      promptGuidelines: [
        `Use ${RECORD_EVIDENCE_TOOL_NAME} after you inspect or search and before you mutate files, config, or infrastructure.`,
        "Summarize what source you consulted and how it supports the pending change.",
      ],
      parameters: RECORD_EVIDENCE_TOOL_SCHEMA,
      prepareArguments(args) {
        const payload = args && typeof args === "object" ? args : {};
        return {
          source_type: normalizeOptionalText(payload.source_type ?? payload.sourceType, ""),
          source_ref: normalizeOptionalText(payload.source_ref ?? payload.sourceRef, ""),
          query_or_path: normalizeOptionalText(payload.query_or_path ?? payload.queryOrPath, ""),
          summary: normalizeOptionalText(payload.summary, ""),
          supports_claim: normalizeOptionalText(payload.supports_claim ?? payload.supportsClaim, ""),
          run_id: normalizeOptionalText(payload.run_id ?? payload.runId, ""),
          session_id: normalizeOptionalText(payload.session_id ?? payload.sessionId, ""),
          session_key: normalizeOptionalText(payload.session_key ?? payload.sessionKey, ""),
        };
      },
      executionMode: "sequential",
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Operation aborted");

        const evidence = recordEvidencePayload(params, {
          sessionId: ctx?.sessionManager?.getSessionId?.(),
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Evidence recorded in policy ledger: ${evidence.sourceType} -> ${evidence.sourceRef}. ` +
                `Use a compatible preflight_claim in the next guarded mutation.`,
            },
          ],
          details: {
            ok: true,
            recorded: true,
            evidenceId: evidence.id,
            runId: evidence.runId,
            sessionId: evidence.sessionId,
            sessionKey: evidence.sessionKey,
          },
        };
      },
    });

    api.registerTool?.({
      name: POLICY_WRITE_FILE_TOOL_NAME,
      label: "Policy Write File",
      description:
        "Write a file only after Policy Engine verifies recorded evidence, preflight claim completeness, and hard-block rules. Use this instead of the built-in write tool for governed mutations.",
      promptSnippet: "Governed file write with recorded evidence",
      promptGuidelines: [
        `Use ${RECORD_EVIDENCE_TOOL_NAME} before ${POLICY_WRITE_FILE_TOOL_NAME}.`,
        "Do not use the built-in write tool for governed file mutations when this tool is available.",
      ],
      parameters: POLICY_WRITE_FILE_TOOL_SCHEMA,
      prepareArguments(args) {
        return normalizePolicyWritePayload(args);
      },
      executionMode: "sequential",
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Operation aborted");
        return executePolicyWriteFile(params, {
          policies,
          auditLogPath: pluginConfig.auditLogPath,
          mode: pluginConfig.mode,
          toolCallId,
          context: {
            agentId: ctx?.agentId,
            runId: ctx?.runId,
            sessionId: ctx?.sessionId ?? ctx?.sessionManager?.getSessionId?.(),
            sessionKey: ctx?.sessionKey,
          },
        });
      },
    });

    api.registerHook(
      "before_tool_call",
      async (event, ctx) => {
        pluginConfig = resolveConfig(api.pluginConfig);
        policies = loadPolicies(pluginConfig.policiesDir);
        if (!pluginConfig.enabled || pluginConfig.mode === "disabled") return {};
        if (
          pluginConfig.onlyAgents.length > 0 &&
          !pluginConfig.onlyAgents.includes(String(ctx?.agentId ?? ""))
        ) {
          return {};
        }

        const result = evaluatePolicy(event, policies, ctx);
        appendAudit(pluginConfig.auditLogPath, event, {
          ...result.metadata,
          agentId: ctx?.agentId,
          sessionId: ctx?.sessionId,
          sessionKey: ctx?.sessionKey,
          mode: pluginConfig.mode,
          outcome: result.outcome,
        });

        if (pluginConfig.mode === "audit") {
          return {};
        }

        if (result.outcome === "block") {
          return {
            block: true,
            blockReason: result.blockReason,
          };
        }

        if (result.outcome === "approval") {
          return {
            requireApproval: {
              title: "Policy Engine approval required",
              description:
                `${result.description} ` +
                `Risk=${result.metadata.risk}; target=${result.metadata.targetClass}; env=${result.metadata.environment}. ` +
                `Consult: ${(result.metadata.recommendedSources ?? []).join(", ") || "internal docs"}.`,
              severity: result.metadata.risk === "critical" ? "critical" : "warning",
              timeoutMs: pluginConfig.approvalTimeoutMs,
              timeoutBehavior: pluginConfig.approvalTimeoutBehavior,
              allowedDecisions: ["allow-once", "deny"],
              pluginId: "policy-engine",
            },
          };
        }

        return {};
      },
      { name: "policy-engine-preflight", priority: 150 },
    );

    api.registerGatewayMethod?.(RECORD_EVIDENCE_GATEWAY_METHOD, async ({ params, respond }) => {
      try {
        const evidence = recordEvidencePayload(params);

        respond(true, {
          ok: true,
          recorded: true,
          evidenceId: evidence.id,
          runId: evidence.runId,
          sessionId: evidence.sessionId,
          sessionKey: evidence.sessionKey,
          message: `Evidence recorded: ${evidence.sourceType} -> ${evidence.sourceRef}`,
        });
      } catch (error) {
        respond(false, {
          ok: false,
          error: String(error),
        });
      }
    });

    api.registerGatewayMethod?.("policy_engine.evidence_list", async ({ params, respond }) => {
      try {
        const payload = params && typeof params === "object" ? params : {};
        const runId = payload.run_id ?? payload.runId;
        const sessionId = payload.session_id ?? payload.sessionId;
        const sessionKey = payload.session_key ?? payload.sessionKey;
        const lookup = getEvidenceLedger().findRecords({
          runId,
          sessionId,
          sessionKey,
        });
        respond(true, {
          ok: true,
          runId: runId ?? null,
          sessionId: sessionId ?? null,
          sessionKey: sessionKey ?? null,
          lookupScope: lookup.scope,
          lookupKey: lookup.key,
          recordCount: lookup.records.length,
          records: lookup.records,
        });
      } catch (error) {
        respond(false, {
          ok: false,
          error: String(error),
        });
      }
    });

    api.registerGatewayMethod?.(POLICY_WRITE_FILE_GATEWAY_METHOD, async ({ params, respond }) => {
      try {
        pluginConfig = resolveConfig(api.pluginConfig);
        policies = loadPolicies(pluginConfig.policiesDir);
        const result = executePolicyWriteFile(params, {
          policies,
          auditLogPath: pluginConfig.auditLogPath,
          mode: pluginConfig.mode,
          context: {
            runId: params?.run_id ?? params?.runId,
            sessionId: params?.session_id ?? params?.sessionId,
            sessionKey: params?.session_key ?? params?.sessionKey,
          },
        });
        respond(result.details?.ok === true, result);
      } catch (error) {
        respond(false, {
          ok: false,
          error: String(error),
        });
      }
    });

    api.registerGatewayMethod?.("policy_engine.status", ({ respond }) => {
      respond(true, {
        ok: true,
        plugin: "policy-engine",
        version: "0.2.4",
        mode: pluginConfig.mode,
        enabled: pluginConfig.enabled,
        onlyAgents: pluginConfig.onlyAgents,
        ledger: "active",
        evidenceTool: RECORD_EVIDENCE_TOOL_NAME,
        evidenceGatewayMethod: RECORD_EVIDENCE_GATEWAY_METHOD,
        policyWriteTool: POLICY_WRITE_FILE_TOOL_NAME,
        policyWriteGatewayMethod: POLICY_WRITE_FILE_GATEWAY_METHOD,
        runtimeEntrypoint: "index.mjs",
      });
    });

    api.registerReload?.({
      noopPrefixes: ["plugins.entries.policy-engine"],
      onConfigChange(next) {
        pluginConfig = resolveConfig(next);
        policies = loadPolicies(pluginConfig.policiesDir);
      },
    });
  },
});
