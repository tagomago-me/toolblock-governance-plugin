# Deployment Context

This document records the deployment context that was visible while building this source-of-truth repository.

## Host identity in Mauro's setup

Observed from local SSH config:

- `biob-os` -> `100.97.215.57`, user `ubuntu`
- `openclaw-vps` -> `100.118.231.43`, user `mauro`

For the Policy Engine work described in this repository, the intended OpenClaw EC2 target is `biob-os`.

`openclaw-vps` is a different host and should not be confused with the EC2 OpenClaw environment for this plugin rollout.

## Test-bundle origin

The validated workaround bundle that seeded this repository came from:

`/tmp/openclaw-plugin-policy-engine-EzP9mC/openclaw-plugin-policy-engine`

on `biob-os`.

## Repo-first rollout rule

The rollout sequence for this project is:

1. consolidate the validated workaround into this GitHub repository
2. use this repository as the canonical source of truth
3. install this exact state into the production OpenClaw environment on `biob-os`

## Known current blocker from this Codex session

At the time of writing this repository state, SSH from the current Codex environment to both Mauro aliases timed out.

That blocks live production installation from this session until host connectivity is restored.
