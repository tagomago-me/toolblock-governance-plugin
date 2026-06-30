# Policy Engine for OpenClaw

Version: `0.2.2`

This repository is the source of truth for the current Policy Engine workaround that was validated in the EC2 test bundle and prepared for rollout into Mauro's OpenClaw setup.

The goal of the plugin is to move governance out of prompts and `AGENTS.md` into runtime policy.

## What it does

The plugin guards state-changing operations before execution.

Current validated behavior:

- intercepts guarded mutations through `before_tool_call`
- classifies target, environment, and risk
- loads policy from YAML
- requires human approval when recorded evidence is missing
- blocks destructive production actions without rollback
- keeps read-only inspection cheap

## Current honest scope

This is a workaround with synchronous recorded evidence.

It does prove:

- evidence was explicitly recorded for the run
- the recorded evidence is compatible with the guarded mutation claim

It does not prove:

- that the read or search definitely happened through native runtime telemetry immediately before the mutation

That larger capability still needs upstream runtime support.

## Runtime methods

The canonical runtime entrypoint is `index.mjs`.

The plugin exposes:

- `preflight.record_evidence`
- `policy_engine.status`
- `policy_engine.evidence_list`

For Mauro's production rollout, the plugin can now be scoped to specific agents with plugin config:

```json
{
  "onlyAgents": ["main"]
}
```

## Canonical workflow

1. Read/search the source you need.
2. Call `preflight.record_evidence`.
3. Execute the guarded mutation with a compatible `preflight_claim`.
4. Let the plugin return one of:
   - `pass`
   - `require_approval`
   - `block`

## Repository layout

```text
.
├── index.mjs
├── openclaw.plugin.json
├── package.json
├── policies/
├── tests/
├── REQUIREMENTS.md
└── docs/
```

## Important docs

- [REQUIREMENTS.md](REQUIREMENTS.md)
- [Development Guide](docs/DEVELOPMENT.md)
- [Parts Map](docs/PARTS.md)
- [Usage](docs/USAGE.md)
- [Objective and Implementation Spec](docs/OBJECTIVE-AND-IMPLEMENTATION-SPEC.md)
- [EC2 Test Validation](docs/VALIDATION-EC2-TEST.md)
- [Evidence Ledger Workaround](docs/EVIDENCE-LEDGER-WORKAROUND.md)
- [Deployment Context](docs/DEPLOYMENT-CONTEXT.md)

## Tests carried into source of truth

The canonical validated tests in this repository are:

- `tests/run-tests.mjs`
- `tests/acceptance-tests.mjs`
- `tests/bypass-regression.mjs`

The `npm test` script runs all three.

## Host-coupled note

The current `package.json` keeps the tested OpenClaw dependency path used on the EC2 test host:

`/home/ubuntu/.openclaw/npm/node_modules/openclaw`

That is intentional for this source-of-truth snapshot because it mirrors the working test bundle that was validated on Mauro's OpenClaw EC2 environment.