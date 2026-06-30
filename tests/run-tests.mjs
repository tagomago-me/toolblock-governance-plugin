import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import plugin, { evaluatePolicy, getEvidenceLedger, loadPolicies, resolveConfig } from "../index.mjs";

const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const policies = loadPolicies(path.join(pluginRoot, "policies"));
const pending = [];

function test(name, fn) {
  const run = Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      console.error(`FAIL ${name}`);
      throw error;
    });
  pending.push(run);
}

test("registers before_tool_call hook", () => {
  const hooks = [];
  plugin.register({
    pluginConfig: {},
    registerHook(name, handler, options) {
      hooks.push({ name, handler, options });
    },
    registerGatewayMethod() {},
    registerReload() {},
  });

  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].name, "before_tool_call");
  assert.equal(hooks[0].options.priority, 150);
});


test("registers gateway methods and records evidence through runtime entrypoint", async () => {
  const gatewayMethods = new Map();
  plugin.register({
    pluginConfig: {},
    registerHook() {},
    registerGatewayMethod(name, handler) {
      gatewayMethods.set(name, handler);
    },
    registerReload() {},
  });

  assert.ok(gatewayMethods.has("preflight.record_evidence"));
  assert.ok(gatewayMethods.has("policy_engine.status"));
  assert.ok(gatewayMethods.has("policy_engine.evidence_list"));

  let recordResponse;
  await gatewayMethods.get("preflight.record_evidence")({
    params: {
      run_id: "gateway-method-run",
      session_id: "gateway-session",
      source_type: "read",
      source_ref: "file:/test/source.md",
      query_or_path: "/test/target.md",
      summary: "Read source before write",
      supports_claim: "Target follows source contract",
    },
    respond(ok, payload) {
      recordResponse = { ok, payload };
    },
  });

  assert.equal(recordResponse.ok, true);
  assert.equal(recordResponse.payload.recorded, true);
  assert.equal(recordResponse.payload.runId, "gateway-method-run");
  assert.ok(recordResponse.payload.evidenceId);

  let listResponse;
  await gatewayMethods.get("policy_engine.evidence_list")({
    params: { run_id: "gateway-method-run" },
    respond(ok, payload) {
      listResponse = { ok, payload };
    },
  });

  assert.equal(listResponse.ok, true);
  assert.ok(Array.isArray(listResponse.payload.records));
  assert.ok(listResponse.payload.records.some((record) => record.runId === "gateway-method-run"));

  let statusResponse;
  await gatewayMethods.get("policy_engine.status")({
    respond(ok, payload) {
      statusResponse = { ok, payload };
    },
  });

  assert.equal(statusResponse.ok, true);
  assert.equal(statusResponse.payload.version, "0.2.1");
  assert.equal(statusResponse.payload.runtimeEntrypoint, "index.mjs");
});

test("resolveConfig defaults mode to enforce", () => {
  const config = resolveConfig({});
  assert.equal(config.mode, "enforce");
});

test("resolveConfig maps enabled=false to disabled mode", () => {
  const config = resolveConfig({ enabled: false });
  assert.equal(config.mode, "disabled");
});

test("audit mode logs findings but does not require approval", async () => {
  const hooks = [];
  plugin.register({
    pluginConfig: { mode: "audit" },
    registerHook(name, handler, options) {
      hooks.push({ name, handler, options });
    },
    registerGatewayMethod() {},
    registerReload() {},
  });

  const result = await hooks[0].handler(
    {
      toolName: "write",
      runId: "audit-mode-empty-ledger",
      derivedPaths: ["/test/audit.md"],
      params: { path: "/test/audit.md", content: "x" },
    },
    { agentId: "peter", sessionKey: "test" },
  );

  assert.deepEqual(result, {});
});

