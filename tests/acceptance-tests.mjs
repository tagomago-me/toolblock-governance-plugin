import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { evaluatePolicy, executePolicyWriteFile, loadPolicies, getEvidenceLedger } from "../index.mjs";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "policy-acceptance-"));
const PLUGIN_DIR = path.join(TMP_DIR, "plugin");
fs.mkdirSync(path.join(PLUGIN_DIR, "policies"), { recursive: true });

const srcPolicies = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "policies");
for (const file of fs.readdirSync(srcPolicies)) {
  fs.copyFileSync(path.join(srcPolicies, file), path.join(PLUGIN_DIR, "policies", file));
}

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    throw error;
  }
}

function cleanup() {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {}
}

const policies = loadPolicies(path.join(PLUGIN_DIR, "policies"));

// ============================================================================
// ACCEPTANCE CRITERIA FROM TASK
// ============================================================================

test("AC1: read/search + preflight.record_evidence + write passes", () => {
  const runId = "ac1-flow";
  const ledger = getEvidenceLedger();

  // Record evidence
  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "ac1-session",
    sourceType: "read",
    sourceRef: "file:/test/input.txt",
    queryOrPath: "/test/output.txt",
    summary: "Read input file",
    supportsClaim: "Output matches schema",
  });

  const result = evaluatePolicy(
    {
      toolName: "write",
      params: {
        path: "/test/output.txt",
        content: "Data",
        preflight_claim: {
          target_file: "/test/output.txt",
          user_request: "Generate output",
          skill_used: "test-skill",
          source_route: "internal",
          plane_ticket: "TEST-AC1",
          evidence_ref: ["file:input"],
          action_type: "write",
          risk: "low",
          rollback: "delete",
          impact_note: "Output file",
        },
      },
      derivedPaths: ["/test/output.txt"],
      runId,
    },
    policies,
  );

  assert.equal(result.decision, "pass");
  assert.equal(result.metadata.hasRecordedEvidence, true);
});

test("AC2: write without evidence requires approval", () => {
  const runId = "ac2-flow";

  const result = evaluatePolicy(
    {
      toolName: "write",
      params: {
        path: "/test/no-evidence.txt",
        content: "Data",
      },
      derivedPaths: ["/test/no-evidence.txt"],
      runId,
    },
    policies,
  );

  assert.ok(result.decision === "block" || result.decision === "require_approval");
  assert.equal(result.metadata.hasRecordedEvidence, false);
});

test("AC2b: policy_write_file without evidence does not mutate", () => {
  const runId = `ac2b-flow-${Date.now()}`;
  const targetPath = path.join(TMP_DIR, "ac2b-no-evidence.txt");

  const result = executePolicyWriteFile(
    {
      path: targetPath,
      content: "must not be written",
      run_id: runId,
      preflight_claim: {
        target_file: targetPath,
        user_request: "Negative policy write test",
        skill_used: "test-skill",
        source_route: "internal",
        plane_ticket: "TEST-AC2B",
        evidence_ref: ["missing-ledger"],
        action_type: "write",
        risk: "low",
        rollback: "delete file",
        impact_note: "test artifact",
      },
    },
    {
      policies,
      auditLogPath: path.join(TMP_DIR, "policy-write-ac2b.jsonl"),
      mode: "enforce",
      context: { runId },
    },
  );

  assert.equal(result.details.status, "approval_required");
  assert.equal(fs.existsSync(targetPath), false);
});

test("AC2c: policy_write_file with compatible evidence mutates", () => {
  const runId = `ac2c-flow-${Date.now()}`;
  const targetPath = path.join(TMP_DIR, "ac2c-with-evidence.txt");
  const ledger = getEvidenceLedger();

  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "ac2c-session",
    sourceType: "read",
    sourceRef: `file:${targetPath}`,
    queryOrPath: targetPath,
    summary: "Reviewed target write requirements",
    supportsClaim: "The policy write test content is allowed",
  });

  const result = executePolicyWriteFile(
    {
      path: targetPath,
      content: "policy write ok",
      run_id: runId,
      preflight_claim: {
        target_file: targetPath,
        user_request: "Positive policy write test",
        skill_used: "test-skill",
        source_route: "internal",
        plane_ticket: "TEST-AC2C",
        evidence_ref: [`file:${targetPath}`],
        action_type: "write",
        risk: "low",
        rollback: "delete file",
        impact_note: "test artifact",
      },
    },
    {
      policies,
      auditLogPath: path.join(TMP_DIR, "policy-write-ac2c.jsonl"),
      mode: "enforce",
      context: { runId },
    },
  );

  assert.equal(result.details.status, "written");
  assert.equal(fs.readFileSync(targetPath, "utf8"), "policy write ok");
});

