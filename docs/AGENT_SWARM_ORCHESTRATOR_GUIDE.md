# Lead-agent guide: controlled workers (0.2.0)

The lead chooses every profile and model, supplies instructions, reviews results, and decides recovery. Principal provides native execution, account isolation, exclusive reservations, retained Git worktrees, and durable telemetry. It never chooses a substitute account or retries inference.

## Connect and inspect

Keep the existing MCP registration:

```toml
[mcp_servers.principal_swarm]
command = "principal-mcp"
```

Rebuild/install the updated executable and restart the Principal management daemon and reload the MCP connection to discover the new tools. Do not restart unrelated running agent sessions. `principal_list_profiles` returns stable IDs, native capabilities, authentication evidence, per-bucket quota observations with timestamps, reservations, and recent execution outcomes. Unknown or stale quota is not zero. Headroom is a conservative observation summary across reported buckets, not model eligibility or a routing score. Account labels do not prove identity.

## Start an exact assignment

Call `principal_start_worker`:

```json
{
  "request_id": "parser-audit-001",
  "profile_id": "EXACT_ID_FROM_LIST",
  "cwd": "/path/to/repository",
  "task": "Audit the parser, add a regression test, and report commands actually run. Leave changes for lead review.",
  "timeout_seconds": 600
}
```

`model` and `effort` are optional native overrides. Omit them to preserve provider defaults; an absent provider-reported model remains unknown. Unsupported efforts or models fail rather than silently downgrading. Authentication unknown is reported honestly; rejected authentication blocks dispatch.

Start returns an accepted worker ID and pinned workspace without waiting for inference. A warm worker reserves its profile, even between turns. Native launches and other MCP/CLI clients cannot acquire that profile until the worker stops. Standalone Claude profiles remain visible but controlled execution is unsupported. Copilot workers require the current native configuration and login; alternate directories and isolated Copilot profiles are rejected. Aliases of that native login share reservation and native-invocation busy checks.

Git HEAD must exist. Worktrees start at the returned `baseRevision`; source uncommitted changes are excluded and exposed through `sourceDirty`. Commit a desired baseline yourself before starting if workers need those changes. A requested subdirectory is preserved as `workingDir`. No patch is applied to the source repository automatically. Worktrees isolate Git state, not filesystem permissions: the existing unattended native launch policy remains in use.

## Inspect, follow up, and steer

`principal_get_worker` accepts `worker_id`, `cursor` (default 0), and `wait_seconds` (0–25). Pass the returned `nextCursor` to obtain the next bounded event page; `hasMore` means more pages remain. State includes native session/turn IDs, runner heartbeat, substantive activity, typed failures, queued-message count, and artifact references. Provider reasoning and raw authentication error bodies are not logged. A cancelled polling request only ends its wait; execution continues.

Call `principal_send_worker_message` with a new stable request ID:

```json
{
  "request_id": "parser-audit-followup-001",
  "worker_id": "WORKER_ID",
  "message": "Focus on the failing boundary test first.",
  "delivery": "auto",
  "expected_turn_id": "CURRENT_PROVIDER_TURN_ID"
}
```

- `auto`: steer an active Codex turn, requiring its current `expected_turn_id`; queue for Antigravity/Copilot or when idle.
- `steer`: require native live steering; unsupported or stale-turn requests fail explicitly.
- `next_turn`: queue behind the current turn on every supported provider.

Inspect the returned delivery mode; a transport failure may leave delivery uncertain. Repeat the identical request ID and arguments to recover an existing receipt. Never use a fresh ID to blindly replay an uncertain instruction. Reusing an ID with different arguments fails.

Antigravity receives one NDJSON user message per turn. Principal waits for its result before sending the next message; it does not send unsupported control messages or CLI slash commands into the stream. Codex uses its app-server thread/turn controls in a separate execution adapter from read-only usage observation.

Copilot uses SDK protocol-3 Content-Length-framed JSON-RPC with session create/send/resume/abort. Its terminal event is `session.idle`; `session.error` fails the turn. Follow-ups wait until idle; live steering is unsupported. Explicit model and reasoning-effort overrides go to Copilot unchanged. Model entitlement and live inference still need account-level verification.

## Failure, cancellation, and resume

The hard turn deadline defaults to 300 seconds and is configurable up to 24 hours. Startup is bounded at 60 seconds. Inactivity after 120 seconds is a warning, not automatic cancellation. A heartbeat proves runner liveness, not task progress. Provider terminal status, process exit, artifact capture, validation, and integration are separate facts; normal process exit alone is never success.

