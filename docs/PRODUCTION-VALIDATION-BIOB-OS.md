# Production Validation on biob-os

Date: 2026-06-30

## Scope

This note records what was observed on Mauro's production OpenClaw host `biob-os` after promoting plugin version `0.2.3`.

This is not a design note or a test-environment claim. It is the production snapshot.

## Observed from production

The plugin is installed at:

`/home/ubuntu/.openclaw/local-plugins/policy-engine`

The OpenClaw config is:

`/home/ubuntu/.openclaw/openclaw.json`

The user service is:

`openclaw-gateway.service`

The gateway-reported plugin status is:

```json
{
  "plugin": "policy-engine",
  "version": "0.2.3",
  "mode": "enforce",
  "enabled": true,
  "onlyAgents": ["main"],
  "ledger": "active",
  "evidenceTool": "preflight_record_evidence",
  "evidenceGatewayMethod": "preflight.record_evidence",
  "runtimeEntrypoint": "index.mjs"
}
```

## What was validated successfully

The gateway control-plane methods are live:

- `policy_engine.status`
- `policy_engine.evidence_list`
- `preflight.record_evidence`

The production gateway accepted a direct control-plane evidence write and reported the plugin as active.

## Hosted-agent validation

A real hosted `main` agent session was created on the gateway.

The hosted agent was instructed to:

1. read the plugin README
2. call `preflight_record_evidence`
3. perform a guarded `write`

The result was:

- the agent successfully used `read`
- the agent successfully used `write`
- the target file was created in `/tmp`
- the evidence ledger for that hosted session remained empty
- the assistant explicitly reported that `preflight_record_evidence` was not available in its tool set

## Meaning

Production is only partially working today.

What works:

- gateway plugin load
- guarded mutation policy path
- synchronous evidence ledger
- direct gateway evidence recording

What does not yet work end to end:

- the hosted `main` agent does not currently receive `preflight_record_evidence` as a usable tool

That means the canonical agent-side workflow documented in [docs/USAGE.md](USAGE.md) is not yet fully available in Mauro's production hosted-agent path.

## Current honest status

- source of truth repository: updated
- production plugin bundle: installed
- gateway runtime path: active
- hosted-agent tool exposure: not complete

## Immediate next implementation target

Find why the OpenClaw hosted-agent runtime on `biob-os` is not projecting the plugin-registered tool into the live `main` agent tool inventory.

This is now the blocking item between:

- "plugin installed in production"

and

- "main hosted agent can actually use the evidence workflow by itself"