test("AC2d: policy_write_file falls back to target-path evidence when session identity is unavailable", () => {
  const evidenceRunId = `ac2d-evidence-${Date.now()}`;
  const targetPath = path.join(TMP_DIR, "ac2d-target-fallback.txt");
  const ledger = getEvidenceLedger();

  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId: evidenceRunId,
    sessionId: "unknown",
    sessionKey: "unknown",
    sourceType: "read",
    sourceRef: `file:${targetPath}`,
    queryOrPath: targetPath,
    summary: "Reviewed target write requirements without usable hosted session identity",
    supportsClaim: "The policy write target is explicitly supported",
  });

  const result = executePolicyWriteFile(
    {
      path: targetPath,
      content: "target fallback ok",
      preflight_claim: {
        target_file: targetPath,
        user_request: "Positive policy write target fallback test",
        skill_used: "test-skill",
        source_route: "internal",
        plane_ticket: "TEST-AC2D",
        evidence_ref: [`file:${targetPath}`],
        action_type: "write",
        risk: "low",
        rollback: "delete file",
        impact_note: "test artifact",
      },
    },
    {
      policies,
      auditLogPath: path.join(TMP_DIR, "policy-write-ac2d.jsonl"),
      mode: "enforce",
      context: {},
    },
  );

  assert.equal(result.details.status, "written");
  assert.equal(result.details.metadata.evidenceLookupScope, "targetPath");
  assert.equal(fs.readFileSync(targetPath, "utf8"), "target fallback ok");
});

test("AC3: production delete requires approval", () => {
  const runId = "ac3-flow";

  const result = evaluatePolicy(
    {
      toolName: "exec",
      params: {
        command: "rm -rf /home/ubuntu/important",
      },
      derivedPaths: ["/home/ubuntu/important"],
      runId,
    },
    policies,
  );

  assert.ok(result.decision === "block" || result.decision === "require_approval");
  assert.equal(result.metadata.environment, "production");
});

test("AC4: high-risk with evidence passes", () => {
  const runId = "ac4-flow";
  const ledger = getEvidenceLedger();

  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "ac4-session",
    sourceType: "search",
    sourceRef: "udl:agents_schema",
    queryOrPath: "/test/AGENTS.md",
    summary: "Searched for schema",
    supportsClaim: "Update valid",
  });

  const result = evaluatePolicy(
    {
      toolName: "edit",
      params: {
        path: "/test/AGENTS.md",
        edits: [{ oldText: "old", newText: "new" }],
        preflight_claim: {
          skill_used: "test-skill",
          source_route: "udl",
          plane_ticket: "TEST-AC4",
          evidence_ref: ["search:udl"],
          action_type: "edit",
          risk: "medium",
          rollback: "git checkout",
          skill_or_procedure: "test-skill",
          evidence_refs: ["search:udl", "read:doc"],
          parent_contract: "SOUL.md",
          impact_above: "agents coordinate",
          impact_lateral: "scheduling",
          validation_plan: "run tests",
          impact_note: "AGENTS.md change",
        },
      },
      derivedPaths: ["/test/AGENTS.md"],
      runId,
    },
    policies,
  );

  assert.equal(result.decision, "pass");
  assert.equal(result.metadata.hasRecordedEvidence, true);
});

test("Ledger persists evidence across operations", () => {
  const runId = "persist-flow";
  const ledger = getEvidenceLedger();

  for (let i = 0; i < 3; i++) {
    ledger.record({
      id: "",
      timestamp: new Date().toISOString(),
      runId,
      sessionId: `s${i}`,
      sourceType: "read",
      sourceRef: `f${i}`,
      queryOrPath: `/t${i}`,
      summary: `E${i}`,
      supportsClaim: "y",
    });
  }

  const records = ledger.getRecordsForRun(runId);
  assert.ok(records.length >= 3);
});

test("Ledger metadata reflects evidence status", () => {
  const runId = `meta-flow-${Date.now()}`;
  const ledger = getEvidenceLedger();

  let result = evaluatePolicy(
    {
      toolName: "write",
      params: { path: "/test/f.txt", content: "x" },
      derivedPaths: ["/test/f.txt"],
      runId,
    },
    policies,
  );
  assert.equal(result.metadata.hasRecordedEvidence, false);

  ledger.record({
    id: "",
    timestamp: new Date().toISOString(),
    runId,
    sessionId: "s",
    sourceType: "read",
    sourceRef: "f",
    queryOrPath: "/test/f.txt",
    summary: "R",
    supportsClaim: "y",
  });

  result = evaluatePolicy(
    {
      toolName: "write",
      params: { path: "/test/f.txt", content: "x" },
      derivedPaths: ["/test/f.txt"],
      runId,
    },
    policies,
  );
  assert.equal(result.metadata.hasRecordedEvidence, true);
});

console.log("\n✅ ALL ACCEPTANCE CRITERIA PASSED\n");
cleanup();
