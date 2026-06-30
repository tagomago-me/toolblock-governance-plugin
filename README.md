# Policy Engine for OpenClaw

Version: `0.2.3`

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

- `preflight_record_evidence` (agent tool)
- `preflight.record_evidence`
- `policy_engine.status`
- `policy_engine.evidence_list`

The naming split is intentional:

- agent/tool surface uses `preflight_record_evidence`
- gateway/method surface uses `preflight.record_evidence`

For Mauro's production rollout, the plugin can now be scoped to specific agents with plugin config:

```json
{
  "onlyAgents": ["main"]
}
```

## Canonical workflow

1. Read/search the source you need.
2. Record it with `preflight_record_evidence`.
3. If you are operating through the Gateway instead of an agent tool loop, call `preflight.record_evidence`.
4. Execute the guarded mutation with a compatible `preflight_claim`.
5. Let the plugin return one of:
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
- [Production Validation on biob-os](docs/PRODUCTION-VALIDATION-BIOB-OS.md)
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

## Current production note

On `biob-os`, the plugin is loaded in the OpenClaw gateway and reports:

- version `0.2.3`
- `mode: "enforce"`
- `onlyAgents: ["main"]`
- gateway method `preflight.record_evidence`
- agent tool `preflight_record_evidence`

The hosted `main` agent path is now working end to end in production.

Root cause of the earlier failure:

- the plugin manifest was missing `contracts.tools`
- OpenClaw requires that declaration before surfacing plugin-owned agent tools

After adding:

```json
{
  "contracts": {
    "tools": ["preflight_record_evidence"]
  }
}
```

the hosted `main` agent successfully:

1. read the plugin README
2. called `preflight_record_evidence`
3. completed the guarded write flow

See [Production Validation on biob-os](docs/PRODUCTION-VALIDATION-BIOB-OS.md) for the exact validation snapshot.