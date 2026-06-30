import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY_DIR = path.join(__dirname, "policies");
const DEFAULT_AUDIT_LOG = path.join(__dirname, "logs", "policy-engine.jsonl");
const DEFAULT_EVIDENCE_LEDGER = path.join(__dirname, "logs", "evidence-ledger.jsonl");

const DIRECT_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);
const EXEC_TOOLS = new Set(["bash", "exec", "exec_command", "shell"]);

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
      id: evidence?.id || `${evidence?.runId ?? "unknown"}:${evidence?.sourceRef ?? "unknown"}:${Date.now()}`,
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

function evaluateEvidenceCompatibility(event) {
  const claim = getClaim(event.params);
  const targetPaths = extractTargetPaths(event);
  const runId = event.runId ?? "unknown";
  const records = getEvidenceLedger().getRecordsForRun(runId);
  const claimEvidenceRefs = [
    ...asStringList(claim.evidence_refs),
    ...asStringList(claim.evidence_ref),
  ];

  if (!records.length) {
    return {
      hasRecordedEvidence: false,
      compatible: false,
      records,
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

function evaluatePolicy(event, policies) {
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
  const evidenceCheck = evaluateEvidenceCompatibility(event);
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
      description: "Missing recorded evidence in ledger for guarded action. Complete claim is insufficient. Run preflight.record_evidence before write/edit/exec/config/deploy.",
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

export { EvidenceLedger, evaluatePolicy, getEvidenceLedger, loadPolicies, resolveConfig };

export default definePluginEntry({
  id: "policy-engine",
  name: "Policy Engine",
  description: "Guards state-changing tool calls with policy-driven evidence and approval checks.",
  register(api) {
    let pluginConfig = resolveConfig(api.pluginConfig);
    let policies = loadPolicies(pluginConfig.policiesDir);

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

        const result = evaluatePolicy(event, policies);
        appendAudit(pluginConfig.auditLogPath, event, {
          ...result.metadata,
          agentId: ctx?.agentId,
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

    api.registerGatewayMethod?.("preflight.record_evidence", async ({ params, respond }) => {
      try {
        const payload = params && typeof params === "object" ? params : {};
        const evidence = getEvidenceLedger().record({
          id: "",
          timestamp: new Date().toISOString(),
          runId: payload.run_id ?? payload.runId ?? "unknown",
          sessionId: payload.session_id ?? payload.sessionId ?? "unknown",
          sourceType: payload.source_type ?? payload.sourceType ?? "unknown",
          sourceRef: payload.source_ref ?? payload.sourceRef ?? "unknown",
          queryOrPath: payload.query_or_path ?? payload.queryOrPath ?? "",
          summary: payload.summary ?? "",
          supportsClaim: payload.supports_claim ?? payload.supportsClaim ?? "",
        });

        respond(true, {
          ok: true,
          recorded: true,
          evidenceId: evidence.id,
          runId: evidence.runId,
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
        const runId = payload.run_id ?? payload.runId ?? "unknown";
        const records = getEvidenceLedger().getRecordsForRun(runId);
        respond(true, {
          ok: true,
          runId,
          recordCount: records.length,
          records,
        });
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
        version: "0.2.2",
        mode: pluginConfig.mode,
        enabled: pluginConfig.enabled,
        onlyAgents: pluginConfig.onlyAgents,
        ledger: "active",
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
