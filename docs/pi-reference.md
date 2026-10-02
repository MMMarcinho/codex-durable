# Pi Durable reference map

Reviewed [`earendil-works/pi` at `0495646a8322ff99ce40ac2f9e15f1f49f56bb11`](https://github.com/earendil-works/pi/tree/0495646a8322ff99ce40ac2f9e15f1f49f56bb11/packages/durable), in particular `packages/durable/docs/spec.md`, `src/harness/scheduler.ts`, `src/harness/tool.ts`, `src/session/transaction.ts`, the storage adapters, and the recovery examples/tests. Pi Durable is MIT licensed. This project uses its design ideas; no Pi source file is copied.

| Pi Durable mechanism | Codex Durable implementation | Boundary |
| --- | --- | --- |
| One atomic commit line for visible session state | `Store.transaction()` commits Attempt state and its event together in SQLite | Codex's own workspace writes occur outside this transaction. |
| Request ID deduplicates admission | Unique `request_id` on Scenes, Source Traces, and Attempts, with input conflict detection | A request ID does not make downstream tools exactly once. |
| Checkpoint before an external effect | `preparing` and `codex_spawn_intent` are committed before the Codex process starts | The tiny spawn-to-PID-record interval is uncertain after a hard crash. |
| Safe/unsafe tool replay | Scene restore is replay-safe; Codex execution is always unsafe and becomes `interrupted` on recovery | We cannot label Codex's internal tool calls safe from the outside. |
| Storage-backed late joining | `attempt events --after SEQ` and `attempt watch` read committed events | No remote transport or live browser UI is bundled. |
| Durable document and transcript state | Immutable Scene manifest, Source Trace, Attempt result, and event journal | No replacement model loop, context compaction, or mid-turn prompt editing. |
| Task ownership and abort semantics | One Attempt owns one Codex process and one workspace; timeout/cancel kills its process group | There is no generic child-task tree yet. |

The distinction matters: Pi Durable can checkpoint its **own** model and tool loop. Codex Durable controls Codex as an external worker through its public CLI, so it can durably manage admission and evidence but cannot promise exact resumption inside a Codex turn. A new Attempt is the honest recovery path after an uncertain coding effect.
