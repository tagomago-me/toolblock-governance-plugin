# Policy Engine: Objective and Implementation Spec

Date: 2026-06-29

## Purpose

This document describes the real goal of the Policy Engine work, the current validated state, what had to be implemented, and where the relevant source materials originally lived.

This was consolidated from:

- the agent conversation summary
- the EC2 test bundle
- the runtime inspection work

## Strategic objective

Move governance out of prompts, ad hoc agent behavior, and `AGENTS.md`, and into runtime-enforced policy inside OpenClaw.

That means:

- intercept state-changing tool calls before execution
- classify the target and environment
- determine which knowledge sources should have been consulted
- require explicit evidence before mutation
- require human approval when evidence is missing or incompatible
- never block read-only inspection work

## Immediate technical objective

There are two separate tracks:

1. operational workaround now:
   use synchronous evidence recording through `preflight.record_evidence`
2. native evidence verification later:
   extend the runtime so verified read/search telemetry can be correlated before mutation

The workaround is implementable now.

Native verified causality still depends on runtime support that does not exist yet.

## What was validated

- the plugin can guard intended mutation paths
- the main bypass "`complete claim + no ledger`" was found and fixed
- the workaround uses an explicit synchronous evidence record
- read-only `exec` remains intended to stay unblocked
- destructive production actions without rollback remain hard-blocked
- the `after_tool_call` race was identified as the reason native evidence verification is not honest yet

## What was carried into this repository

This repository captures the coherent workaround state:

- canonical runtime file: `index.mjs`
- manifest version: `0.2.1`
- runtime methods:
  - `preflight.record_evidence`
  - `policy_engine.status`
  - `policy_engine.evidence_list`
- canonical tests:
  - `run-tests.mjs`
  - `acceptance-tests.mjs`
  - `bypass-regression.mjs`

## Decision

The correct decision for this version was:

- finish the workaround honestly
- make GitHub the source of truth
- install that exact state into production only after host-level verification

This repository is the result of the first two parts of that decision.
