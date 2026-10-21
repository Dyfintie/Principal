# Controlled-worker verification — 0.2.0

Verified locally on 2026-10-21. Automated results are local to the workspace. The live Copilot MCP check below separately records authenticated execution; no package publication or Git commit is implied.

## Automated checks

The full test workflow passed **259 tests, 0 failures, 0 skipped**, using Node **24.22.0** with the matching installed SQLite addon. The prior baseline was 237 passing tests. No dependency rebuild or runtime configuration change was required.

```sh
env PATH=/home/varun/.local/share/fnm/node-versions/v24.22.0/installation/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin npm test
```

The full workflow compiles TypeScript and checks runtime scripts before executing tests. `npm run check` and `git diff --check` are also part of final local verification.

The new tests use credential-free native-protocol fixtures and disposable repositories/state. They cover:

- Exact assignments, request deduplication, competing clients, and exclusive profile reservations.
- Successful native help written to stderr, matching the installed Antigravity CLI.
- Codex steering with the expected active turn ID; Antigravity and Copilot follow-ups queued between turns.
- Copilot framed JSON-RPC with Unicode output, matching-session filtering, terminal-idle semantics, native permission responses, sanitized authentication failures, malformed framing, exact-session resume, rejection of alternate/isolated configurations, explicit Copilot batches, unchanged provider defaults, and incompatible protocol rejection before prompt delivery. Copilot profile aliases share busy checks.
- Paused queues and same-profile native resume, including a deterministic pause during the new runner's launch window to prove old stopped state cannot free its reservation.
- The CSES failure pattern: one immediately failing profile and two silent workers remain individually observable and cancellable.
- Malformed NDJSON, normal exit without a terminal result, hard deadlines, and typed sanitized failures.
- Cancellation while a steering acknowledgement is missing, without blocking behind that request or automatically replaying the instruction.
- Resistant owned descendants, unrelated-process preservation, lost runners, and explicit ownership-safe recovery.
- A real management daemon restart and MCP disconnection while a fake native worker stays alive; the worker keeps its profile/process identity and accepts steering after reconnection.
- Large output split across bounded event pages without truncation; final responses without streamed deltas.
- Retained patches containing untracked/binary files, deletions, and worker commits, without changing staging.
- Failed final patch capture preventing worktree deletion; explicit release after repair.
- Removal of automatic routing, blocking deployment, duplicate profile assignments, and hidden batch queues.

## Installed Codex protocol check

The installed Codex CLI **0.163.0** was also exercised with its native HOME preserved and a disposable, credential-free `CODEX_HOME`. API-key/token environment overrides were removed for the check. No authentication files were copied and no inference was requested.

The stdio app-server accepted `initialize`. Both `turn/start` and `turn/steer` accepted the new text-input wire shape (including `text_elements` and a client message ID) and returned JSON-RPC **-32600**, classified as **thread-not-found**, for the deliberately nonexistent all-zero thread ID. Raw provider error bodies were not retained. This checks launch/handshake and parameter routing, not model access or successful inference.

## Antigravity capability-probe correction

A live MCP inventory check exposed a probe bug: the installed `agy --help` exits successfully and writes its help to stderr. The probe now reads both stdout and stderr. A regression test covers this, and the corrected local probe recognizes streaming input/output, conversation resume, model overrides, and advertised effort values. No model inference was requested. The already-running management daemon must restart to load the corrected probe; account visibility alone does not prove live execution or model access.

## Installed Copilot protocol check

Copilot CLI **1.0.95** was launched as an SDK stdio server with a disposable, credential-free HOME/configuration and token overrides removed. A native `ping` reported protocol version **3**. No session was created and no valid-session inference was requested. The adapter follows the first-party [SDK protocol implementation](https://github.com/github/copilot-sdk/tree/v0.1.32/nodejs), including session events and broadcast permission responses. Native `session.resume`, `session.send`, and `session.abort` accepted the parameter shapes and returned **-32603 session-not-found** for a deliberately nonexistent all-zero session ID. Raw provider errors were not retained. Its transport/session contract is covered by credential-free fixtures; this is separate from live model access.

## Live Copilot MCP control verification

On 2026-10-21, the existing MCP connection initially reached an old daemon that rejected Copilot execution. With no controlled workers running, the management daemon was gracefully restarted from the built, locally linked checkout. Unrelated native agents were not signalled.

A live authenticated Copilot CLI 1.0.95 worker was started through `principal_start_worker` on the explicitly selected native profile in a disposable Git repository. Model and effort overrides were omitted; the actual provider-selected model was not reported and remains unknown.

The first attempt exposed a real permission bug: the adapter returned the event-result kind `approved` instead of the decision kind `approve-once`. Native tools rejected the response, while the assistant still finished its turn with a failure explanation. This illustrates why provider completion alone does not prove task success. The adapter and strict permission fixture were corrected using the first-party [SDK permission-contract correction](https://github.com/github/copilot-sdk/pull/1315). The full suite passed again: **259 tests, 0 failures**.

After correction, worker `62983f6b-3c05-4886-8b2f-e8ee7567f1d2` demonstrated:

- Native-session resume, followed by an actual tool-created `verification.txt` and streamed `COPILOT_CONTROL_OK` response.
- A `next_turn` follow-up that appended `FOLLOWUP_OK`. Both exact file contents and the saved patch were independently checked; the source checkout stayed unchanged.
- Cancellation while a native `sleep 30` tool was running: the turn became cancelled, the worker stopped, its reservation cleared, and its recorded command descendant no longer matched a live process.
- Resume on the same native session ID after cancellation. A follow-up recalled the original unique marker from conversation history without tools and returned `RESUME_OK`.

The test worker was stopped and explicitly released after final patch capture. Durable worker events and artifacts remain in Principal's private local state. This verifies the current native Copilot login and default model path, not every model, effort, account configuration, or provider.

## Remaining live boundaries

Live Codex steering/resume, Antigravity native streaming/resume, arbitrary model/effort entitlements, independent keyrings, login/refresh, and cross-account history behavior remain unverified. Copilot live execution/resume is limited to the check above. Existing provider authentication/history boundaries remain in place. Fixture success, native protocol acceptance, a completed turn, saved changes, correctness, and integration are separate claims.

Repository tests alone do not update a running service. The current local daemon was restarted for the live Copilot check; future upgrades still require rebuilding and restarting management, with MCP reload when tool definitions change. Native agent sessions are independent; do not stop unrelated agents. See the [lead guide](AGENT_SWARM_ORCHESTRATOR_GUIDE.md) for the breaking batch migration and retained-worktree lifecycle.
