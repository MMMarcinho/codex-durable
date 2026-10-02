# Codex Durable

A small, local-first harness for turning a real coding task into a reproducible Codex evaluation Scene. It keeps Codex's agent loop intact and makes the surrounding work durable: admission, workspace preparation, event recording, recovery decisions, and evidence.

Requires Node.js 24+, Git, `tar`, and Codex CLI. There are no npm dependencies. Node's built-in SQLite API currently emits an experimental warning.

## Quick start

Create a JSON spec beside a **clean Git repository**:

```json
{
  "prompt": "Fix the flaky login test without changing unrelated files.",
  "model": "gpt-6-sol",
  "codexVersion": "codex-cli 0.160.0",
  "timeoutMs": 1200000,
  "checks": [
    { "name": "login tests", "argv": ["npm", "test", "--", "login"], "timeoutMs": 120000 }
  ]
}
```

Run these commands from the Codex Durable project directory, substituting your repo and spec paths:

```sh
node src/cli.js --store .codex-durable scene create --repo /path/to/repo --spec /path/to/scene.json
node src/cli.js --store .codex-durable attempt submit scn_ID --request-id issue-42-run-1
node src/cli.js --store .codex-durable attempt run att_ID
node src/cli.js --store .codex-durable attempt show att_ID
node src/cli.js --store .codex-durable attempt events att_ID
```

To derive a Scene from an existing Codex run, supply the **actual starting commit** even if the checkout has since moved, then attach its JSONL trace as provenance:

```sh
node src/cli.js --store .codex-durable scene create --repo /path/to/repo --rev START_COMMIT --spec /path/to/scene.json
node src/cli.js --store .codex-durable source import scn_ID --events /path/to/codex-events.jsonl
```

Source traces are kept separately from candidate workspaces. A trace alone cannot reconstruct the starting filesystem, prompt, or external services; provide those in the Scene. Treat imported traces as local sensitive records and redact them before sharing the store.

`attempt watch att_ID` can run from another terminal. It starts with the committed history and then follows new events. Use `--after SEQ` to reconnect from a cursor. `attempt resume` requeues safe preparation and runs pending Attempts; it marks any in-flight Codex or grading process interrupted. `attempt retry att_ID` creates a new Attempt from the frozen Scene.

The store contains `state.sqlite`, `assets/scenes/<id>/base.tar`, and `runs/<id>/` with a workspace, `candidate.patch`, `events.jsonl`, `stderr.log`, `final.md`, and `report.json`. SQLite events are canonical; files are convenient exports. An Attempt result has a run status and, only after Codex succeeds, a separate `passed` value from checks.

## What is frozen

By default, `scene create` requires a clean Git worktree and archives its `HEAD` commit. With `--rev`, it archives that explicit commit even if the current checkout is dirty. It records the commit and tree SHA plus an archive checksum. This makes subsequent Attempts independent of the source checkout. Ignored files, untracked files, external services, and secrets are not captured. Supply repeatable setup through committed files and deterministic check commands; use an external fixture service if the task depends on mutable network data.

Codex runs with `--sandbox workspace-write`, `--ask-for-approval never`, `--json`, `--ephemeral`, and `--ignore-user-config`. The Scene pins the requested model and can pin the exact local CLI version with `codexVersion`; each Attempt records the observed CLI version, full invocation, and Codex-reported thread ID. Omit `codexVersion` if your CLI will change between runs. The tool does not assert that a model version or remote service is bit-for-bit reproducible.

## Why it borrows from Pi Durable

Pi Durable's source and specification informed four invariants: commit state before publishing it, record intent before effects, deduplicate submissions by request ID, and replay only work known to be safe. Codex Durable applies those at the outer harness boundary. It does not copy Pi Durable's model loop, extensions, compaction, or transcript implementation. See [design](docs/design.md) for the recovery and trust contracts and the [reference map](docs/pi-reference.md) for what was borrowed and why. Source reviewed: [`earendil-works/pi` `packages/durable`](https://github.com/earendil-works/pi/tree/0495646a8322ff99ce40ac2f9e15f1f49f56bb11/packages/durable) (MIT).

## Development

```sh
npm test
npm run check
```