test("disabled mode bypasses guarded enforcement", async () => {
  const hooks = [];
  plugin.register({
    pluginConfig: { mode: "disabled" },
    registerHook(name, handler, options) {
      hooks.push({ name, handler, options });
    },
    registerGatewayMethod() {},
    registerReload() {},
  });

  const result = await hooks[0].handler(
    {
      toolName: "write",
      runId: "disabled-mode-empty-ledger",
      derivedPaths: ["/test/disabled.md"],
      params: { path: "/test/disabled.md", content: "x" },
    },
    { agentId: "peter", sessionKey: "test" },
  );

  assert.deepEqual(result, {});
});

test("read-only exec is bypassed", () => {
  const result = evaluatePolicy(
    {
      toolName: "exec",
      params: { cmd: "rg policy-engine /tmp/project" },
      derivedPaths: ["/tmp/project"],
    },
    policies,
  );

  assert.equal(result.outcome, "pass");
  assert.equal(result.metadata.guarded, false);
  assert.equal(result.metadata.readOnlyBypass, true);
});

test("write without evidence requires approval", () => {
  const result = evaluatePolicy(
    {
      toolName: "write",
      params: { path: "/tmp/output.md", content: "# hi" },
      derivedPaths: ["/tmp/output.md"],
    },
    policies,
  );

  assert.equal(result.outcome, "approval");
  assert.equal(result.decision, "require_approval");
  assert.equal(result.reason, "missing_recorded_evidence");
  assert.equal(result.metadata.hasRecordedEvidence, false);
});

test("guarded write with complete claim and empty ledger requires approval", () => {
  const result = evaluatePolicy(
    {
      toolName: "write",
      params: {
        path: "/tmp/output.md",
        content: "# hi",
        preflight_claim: {
          skill_used: "plugin-creator",
          source_route: "internal_openclaw_docs",
          plane_ticket: "OS-123",
          evidence_ref: ["doc:1", "doc:2"],
          action_type: "write",
          risk: "low",
          rollback: "delete /tmp/output.md",
          target_file: "/tmp/output.md",
          user_request: "create temp note",
        },
      },
      runId: "regression-empty-ledger",
      derivedPaths: ["/tmp/output.md"],
    },
    policies,
  );

  assert.equal(result.outcome, "approval");
  assert.equal(result.decision, "require_approval");
  assert.equal(result.reason, "missing_recorded_evidence");
  assert.equal(result.metadata.hasRecordedEvidence, false);
});

test("write with complete low-risk claim and compatible ledger passes", () => {
  const runId = "write-pass-with-ledger";
  const ledger = getEvidenceLedger();
  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "test-session",
    sourceType: "read",
    sourceRef: "file:/tmp/input.md",
    queryOrPath: "/tmp/output.md",
    summary: "Read source before write",
    supportsClaim: "Output derived from validated source",
  });

  const result = evaluatePolicy(
    {
      toolName: "write",
      params: {
        path: "/tmp/output.md",
        content: "# hi",
        preflight_claim: {
          skill_used: "plugin-creator",
          source_route: "internal_openclaw_docs",
          plane_ticket: "OS-123",
          evidence_ref: ["file:/tmp/input.md"],
          action_type: "write",
          risk: "low",
          rollback: "delete /tmp/output.md",
          target_file: "/tmp/output.md",
          user_request: "create temp note",
        },
      },
      runId,
      derivedPaths: ["/tmp/output.md"],
    },
    policies,
  );

  assert.equal(result.outcome, "pass");
  assert.equal(result.decision, "pass");
  assert.equal(result.reason, "verified_recorded_evidence");
  assert.equal(result.metadata.environment, "test");
  assert.equal(result.metadata.hasRecordedEvidence, true);
});

