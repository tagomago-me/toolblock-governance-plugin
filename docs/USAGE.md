# Usage

## Operational model

The plugin does not magically observe trustworthy prior reads and searches yet.

The current operational pattern is explicit:

1. perform the research or inspection
2. record it with `preflight_record_evidence`
3. perform the guarded mutation with a compatible `preflight_claim`

If you are driving the runtime directly through the Gateway instead of an agent tool loop, the control-plane equivalent is `preflight.record_evidence`.

## Agent scoping

If you want the plugin active only for `main`, configure:

```json
{
  "onlyAgents": ["main"]
}
```

When `onlyAgents` is empty or omitted, the plugin applies to all agents.

## Example flow

### Step 1: inspect or search

Use your normal read-only tools first.

### Step 2: record evidence in an agent turn

Call the agent tool:

```javascript
await preflight_record_evidence({
  source_type: "read",
  source_ref: "file:/workspace/source.md",
  query_or_path: "/workspace/target.md",
  summary: "Reviewed the governing source before mutating the target",
  supports_claim: "The target change follows the consulted source",
});
```

The tool writes synchronously to the evidence ledger and automatically falls back to the active session identity when a direct `runId` is not available on the tool surface.

### Step 2b: record evidence through the Gateway

If you are validating or operating directly against gateway methods, call:

```javascript
await gateway.call("preflight.record_evidence", {
  run_id: context.runId,
  session_id: context.sessionId,
  source_type: "read",
  source_ref: "file:/workspace/source.md",
  query_or_path: "/workspace/target.md",
  summary: "Reviewed the governing source before mutating the target",
  supports_claim: "The target change follows the consulted source",
});
```

### Step 3: perform guarded mutation

Then run the guarded tool with a compatible `preflight_claim`.

Example shape:

```javascript
await write({
  path: "/workspace/target.md",
  content: "new content",
  preflight_claim: {
    target_file: "/workspace/target.md",
    user_request: "Update the target file",
    skill_used: "policy-aware-editor",
    source_route: "internal_docs",
    plane_ticket: "OS-123",
    evidence_ref: ["file:source-md"],
    action_type: "write",
    risk: "low",
    rollback: "restore previous file contents",
  },
});
```

## Outcomes

### Pass

The plugin allows execution when:

- the tool is guarded
- evidence exists in the ledger for the run or active session
- the evidence is compatible with the claim
- required fields are present
- no hard block is triggered

### Require approval

The plugin requires human approval when:

- evidence is missing
- the claim is incomplete
- evidence and claim do not match

Important detail:

- a complete claim without recorded evidence still requires approval
- the recommended agent-side fix is `preflight_record_evidence`

### Block

The plugin blocks when a hard policy rule is hit, such as destructive production action without rollback.

## Read-only behavior

Read-only operations should remain cheap and normally bypass the guard.

Example:

```bash
rg policy-engine /tmp/project
```

## Inspection helpers

You can inspect runtime state with:

- `policy_engine.status`
- `policy_engine.evidence_list`