# Toolblock Governance Plugin Requirements

## Goal

Build a runtime governance layer for OpenClaw that enforces evidence-aware control over state-changing operations.

## Primary requirements

### R1. Guard state-changing operations

The system must intercept guarded tool calls before execution.

Examples:

- `write`
- `edit`
- `apply_patch`
- mutating `exec`
- config/deploy/infrastructure mutations

### R2. Never block read-only inspection by default

Read-only operations must remain cheap.

Examples:

- file reads
- searches
- read-only shell inspection
- status commands

### R3. Classify target and environment

Before deciding, the system must classify:

- target class
- environment (`test` or `production`)
- risk level

### R4. Use policy as data

Rules must live in YAML, not be hard-coded as workspace-specific behavior.

### R5. Require evidence before guarded mutation

If a guarded mutation is attempted without compatible recorded evidence, the system must require human approval.

This must remain true even when the `preflight_claim` is complete.

### R6. Preserve hard blocks

Destructive production actions without rollback must remain blocked.

### R7. Support explicit evidence registration

The runtime-exposed workflow must support:

1. read/search
2. `preflight.record_evidence`
3. guarded mutation with `preflight_claim`

### R8. Expose operational inspection methods

The runtime bundle must expose:

- `policy_engine.status`
- `policy_engine.evidence_list`

### R9. Keep implementation honest

The system must not claim native causal proof if the runtime does not provide it.

Current honest scope:

- verifies synchronous recorded evidence
- does not prove native causal telemetry of prior reads/searches

## Acceptance criteria

### AC1

`read/search -> preflight.record_evidence -> write` passes when evidence and claim are compatible.

### AC2

A guarded mutation without recorded evidence requires approval.

### AC3

A destructive production action without rollback is blocked or escalated according to policy, with hard-block preserved where required.

### AC4

High-risk guarded mutation with compatible evidence, claim, and rollback passes policy.

### AC5

Read-only `exec` remains bypassed.

### AC6

The file tested must be the same file the runtime would load.

## Out of scope for the current workaround

- native runtime causal evidence verification
- production rollout
- upstream OpenClaw core integration
- pretending that `after_tool_call` telemetry is already reliable for this purpose

## Required developer discipline

- do not modify production config during test work
- keep docs aligned with the runtime entrypoint actually loaded
- treat spec, code, tests, and packaging as one contract