`principal_cancel_worker` takes `worker_id` and `request_id`. It acknowledges shutdown, pauses queued messages, interrupts the native turn when supported, and escalates cleanup through identity-checked Linux pidfds. Poll until the worker is stopped and no longer reserved. Only owned process trees and isolation helpers are signalled. Unresolved ownership retains the reservation.

`principal_resume_worker` takes the same fields. It reacquires the original profile and workspace and uses the recorded native conversation ID. Resumption leaves pending messages paused; a new accepted follow-up explicitly continues the pending queue. A released workspace, unavailable native history, rejected authentication, unsupported resume interface, busy profile, or unresolved cleanup blocks resume. Native history recovery does not reconstruct unsaved turns.

MCP disconnection does not stop execution. Management restart reconnects through the worker's private control socket and durable runtime/event files. If the runner was lost, Principal reports interruption, retains any uncertain reservation, and allows explicit cancellation to clean up verified remaining processes. It never automatically restarts inference. A crash during an unrecorded native launch requires manual ownership inspection rather than unsafe PID guessing.

To retry on another account, start a new worker with that profile and lead-supplied instructions. Native session IDs are never silently transferred between accounts. The lead chooses how to incorporate the retained partial code into a new Git baseline.

## Review artifacts and release

Each turn saves `turn-N.patch` and `turn-N.json`. Patches include uncommitted edits, untracked files, deletions, binary changes, and commits made since the pinned baseline. Capture uses an alternate Git index and preserves worker staging. Capture failure is explicit and the worktree remains available.

`principal_read_worker_artifact` takes `worker_id`, `artifact_id`, optional byte `offset`, and `length` up to 65536. Decode base64 chunks and concatenate their bytes; the returned `nextOffset` is the next byte offset. The metadata file lists modified paths. Apply and validate patches through the lead's existing review workflow.

After stopping and reviewing, call `principal_release_worker`. It captures `final.patch` and `final.json`, then deletes only the owned worktree/branch. Failed final capture or changed worktree ownership blocks cleanup. Summaries, saved patches, and event journals remain. Release is idempotent. There is no automatic expiry or deletion of retained workspaces.

## Explicit batches and CLI migration

The existing deployment/status/cancellation tool names remain. A batch contains at most 32 tasks, each with a different explicit `profile_id`, `cwd`, and task ID (generated if omitted). The optional `provider` only validates assignments. `provider: "auto"`, missing assignments, `wait_for_completion: true`, duplicate profile assignments, and `max_parallel` below task count are rejected. Submit smaller batches or use sequential worker follow-ups. Partial setup failures are returned per task; successfully created workers remain individually controllable. Batch status tracks the initial assigned turns; artifacts need lead review.

```json
{
  "request_id": "batch-001",
  "tasks": [
    {"id":"parser", "profile_id":"PROFILE_A", "cwd":"/repo", "task":"Audit parser"},
    {"id":"tests", "profile_id":"PROFILE_B", "cwd":"/repo", "task":"Review tests"}
  ]
}
```

`principal_cancel_swarm` also requires a stable request ID and reports each cancellation outcome. No implicit account queues, account selection, or automatic retries remain.

```sh
principal swarm profiles
principal swarm workers
principal swarm start --json-file worker.json
principal swarm get WORKER_ID --cursor 0 --wait 20
principal swarm message --json-file followup.json
principal swarm cancel-worker WORKER_ID --request-id stop-001
principal swarm resume WORKER_ID --request-id resume-001
principal swarm artifact WORKER_ID turn-1.patch --offset 0
principal swarm release WORKER_ID --request-id release-001
principal swarm run --tasks batch.json --request-id batch-001 --wait
principal swarm status SWARM_ID
principal swarm cancel SWARM_ID --request-id cancel-batch-001
```

CLI `--wait` polls client-side. Closing it leaves durable workers running. Outputs are JSON. Existing MCP executable/configuration names remain unchanged.

## Evidence boundaries

Tests use credential-free fake providers, disposable repositories, and isolated state. They validate control flow and failure handling without inference. Live account login/refresh, independent Antigravity keyrings, real-provider steering/resume, and model entitlements require separate live evidence. Never equate execution completion or a saved patch with passing tests or successful integration.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Antigravity headless](https://antigravity.google/docs/cli/headless/), [Copilot SDK transport](https://github.com/github/copilot-sdk/tree/v0.1.32/nodejs), [MCP request cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).
