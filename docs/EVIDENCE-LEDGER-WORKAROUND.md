# Evidence Ledger Workaround

## Status

Implemented in the validated test bundle and carried into this repository.

## Why it exists

The current OpenClaw runtime does not yet provide trustworthy causal proof that a read or search completed and persisted before a later guarded mutation.

Because of that, the plugin cannot honestly rely on `after_tool_call` telemetry as the required source of truth for pre-mutation evidence.

## Current workaround

The plugin exposes an explicit gateway method:

- `preflight.record_evidence`

That method writes evidence synchronously into a local ledger.

During `before_tool_call`, the plugin checks that ledger before allowing a guarded mutation to pass automatically.

## What it proves

- this run recorded evidence
- the recorded evidence is compatible with the later claim

## What it does not prove

- that the claimed read or search definitely happened through native runtime telemetry

## Operational rule

For guarded mutations:

- no ledger evidence => `require_approval`
- incompatible evidence => `require_approval`
- hard policy violation => `block`

Important detail:

- complete claim without ledger evidence is still not enough

That was the critical bypass fixed before this repository was assembled.
