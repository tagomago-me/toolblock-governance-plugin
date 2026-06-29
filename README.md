# Toolblock Governance Plugin

This repository documents the current Toolblock Governance Plugin / Policy Engine work for OpenClaw.

Its purpose is to make the project understandable as a system, not just as a conversation or a temporary plugin bundle.

## What this project is

This project is a runtime governance layer for OpenClaw.

It exists to move governance out of:

- prompts
- implicit agent behavior
- `AGENTS.md`-only rules

and into runtime policy that executes before guarded tool calls.

## What it does

At the current test-bundle stage, the Policy Engine can:

- intercept guarded state-changing tool calls
- classify target and environment
- evaluate YAML-based policy rules
- require human approval when evidence is missing
- hard-block destructive production actions without rollback
- allow read-only inspection flows to stay cheap

## Current operational workflow

1. Read or search for the needed source.
2. Record evidence with `preflight.record_evidence`.
3. Execute the guarded mutation with a compatible `preflight_claim`.
4. Let the plugin decide:
   - `pass`
   - `requireApproval`
   - `block`

## Named parts

The system is easier to understand if we give stable names to the main pieces:

- `Runtime Guard`: the `before_tool_call` interception layer
- `Evidence Recorder`: the `preflight.record_evidence` gateway method
- `Evidence Ledger`: the local synchronous ledger stored in JSONL
- `Policy Evaluator`: the decision logic that returns `pass`, `require_approval`, or `block`
- `Policy Bundle`: the YAML files under `policies/`
- `Status Surface`: `policy_engine.status`
- `Evidence Inspector`: `policy_engine.evidence_list`

See [docs/PARTS.md](docs/PARTS.md) for the detailed part map.

## Repository documents

- [REQUIREMENTS.md](REQUIREMENTS.md): what the system must do
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): how it is built, tested, and extended
- [docs/PARTS.md](docs/PARTS.md): names and responsibilities of each part

## Honest current status

- The test bundle is aligned around the canonical runtime entrypoint `index.mjs`.
- The runtime bundle exposes:
  - `preflight.record_evidence`
  - `policy_engine.status`
  - `policy_engine.evidence_list`
- The workaround is implemented in test.
- It is not yet loaded into the active `main` agent config.
- Native causal evidence verification is still not available upstream.

## Canonical reference locations

Main spec on EC2:

- `/home/ubuntu/.openclaw/plane/os/infraestrutura/tool-block-governance-plugin/policy-engine-objetivo-e-spec-de-implementacao.md`

Usage guide on EC2:

- `/home/ubuntu/.openclaw/plane/os/infraestrutura/tool-block-governance-plugin/policy-engine-como-usar-no-openclaw.md`

Current test bundle on EC2:

- `/tmp/openclaw-plugin-policy-engine-EzP9mC/openclaw-plugin-policy-engine`

## Suggested implementation shape

```text
toolblock-governance-plugin/
  README.md
  REQUIREMENTS.md
  docs/
    DEVELOPMENT.md
    PARTS.md
  src/
  tests/
  policies/
```
