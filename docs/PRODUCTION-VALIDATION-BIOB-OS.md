# Production Validation on biob-os

Date: 2026-06-30

## Scope

This note records what was observed on Mauro's production OpenClaw host `biob-os` and the follow-up change introduced in plugin version `0.2.4`.

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
  "version": "0.2.4",
  "mode": "enforce",
  "enabled": true,
  "onlyAgents": ["main"],
  "ledger": "active",
  "evidenceTool": "preflight_record_evidence",
  "evidenceGatewayMethod": "preflight.record_evidence",
  "policyWriteTool": "policy_write_file",
  "policyWriteGatewayMethod": "policy_engine.write_file",
  "runtimeEntrypoint": "index.mjs"
}
```

## What was validated successfully

The gateway control-plane methods are live:

- `policy_engine.status`
- `policy_engine.evidence_list`
- `policy_engine.write_file`
- `preflight.record_evidence`

The production gateway accepted a direct control-plane evidence write and reported the plugin as active.

## Hosted-agent validation timeline

A real hosted `main` agent session was created on the gateway.

The hosted agent was instructed to:

1. read the plugin README
2. call `preflight_record_evidence`
3. perform a guarded write

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
    "tools": ["preflight_record_evidence", "policy_write_file"]
  }
}
```

Because of that, the gateway loaded the plugin and its gateway methods, but did not project the plugin-owned agent tool into the hosted `main` agent tool inventory.

### Fix applied in production

The manifest at:

`/home/ubuntu/.openclaw/local-plugins/policy-engine/openclaw.plugin.json`

was patched to declare:

- `contracts.tools = ["preflight_record_evidence", "policy_write_file"]`

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

### Third validation result

Version `0.2.4` adds `policy_write_file`.

That change is necessary because the hosted built-in `write` tool is an OpenClaw core surface and does not reliably carry plugin-specific governance metadata. The supported governed write path is now:

1. read/search
2. `preflight_record_evidence`
3. `policy_write_file`

The production configuration now denies native mutation tools for `main`:

- `write`
- `edit`
- `apply_patch`

The deny list was applied through `OPENCLAW_HOME=/home/ubuntu openclaw config set ... --strict-json`, then `openclaw-gateway.service` was restarted.

Direct gateway validation confirmed:

- `policy_engine.status` reports version `0.2.4`
- `policy_engine.write_file` without evidence does not create the target file
- `preflight.record_evidence` followed by `policy_engine.write_file` creates the target file

Hosted `main` positive validation confirmed:

- `main` read the production plugin README
- `main` called `preflight_record_evidence`
- `main` called `policy_write_file`
- `/tmp/policy-engine-hosted-policy-write-1782847843095.txt` was created with `hosted policy write validation`

Hosted `main` negative validation confirmed:

- `main` called `policy_write_file` without evidence
- the tool returned missing recorded evidence
- `/tmp/policy-engine-hosted-policy-write-negative-1782848284721.txt` was not created

## Meaning

Production is moving from hook-observer governance to plugin-owned mutation governance.

What works:

- gateway plugin load
- guarded mutation policy path
- synchronous evidence ledger
- direct gateway evidence recording
- hosted `main` agent evidence recording through `preflight_record_evidence`
- hosted `main` agent governed write flow through `policy_write_file` after evidence registration
- hosted `main` no-evidence governed write rejection
- `main` native `write`, `edit`, and `apply_patch` denied by agent tool policy

What still does not exist:

- native causal telemetry proving that a prior read/search happened through runtime telemetry without the explicit evidence tool workaround
- a guarantee that OpenClaw built-in `write` carries policy-specific governance metadata

## Current honest status

- source of truth repository: updated
- production plugin bundle: installed
- gateway runtime path: active
- hosted-agent tool exposure: fixed
- plugin-owned governed write surface: `policy_write_file`
- main native mutation bypass path: denied for `write`, `edit`, and `apply_patch`
- direct gateway validation: passed
- hosted main positive validation: passed
- hosted main negative validation: passed

## Immediate next implementation target

Extend the plugin-owned mutation surface beyond file writes.

This is now the blocking item between:

- "governed writes working"

and

- "all mutation classes have first-class governed tools"
