# Policy Engine Validation Report (EC2 Test Environment)

Date: 2026-06-29
Host: `biob-os`
Test bundle: `/tmp/openclaw-plugin-policy-engine-EzP9mC/openclaw-plugin-policy-engine`

## Objective

Validate the operational workaround version of the Policy Engine in test only, and make the package coherent so the file tested is the same file OpenClaw would load.

## Observed facts

- OpenClaw plugin discovery on the inspected EC2 host resolves local plugin roots through default entry candidates.
- In the validated bundle, the runtime-relevant file was the root `index.mjs`.
- The temporary bundle had earlier packaging drift, which was aligned before the validation rerun.

## Changes made in the test bundle before validation

- set bundle metadata to `0.2.1`
- aligned manifest and package entrypoint to `index.mjs`
- updated gateway status version to `0.2.1`
- updated human approval guidance so missing ledger evidence explicitly says complete claim is insufficient

## Validation commands

```bash
npm test
node tests/acceptance-tests.mjs
node tests/bypass-regression.mjs
```

## Validation results

- `npm test`: pass
- `node tests/acceptance-tests.mjs`: pass
- `node tests/bypass-regression.mjs`: pass

Confirmed behaviors:

- `preflight.record_evidence` plus compatible ledger plus guarded mutation => pass
- guarded mutation without ledger => `require_approval`
- read-only `exec` => bypass
- destructive production action without rollback => hard block preserved

## Residual risks

- this is still the operational workaround, not native verified evidence telemetry
- the runtime race between `before_tool_call` and fire-and-forget `after_tool_call` is still real
- production integration was not part of the test-bundle validation
