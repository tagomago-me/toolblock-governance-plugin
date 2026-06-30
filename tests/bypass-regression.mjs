#!/usr/bin/env node
/**
 * BYPASS BUG REGRESSION TEST - FINAL
 * 
 * Critical Issue FIXED:
 * guarded mutation with COMPLETE claim but NO recorded evidence
 * was incorrectly PASSING instead of requiring approval.
 * 
 * Root Cause (now fixed):
 * Old logic: if (!hasEvidence && missing.length > 0) { require_approval }
 * Problem: If claim is complete (missing.length === 0), it would PASS without evidence!
 *
 * New logic: if (!hasEvidence) { require_approval }  
 * This ensures ALL guarded tools require approval when evidence is absent,
 * regardless of claim completeness.
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Import the fixed plugin
import { evaluatePolicy, loadPolicies, getEvidenceLedger } from "../index.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const POLICIES_DIR = path.join(PLUGIN_DIR, "policies");

function test(name, fn) {
  try {
    fn();
    console.log(`✓ PASS ${name}`);
    return true;
  } catch (error) {
    console.error(`✗ FAIL ${name}`);
    console.error(`  Error: ${error.message}`);
    throw error;
  }
}

const policies = loadPolicies(POLICIES_DIR);

console.log("=".repeat(75));
console.log("BYPASS BUG REGRESSION TEST SUITE");
console.log("=".repeat(75));
console.log("");

let passCount = 0;
let failCount = 0;

// ============================================================================
// TEST 1: Write with COMPLETE low-risk claim but NO evidence => require_approval
// ============================================================================
try {
  test("TEST 1: write /test/file.txt - COMPLETE claim but NO ledger evidence", () => {
    const ctx = {
      toolName: "write",
      params: {
        path: "/test/file.txt",
        content: "test data",
        preflight_claim: {
          skill_used: "test-skill",
          source_route: "internal_test",
          plane_ticket: "TEST-001",
          evidence_ref: ["ref1"],
          action_type: "write",
          risk: "low",
          impact_note: "No significant impact",
          rollback: "delete /test/file.txt",
          target_file: "/test/file.txt",
          user_request: "Testing bypass fix",
        },
      },
      derivedPaths: ["/test/file.txt"],
      runId: "test-bypass-1",
      cwd: "/test",
      userId: "test-user",
    };

    const result = evaluatePolicy(ctx, policies);
    
    console.log(`    Claim fields: 10 present`);
    console.log(`    Decision: ${result.decision}`);
    console.log(`    Evidence in ledger: ${result.metadata.hasRecordedEvidence}`);
    console.log(`    Reason: ${result.reason.substring(0, 70)}...`);
    
    // CRITICAL: even though claim is complete, no evidence = require_approval
    assert.equal(
      result.decision,
      "require_approval",
      `BYPASS BUG: got ${result.decision} instead of require_approval`
    );
    
    assert.equal(result.metadata.hasRecordedEvidence, false);
    assert.ok(result.reason.includes("evidence"), "Reason must mention evidence requirement");
  });
  passCount++;
  console.log("    ✓ Bypass is FIXED: Complete claim insufficient without evidence\n");
} catch (e) {
  failCount++;
  console.error("\n    ❌ BYPASS NOT FIXED!\n");
}

// ============================================================================
// TEST 2: Edit with COMPLETE claim but NO evidence => require_approval
// ============================================================================
try {
  test("TEST 2: edit /test/config.yml - COMPLETE claim but NO ledger evidence", () => {
    const ctx = {
      toolName: "edit",
      params: {
        path: "/test/config.yml",
        oldText: "old",
        newText: "new",
        preflight_claim: {
          skill_used: "test-skill",
          source_route: "internal_test",
          plane_ticket: "TEST-002",
          evidence_ref: ["ref1"],
          action_type: "edit",
          risk: "low",
          impact_note: "No significant impact",
          rollback: "restore from backup",
          target_file: "/test/config.yml",
          user_request: "Config update",
        },
      },
      derivedPaths: ["/test/config.yml"],
      runId: "test-bypass-2",
      cwd: "/test",
      userId: "test-user",
    };

    const result = evaluatePolicy(ctx, policies);
    
    console.log(`    Claim fields: 10 present`);
    console.log(`    Decision: ${result.decision}`);
    console.log(`    Evidence in ledger: ${result.metadata.hasRecordedEvidence}`);
    
    assert.equal(result.decision, "require_approval");
    assert.equal(result.metadata.hasRecordedEvidence, false);
  });
  passCount++;
  console.log("    ✓ Edit tool also blocked from bypassing\n");
} catch (e) {
  failCount++;
}

// ============================================================================
// TEST 3: Exec destructive command with COMPLETE claim but NO evidence
// ============================================================================
try {
  test("TEST 3: exec rm -rf /test/data - COMPLETE claim but NO ledger evidence", () => {
    const ctx = {
      toolName: "exec",
      params: {
        command: "rm -rf /test/data",
        preflight_claim: {
          skill_used: "test-skill",
          source_route: "internal_test",
          plane_ticket: "TEST-003",
          evidence_ref: ["ref1"],
          action_type: "delete",
          risk: "medium",
          impact_note: "Test data cleanup",
          rollback: "restore from backup",
        },
      },
      derivedPaths: ["/test/data"],
      runId: "test-bypass-3",
      cwd: "/test",
      userId: "test-user",
    };

    const result = evaluatePolicy(ctx, policies);
    
    console.log(`    Claim fields: 8 present`);
    console.log(`    Decision: ${result.decision}`);
    console.log(`    Evidence in ledger: ${result.metadata.hasRecordedEvidence}`);
    
    assert.ok(
      result.decision === "require_approval" || result.decision === "block",
      `Expected require_approval/block but got ${result.decision}`
    );
    
    assert.equal(result.metadata.hasRecordedEvidence, false);
  });
  passCount++;
  console.log("    ✓ Destructive exec also blocked\n");
} catch (e) {
  failCount++;
}

// ============================================================================
// TEST 4: Error message explicitly tells user how to fix
// ============================================================================
try {
  test("TEST 4: Error message guides user to use preflight.record_evidence", () => {
    const ctx = {
      toolName: "write",
      params: {
        path: "/test/msg-test.txt",
        content: "test",
        preflight_claim: {
          skill_used: "test",
          source_route: "test",
          plane_ticket: "MSG-001",
          evidence_ref: ["ref"],
          action_type: "write",
          risk: "low",
          impact_note: "msg check",
          rollback: "undo",
          target_file: "/test/msg-test.txt",
          user_request: "msg check",
        },
      },
      derivedPaths: ["/test/msg-test.txt"],
      runId: "test-bypass-4",
      cwd: "/test",
      userId: "test-user",
    };

    const result = evaluatePolicy(ctx, policies);
    
    console.log(`    Reason: "${result.reason}"`);
    console.log(`    Description: "${result.description ?? ""}"`);
    
    assert.ok(
      (result.description ?? result.reason).includes("preflight.record_evidence"),
      `Error message must mention preflight.record_evidence API`
    );
  });
  passCount++;
  console.log("    ✓ User guidance is clear\n");
} catch (e) {
  failCount++;
}

// ============================================================================
// TEST 5: Verify the exact error message from the fix
// ============================================================================
try {
  test("TEST 5: Error message says 'Complete claim is insufficient'", () => {
    const ctx = {
      toolName: "write",
      params: {
        path: "/test/err-test.txt",
        content: "test",
        preflight_claim: {
          skill_used: "test",
          source_route: "test",
          plane_ticket: "ERR-001",
          evidence_ref: ["ref"],
          action_type: "write",
          risk: "low",
          impact_note: "err check",
          rollback: "undo",
          target_file: "/test/err-test.txt",
          user_request: "err check",
        },
      },
      derivedPaths: ["/test/err-test.txt"],
      runId: "test-bypass-5",
      cwd: "/test",
      userId: "test-user",
    };

    const result = evaluatePolicy(ctx, policies);
    
    console.log(`    Reason: "${result.reason}"`);
    console.log(`    Description: "${result.description ?? ""}"`);
    
    // The fix includes this exact message
    assert.ok(
      (result.description ?? result.reason).includes("Complete claim is insufficient"),
      `Message should explicitly state "Complete claim is insufficient"`
    );
  });
  passCount++;
  console.log("    ✓ Fix message is present\n");
} catch (e) {
  failCount++;
}

console.log("=".repeat(75));
console.log(`RESULTS: ${passCount} passed, ${failCount} failed`);
console.log("=".repeat(75));

if (failCount > 0) {
  console.error("\n❌ BYPASS NOT FULLY FIXED");
  process.exit(1);
} else {
  console.log("\n");
  console.log("✅ BYPASS BUG FIXED");
  console.log("✅ Guarded tools now require approval when evidence is absent");
  console.log("✅ Complete claim is no longer sufficient for bypass");
  console.log("✅ Acceptance criteria met");
  console.log("\n");
  process.exit(0);
}
