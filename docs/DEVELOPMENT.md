# Development Guide

## Purpose

This document explains how the current Policy Engine workaround is built, validated, and extended.

## Canonical runtime entrypoint

The canonical runtime entrypoint is:

- `index.mjs`

Everything in this repository should agree on that:

- docs
- tests
- plugin manifest
- runtime behavior

## Main implementation parts

### 1. Runtime Guard

The plugin registers a `before_tool_call` hook.

That hook:

- checks whether the tool is guarded
- classifies target, environment, and risk
- checks claim completeness
- checks evidence availability and compatibility
- returns pass, approval, or block behavior

### 2. Evidence Recorder

The plugin exposes:

- `preflight_record_evidence` as an agent tool
- `preflight.record_evidence` as a gateway method

This is the current operational workaround. It lets an agent explicitly register evidence before a guarded mutation without depending on `after_tool_call` telemetry.

### 3. Evidence Ledger

Evidence is stored synchronously in a local JSONL ledger.

Its job is to:

- write evidence before guarded mutation
- retain evidence by `runId`, then fall back to `sessionId`, then `sessionKey`
- make that evidence available during `before_tool_call`

### 4. Policy Bundle

Policies are data-driven and live in YAML:

- `default.preflight.yaml`
- `default.risk.yaml`
- `default.evidence.yaml`
- `default.routing.yaml`
- `default.placement.yaml`
- `default.artifact-lifecycle.yaml`
- `default.tree-mirror.yaml`
- `default.completion.yaml`

### 5. Status and inspection methods

The bundle exposes:

- `policy_engine.status`
- `policy_engine.evidence_list`

These methods exist so the runtime state can be inspected without reading internal files by hand.

## Current test workflow

The canonical test set in this repository is:

```bash
npm test
```

That expands to:

```bash
node tests/run-tests.mjs
node tests/acceptance-tests.mjs
node tests/bypass-regression.mjs
```

## What this source-of-truth repo preserves

This repository preserves the validated workaround state that came out of:

- the design and audit conversation
- the EC2 test bundle
- the bypass regression fix

In practice that means:

- `index.mjs` is the runtime source file
- the runtime methods and the agent tool in docs are actually exposed
- the missing-ledger bypass is fixed
- the agent-visible evidence tool is present
- session-aware evidence matching covers the runtime gap where tool execution does not expose `runId`
- agent scoping is available through `onlyAgents`
- only the canonical validated tests are carried forward

## Known limitation

This workaround is not native causal evidence verification.

What it can prove:

- the run recorded explicit evidence
- the evidence is compatible with the intended mutation

What it cannot prove:

- that the read or search happened through trustworthy runtime telemetry immediately before the mutation

That limitation exists because the current runtime does not provide reliable causal persistence through `after_tool_call` for this use case.

## Production rollout principle

Production rollout should install this exact repository state, not a drifting temp directory.

That is why GitHub is the source of truth first, and host install comes second.