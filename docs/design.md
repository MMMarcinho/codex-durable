# Codex Durable design

## Scope

Codex Durable turns a real coding task into a frozen Scene and runs independent Codex Attempts against it. Codex owns its model and tool loop. This project owns admission, storage, workspace preparation, process supervision, evidence, and grading. It never presents the source solution to the candidate.

The implementation intentionally uses a single noninteractive Codex worker (`codex exec --json`). It does not claim to resume an interrupted Codex tool call or reconstruct hidden model context. Interactive app-server sessions and external-service fixture capture are separate adapters that can be added against the same Scene/Attempt contracts.

## Records

* **Scene** is immutable: prompt, pinned source commit/tree, a SHA-256 verified Git archive, pinned model, Codex options, and checks. Only a clean Git worktree can be captured. The source path is provenance, never a dependency of an Attempt.
* **Attempt** has an idempotent submission key and a state: `queued -> preparing -> running -> grading -> completed`. `failed` and `interrupted` are terminal. Each Attempt gets its own workspace. An interrupted Attempt is never reused for another execution.
* **Event** is an immutable SQLite row, ordered by a global sequence. The state transition and its event are one transaction. Codex JSONL items and grader results are stored as events; `watch` can reconnect using a sequence cursor.
* **Source trace** is an optional immutable Codex JSONL file linked to a Scene. It is provenance only, stored outside candidate workspaces. A historical trace does not prove the Scene reconstructed the original filesystem; the starting commit must be supplied and validated separately.

## Durability contract

The store uses SQLite WAL and `synchronous=FULL`. A Scene archive is fsynced and renamed before the Scene row is committed. Attempt admission is transactional and deduplicated by `requestId`. A SQLite runner lease prevents another process from treating a live run as crashed; a dead local owner's lease can be taken over. Preparation is replay-safe because it rebuilds a fresh workspace from immutable Scene assets. The `running` transition and spawn intent are committed before launching Codex. Codex execution is an unsafe external effect: after a crash, `resume()` marks a running or grading Attempt `interrupted`, preserves its workspace, old process ID, and events, and does not re-execute it. A new Attempt starts from the Scene archive.

This is inspired by Pi Durable's atomic visible state, task checkpoints, request IDs, and replay-safe versus unsafe effect boundary. It is not a port of Pi Durable's model loop, document graph, or conversation semantics.

## Evidence and grading

The runner records the exact Codex command, stdout JSONL events, bounded stderr, final message, exit status, patch, and hashes. It captures the candidate patch before running checks. Checks run as argv arrays without a shell; their exit codes and bounded output are immutable evidence. A completed Attempt has a separate `passed` boolean. A tool failure or interrupted run never becomes a score of zero. Exported JSONL and report files are derived from SQLite and regenerated on `resume()` after an interrupted export.

## Trust boundary

The source repository and grader commands are trusted inputs. Codex executes in its own workspace with the `workspace-write` sandbox and approval policy `never`. The project does not implement container isolation or secret filtering; use an external isolated runner before evaluating untrusted repositories or scripts. No auth token is copied into Scene assets or reports.
