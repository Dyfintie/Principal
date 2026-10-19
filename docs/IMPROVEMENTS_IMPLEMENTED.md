# Improvements review and implementation

Reviewed 2026-10-11 against `IMPROVEMENTS_ROADMAP.md`. The current product is the native management layer; the old task-execution/Docker architecture remains separate.

## Decisions

| Proposal | Result | Evidence and boundary |
| --- | --- | --- |
| Codex 401/authentication desynchronization | Implemented | `CodexRpcError` classifies wrapped HTTP 401 even when JSON-RPC code is `-32603`. Refresh and inspection downgrade cached authentication only on an authentication rejection, record safe observations, and expose sign-in remediation. Network failures preserve last-known authentication and become an unreachable observation. Native sign-in remains user-controlled. |
| Live diagnostics | Implemented | `/doctor` and `/diagnostics` request `diagnostics.report`: tool availability, native capability confidence, isolation prerequisites, host keyring lock evidence, and bounded per-profile native inspections. Local Codex JWT expiry is metadata only, never proof of authorization. Other credential formats remain unverified instead of reading private keychains. |
| Version compatibility | Implemented with tighter rules | Known versions retain their evidence. Stable same-major/minor patch families at or above the inspected baseline can use integrations, labelled unverified until checked. Codex account and limits response envelopes are checked. New major/minor families are not automatically admitted. Antigravity history eligibility relies on actual SQL schema and safety checks; opaque payload/native continuation compatibility stays experimental. |
| Monolithic TUI | Implemented incrementally | `dashboard.tsx` is the public facade. `ui/DashboardApp.tsx` owns orchestration/keyboard routing; views, palette, modal components, profile workflows, terminal sizing and snapshot polling are separate modules. Interaction semantics remain slash-based and provider-tabbed. |
| Storage scans and retention | Implemented without schema replacement | Existing records/schema/version remain intact. Expression indexes cover resource windows/timestamps, invocation profiles and active bindings. Binding operations use indexed queries, statements are cached, and latest resources are chosen by observation timestamp. Hourly pruning removes resource observations older than seven days and only empty old external sightings; profiles, conversations, native files, owned invocations and bindings are preserved. WAL checkpointing is passive. A full relational migration is deferred until measurements justify its migration risk. |
| Non-destructive attachment | Implemented for new persistent launches | With tmux installed, interactive launches outside an existing tmux terminal use persistent mode by default. Launch form offers Automatic/Persistent/Direct. Jump attaches to the exact running pane after checking the owned wrapper identity and pane PID. Ctrl+b, then d detaches; the worker, native agent, private keyring and callbacks remain alive. Existing direct/external processes cannot be retrofitted; their confirmed stop/resume fallback remains available. |
| Antigravity browser opening | Implemented as a limited host browser relay | The private runtime prepends an `xdg-open` shim. A private host-side socket accepts only bounded HTTPS URLs for `accounts.google.com` or `antigravity.google`, then invokes the host's real opener without a shell. Credentials/keyring access remain on the private bus. Direct desktop portal calls that do not use the shim are not proxied; unsupported URLs and absent desktop support still require native printed-link handling. |

## Authentication and telemetry behavior

Provider errors are classified in memory; raw messages/data, tokens, OAuth URLs and response bodies are not stored or printed. A stored `observationError` contains a safe category, reason, timestamp, protocol code/status when known, and retry time. A 401 is described as rejected authentication, not assumed token expiration. Successful native inspection clears the old refresh cooldown so usage can recover after sign-in.

The daemon still attempts supported resource refreshes every 60 seconds with two profiles at a time and a shared in-flight collection job. Failure backoff remains five minutes up to one hour. One-minute scheduling cannot make revoked credentials valid or poll providers that only expose native callbacks. Antigravity continues to show only Gemini weekly and Claude weekly usage bars.

## Persistent terminal/security boundaries

`tmux.ts` starts sessions on Principal's private socket with a sanitized server environment and no user tmux configuration. A one-shot mode-0600 socket transfers each launch request and caller environment in memory to `tmux-worker.ts`; secrets are not serialized to files or placed in tmux arguments. The worker restores the caller environment before importing modules that resolve state directories, then prepares/registers its own invocation and launches the native tool. Session metadata contains only the private tmux socket and random session name. No arbitrary session is attached and no external process is stopped.

The browser bridge is hosted by that launch worker, so it survives detaching the management terminal and closes after native exit. This is account separation, not a sandbox against malicious code running as the same OS user.

## Verification and remaining live checks

Use `node scripts/workflow.mjs build`, `check`, and `test`; the workflow selects the recorded Node 24+ runtime. Added tests cover wrapped 401 sanitization, auth recovery, network errors, valid-but-rejected JWT evidence, patch compatibility, indexed pruning, future Antigravity schema rejection, real tmux attachment/detachment with an unchanged synthetic native PID/profile, and host browser relay with a fake opener. No real login, browser OAuth, inference or user-agent termination is part of these tests.

Real Codex authorization recovery requires native sign-in if the provider continues returning 401. Two-account Antigravity OAuth/refresh and cross-account history continuation still need user-controlled live verification. A matching SQLite schema is insufficient to claim that unknown protobuf versions are resumable. New persistent sessions should be exercised with each installed provider's native TUI; synthetic terminal tests do not establish provider-specific behavior.

Official interface references checked 2026-10-11: [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [tmux sessions and attachment](https://github.com/tmux/tmux/wiki/Getting-Started). Provider-specific capability evidence remains in `providers.ts` and the existing profile/history documents.