test(".tex prose edit with plane_ticket present does not become plane_change", () => {
  const runId = "tex-prose-edit-low-risk";
  const ledger = getEvidenceLedger();
  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "test-session",
    sourceType: "read",
    sourceRef: "file:/test/doc/source-notes.md",
    queryOrPath: "/test/doc/article.tex",
    summary: "Reviewed article source",
    supportsClaim: "Safe prose-only removal",
  });

  const result = evaluatePolicy(
    {
      toolName: "edit",
      params: {
        path: "/test/doc/article.tex",
        edits: [{ oldText: "obsolete phrase", newText: "" }],
        preflight_claim: {
          skill_used: "latex-authoring",
          source_route: "internal_openclaw_docs",
          plane_ticket: "OS-456",
          evidence_ref: ["file:/test/doc/source-notes.md"],
          action_type: "edit",
          target_kind: "prose_content",
          risk: "low",
          rollback: "restore removed phrase",
          target_file: "/test/doc/article.tex",
          user_request: "remove one phrase",
        },
      },
      runId,
      derivedPaths: ["/test/doc/article.tex"],
    },
    policies,
  );

  assert.equal(result.decision, "pass");
  assert.equal(result.metadata.targetClass, "prose_content");
  assert.notEqual(result.metadata.targetClass, "plane_change");
  assert.equal(result.metadata.risk, "low");
  assert.ok(!result.metadata.missingFields.includes("impact_note"));
});

test("guarded write with irrelevant ledger returns evidence_claim_mismatch", () => {
  const runId = "write-irrelevant-ledger";
  const ledger = getEvidenceLedger();
  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "test-session",
    sourceType: "read",
    sourceRef: "plane:OS-999",
    queryOrPath: "/test/file-b.md",
    summary: "Evidence for unrelated file",
    supportsClaim: "Unrelated support",
  });

  const result = evaluatePolicy(
    {
      toolName: "write",
      params: {
        path: "/test/file-a.md",
        content: "# file A",
        preflight_claim: {
          skill_used: "plugin-creator",
          source_route: "internal_openclaw_docs",
          plane_ticket: "OS-123",
          evidence_ref: ["plane:OS-123"],
          action_type: "write",
          risk: "low",
          rollback: "delete /test/file-a.md",
          target_file: "/test/file-a.md",
          user_request: "write file A",
        },
      },
      runId,
      derivedPaths: ["/test/file-a.md"],
    },
    policies,
  );

  assert.equal(result.outcome, "approval");
  assert.equal(result.decision, "require_approval");
  assert.equal(result.reason, "evidence_claim_mismatch");
  assert.equal(result.metadata.hasRecordedEvidence, true);
  assert.equal(result.metadata.evidence_claim_match, false);
});

test("destructive production exec without rollback hard-blocks", () => {
  const result = evaluatePolicy(
    {
      toolName: "exec",
      params: {
        cmd: "rm -rf /home/ubuntu/.openclaw/local-plugins/demo",
        preflight_claim: {
          skill_used: "manual",
          source_route: "internal_openclaw_docs",
          plane_ticket: "OS-999",
          evidence_ref: ["doc:1"],
          action_type: "delete",
          risk: "critical",
        },
      },
      derivedPaths: ["/home/ubuntu/.openclaw/local-plugins/demo"],
    },
    policies,
  );

  assert.equal(result.outcome, "block");
  assert.match(result.blockReason, /hard block/i);
});

test("plane done without completion bundle requires approval", () => {
  const result = evaluatePolicy(
    {
      toolName: "exec",
      params: {
        cmd: "python3 ~/.openclaw/scripts/plane.py state ISSUE-1 Done project-uuid os",
        preflight_claim: {
          skill_used: "plane-skill",
          source_route: "plane_tickets_relevant_workspace",
          plane_ticket: "ISSUE-1",
          evidence_ref: ["plane:ISSUE-1", "log:1"],
          action_type: "update_status_done",
          risk: "high",
          rollback: "move state back",
          skill_or_procedure: "plane-skill",
          evidence_refs: ["plane:ISSUE-1", "log:1"],
          parent_contract: "AGENTS.md",
          impact_above: "none",
          impact_lateral: "ticket state only",
          validation_plan: "read issue again",
        },
      },
      derivedPaths: [],
    },
    policies,
  );

  assert.equal(result.outcome, "approval");
  assert.ok(result.metadata.missingFields.includes("resolution_summary"));
});

await Promise.all(pending);
console.log(`Policy Engine tests passed on ${os.hostname()}`);
