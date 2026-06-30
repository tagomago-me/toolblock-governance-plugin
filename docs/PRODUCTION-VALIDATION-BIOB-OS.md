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

## Hosted-agent validation timeline

A real hosted `main` agent session was created on the gateway.

The hosted agent was instructed to:

1. read the plugin README
2. call `preflight_record_evidence`
3. perform a guarded `write`

### First validation result

- the agent successfully used `read`
- the agent successfully used `write`
- the target file was created in `/tmp`
- the evidence ledger for that hosted session remained empty
- the assistant explicitly reported that `preflight_record_evidence` was not available in its tool set

### Root cause

OpenClaw requires plugin-owned agent tools to be declared in the manifest under `contracts.tools`.

The production manifest was missing:

```json
{
  "contracts": {
    "tools": ["preflight_record_evidence"]
  }
}
```

Because of that, the gateway loaded the plugin and its gateway methods, but did not project the plugin-owned agent tool into the hosted `main` agent tool inventory.

### Fix applied in production

The manifest at:

`/home/ubuntu/.openclaw/local-plugins/policy-engine/openclaw.plugin.json`

was patched to declare:

- `contracts.tools = ["preflight_record_evidence"]`

Then the gateway service was restarted:

- `systemctl --user restart openclaw-gateway.service`

### Second validation result

After the manifest fix, the hosted `main` agent successfully:

- read the plugin README
- called `preflight_record_evidence`
- wrote the validation artifact

The hosted session history included the tool result:

`Evidence recorded in policy ledger: read -> file:/home/ubuntu/.openclaw/local-plugins/policy-engine/README.md`

That is the production proof that the hosted-agent workflow is now functioning.

## Meaning

Production is working for the current workaround model.

What works:

- gateway plugin load
- guarded mutation policy path
- synchronous evidence ledger
- direct gateway evidence recording
- hosted `main` agent evidence recording through `preflight_record_evidence`
- hosted `main` agent guarded write flow after evidence registration

What still does not exist:

- native causal telemetry proving that a prior read/search happened through runtime telemetry without the explicit evidence tool workaround

## Current honest status

- source of truth repository: updated
- production plugin bundle: installed
- gateway runtime path: active
- hosted-agent tool exposure: fixed
- end-to-end workaround flow: working in production

## Immediate next implementation target

Keep the GitHub source-of-truth repository aligned with the working production manifest and validation record.

This is now the blocking item between:

- "working production workaround"

and

- "clean canonical repository state that documents the real fix"