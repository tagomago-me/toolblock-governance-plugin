# Policy Engine Requirements

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
- config, deploy, and infrastructure mutations

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
- environment
- risk level

### R4. Use policy as data

Rules must live in YAML, not be hard-coded as Mauro-specific prompt behavior.

### R5. Require evidence before guarded mutation

If a guarded mutation is attempted without compatible recorded evidence, the system must require human approval.

This remains true even when the `preflight_claim` is otherwise complete.

### R6. Preserve hard blocks

Destructive production actions without rollback must remain blocked.

### R7. Support explicit evidence registration

The runtime-exposed workaround flow must support:

1. read/search
2. `preflight_record_evidence` for agent turns
3. `preflight.record_evidence` for direct gateway usage
4. guarded mutation with `preflight_claim`

### R8. Expose operational inspection methods

The runtime bundle must expose:

- `preflight_record_evidence`
- `policy_engine.status`
- `policy_engine.evidence_list`

### R8a. Bridge agent and gateway surfaces honestly

The repository must document and preserve the naming split:

- `preflight_record_evidence` is the agent-usable tool
- `preflight.record_evidence` is the gateway method

This split exists because OpenClaw tool naming follows the underscore-style tool catalog while gateway methods use dotted names.

### R8b. Support scoped activation by agent id

The plugin must support limiting enforcement to specific agent ids so production rollout can target `main` without changing behavior for every other agent.

### R9. Keep implementation honest

The system must not claim native causal proof if the runtime does not provide it.

Current honest scope:

- verifies synchronous recorded evidence
- does not prove native causal telemetry of prior reads and searches

## Acceptance criteria

### AC1

`read/search -> preflight_record_evidence -> write` passes in a real agent flow when evidence and claim are compatible.

### AC1b

`read/search -> preflight.record_evidence -> write` passes for direct gateway validation when evidence and claim are compatible.

### AC2

A guarded mutation without recorded evidence requires approval.

### AC3

A destructive production action without rollback is blocked or escalated according to policy, with the hard block preserved where required.

### AC4

High-risk guarded mutation with compatible evidence, claim, and rollback passes policy.

### AC5

Read-only `exec` remains bypassed.

### AC6

The file tested must be the same file the runtime would load.

### AC7

Evidence recorded from the agent tool must remain usable during `before_tool_call` even when the tool surface cannot provide the active `runId`, using runtime-backed session identity as the fallback match.

## Out of scope for this version

- native runtime causal evidence verification
- upstream OpenClaw core integration
- pretending that `after_tool_call` telemetry is already trustworthy for this use case

## Required discipline

- keep docs aligned with the runtime entrypoint actually loaded
- keep tests aligned with the same runtime file
- do not blur the line between workaround and native runtime evidence