# Policy Engine Parts Map

This file gives stable names to the parts of the system so the project is easier to reason about.

## 1. Runtime Guard

What it is:

- the `before_tool_call` hook

What it does:

- intercepts guarded mutations before execution
- decides whether the call passes, requires approval, or is blocked

## 2. Evidence Recorder

What it is:

- the `preflight.record_evidence` gateway method

What it does:

- records explicit evidence for the current run

## 3. Evidence Ledger

What it is:

- the local JSONL-backed evidence store

What it does:

- stores evidence synchronously
- makes evidence available during policy evaluation

## 4. Policy Evaluator

What it is:

- the decision logic in `evaluatePolicy`

What it does:

- computes risk
- checks claim completeness
- checks evidence compatibility
- emits `pass`, `require_approval`, or `block`

## 5. Policy Bundle

What it is:

- the set of YAML policy files under `policies/`

What it does:

- defines rules for preflight, risk, evidence, routing, placement, lifecycle, and completion

## 6. Status Surface

What it is:

- `policy_engine.status`

What it does:

- exposes runtime mode, version, and entrypoint information

## 7. Evidence Inspector

What it is:

- `policy_engine.evidence_list`

What it does:

- shows recorded evidence for a given run

## 8. Approval Contract

What it is:

- the runtime response returned when mutation should not proceed automatically

What it does:

- pauses execution
- requires human approval
- communicates why the action is not auto-approved

## 9. Hard-Block Rules

What it is:

- the subset of policy that must never auto-pass

What it does:

- blocks destructive production actions without rollback

## 10. Canonical Runtime File

What it is:

- `index.mjs`

Why it matters:

- this is the file docs, tests, and runtime behavior must all agree on

## Mental model

```text
Read/Search
  -> Evidence Recorder
  -> Evidence Ledger
  -> Runtime Guard
  -> Policy Evaluator
  -> Pass / RequireApproval / Block
```