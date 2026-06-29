# Development Guide

## Purpose

This document explains how the current Toolblock Governance Plugin workaround is built, validated, and extended.

## Canonical runtime entrypoint

The canonical runtime entrypoint is:

- `index.mjs`

This matters because earlier work drifted between:

- `src/index.ts`
- `dist/index.js`
- `index.mjs`

The current rule is simple:

- docs must describe `index.mjs`
- tests must validate `index.mjs`
- runtime methods must be present in `index.mjs`

## Main implementation concepts

### 1. Runtime Guard

The plugin registers a `before_tool_call` hook.

That hook:

- checks whether the tool is guarded
- classifies environment and risk
- checks evidence availability and compatibility
- returns pass, approval, or block behavior

### 2. Evidence Recorder

The plugin exposes:

- `preflight.record_evidence`

This is the operational workaround that lets an agent explicitly register evidence before a guarded mutation.

### 3. Evidence Ledger

Evidence is stored synchronously in a local JSONL ledger.

Typical role:

- write evidence before guarded mutation
- read evidence by `run_id`
- use it during `before_tool_call`

### 4. Policy Bundle

Policies are data-driven and live in YAML.

Examples:

- `default.preflight.yaml`
- `default.risk.yaml`
- `default.evidence.yaml`
- `default.routing.yaml`

### 5. Status and Inspection Methods

The bundle exposes:

- `policy_engine.status`
- `policy_engine.evidence_list`

These exist to make the runtime state inspectable without reading internal files by hand.

## Current test workflow

Validation currently relies on:

- runtime entrypoint tests
- acceptance tests
- bypass regression tests

Representative commands:

```bash
npm test
node tests/acceptance-tests.mjs
node tests/bypass-regression.mjs
```

## What was fixed in this stage

### Packaging coherence

The work aligned the runtime bundle so the tested file and the runtime-loaded file are the same conceptual target.

### Runtime contract coherence

The runtime entrypoint now exposes the same operational methods that the docs describe:

- `preflight.record_evidence`
- `policy_engine.status`
- `policy_engine.evidence_list`

### Documentation coherence

The docs were updated so they no longer describe missing methods as if they already existed.

## Known limitation

The current workaround is not native causal evidence verification.

What it can prove:

- the run recorded explicit evidence
- the evidence is compatible with the intended mutation

What it cannot prove:

- that the read/search happened through reliable runtime telemetry immediately before the mutation

That limitation exists because `after_tool_call` persistence is not yet a trustworthy causal source for this use case.

## Recommended next development step

The next real step is not more internal refactoring.

It is:

1. load the bundle into an OpenClaw test path
2. verify that `main` can actually call `preflight.record_evidence`
3. run a real end-to-end guarded workflow
4. only then discuss production activation

## Suggested extension roadmap

### Phase A

Done:

- bundle coherence
- runtime method coherence
- test coverage for the runtime entrypoint
- documentation coherence

### Phase B

Next:

- load in OpenClaw test config
- validate hook registration in a live test runtime
- validate real agent workflow

### Phase C

Later:

- runtime extension for native causal telemetry
- evidence verification that does not rely on explicit self-declared recording alone
