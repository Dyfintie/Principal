# Principal development handoff — 0.2.0

Repository: `/home/varun/principal`. Linux/WSL-first native coding-agent management plus an explicitly controlled MCP/CLI worker backend. Read source before relying on historical architectural claims.

## Product contract

The management TUI and browser retain native account/profile/session management. The separate worker backend accepts exact lead-agent assignments for Codex, Antigravity, and Copilot. The lead chooses profiles, models, prompts, follow-ups, cancellation, retries, validation, and integration. Principal never silently selects or substitutes accounts, retries inference, or applies patches.

Read [AGENT_CONTEXT.md](AGENT_CONTEXT.md), the [lead-agent guide](AGENT_SWARM_ORCHESTRATOR_GUIDE.md), and [worker architecture](AGENT_SWARM_ARCHITECTURE.md) before changing execution behavior.

## Source map

- `src/management/service.ts`, `daemon.ts`, `client.ts`, `store.ts`: private management RPC, SQLite WAL persistence, native-launch guards, observations, profile management.
- `src/management/workers.ts`: durable workers, exclusive profile leases, request deduplication, capability inspection, reconnect/recovery, explicit batch groups.
- `worker-model.ts`, `worker-files.ts`: schemas, lifecycle types, private control transport, cursor-based event reads.
- `worker-runner.ts`: detached provider owner, atomic runtime state, journal, deadlines, follow-up queue, turn artifacts.
- `worker-provider.ts`: Codex app-server execution, Antigravity persistent NDJSON, and Copilot SDK protocol-3 framed JSON-RPC. Existing `codex.ts` remains read-only telemetry/history inspection.
- `worker-process.ts`: identity-checked Linux pidfd cleanup for owned process trees.
- `worker-workspace.ts`: pinned retained Git worktrees, alternate-index binary patch capture, ownership-checked release. Older `worktree.ts` remains a separate compatibility helper.
- `src/mcp/server.ts`: concurrent stdio JSON-RPC and 12 explicit worker/batch tools, generated input schemas, request cancellation.
- `src/management/swarm-cli.ts`, `swarm.ts`, `swarm-model.ts`: CLI and compatibility batch wrappers; no quota scheduler.
- `antigravity-isolation.ts`, `providers.ts`, `shared-history.ts`, `observations.ts`: existing provider environments, native authentication/keyring isolation, history, and quota evidence.
- `src/management/web-server.ts` and `web/dashboard.html`: existing dependency-free HTTP/SSE management dashboard. No new worker dashboard is included.

## Operational invariants

1. Every new worker requires an exact profile ID, stable request ID, repository directory, and prompt. Unknown quota/authentication remains unknown; rejected authentication blocks dispatch. Standalone Claude controlled execution is unsupported. Copilot supports its current native configuration only, with a shared busy check across aliases; independent account isolation is unsupported.
2. A warm worker holds one exclusive profile reservation. Native launch checks share that reservation. Stop before starting another worker or removing the profile.
3. MCP disconnection and manager restart do not cancel detached workers. Reconcile runtime identities and journals; never restart inference automatically after an uncertain result.
4. Pending follow-ups pause on failure/cancellation. Same-profile resume uses the recorded native conversation and retained workspace. A new accepted follow-up explicitly continues the paused queue.
5. Worktrees start at recorded Git HEAD, excluding source uncommitted changes. Preserve the source dirty warning and actual baseline. Execution retains the existing unattended native permission policy; a worktree is not an OS sandbox.
6. Only structured native terminal success completes a turn. Correctness, test validation, artifact capture, and integration are separate facts.
7. Retain code after success/failure/timeout/cancellation. Release only a stopped, unreserved worker after final artifact capture. Unknown ownership or failed capture blocks destructive cleanup.
8. Never persist copied credentials, OAuth payloads, raw provider error bodies, or private reasoning. Preserve native authentication ownership and existing isolation behavior.

## Breaking migration from 0.1.5

Existing MCP configuration key `principal_swarm` and executable `principal-mcp` remain. Restart the Principal management daemon and reload the MCP connection after installing the new build. Existing native CLI invocations are independent; do not stop unrelated agents.

`principal_deploy_swarm` is asynchronous and requires a `request_id`; every task requires a distinct `profile_id` and `cwd`. Automatic provider routing, missing assignments, blocking deployment requests, and hidden account queues are rejected. Existing status/cancel tool names now use durable groups; cancellation also requires `request_id`. Results expose artifact references instead of giant inline patches. See the lead guide for complete examples.

## Build and verification

Use a Node 24+ runtime whose ABI matches the installed `better-sqlite3` addon. In this checkout the matching runtime is:

```sh
/home/varun/.local/share/fnm/node-versions/v24.22.0/installation/bin/node scripts/workflow.mjs check
/home/varun/.local/share/fnm/node-versions/v24.22.0/installation/bin/node scripts/workflow.mjs test
```

Ordinary `npm test` uses the Node selected by the shell; an incompatible native addon fails before tests. Do not silently rebuild dependencies or change the user's runtime configuration to hide that distinction.

The prior 0.1.5 baseline was 237 passing tests. The 0.2.0 full suite passed **259/259** locally with Node 24.22.0. New tests use credential-free native-protocol fixtures, isolated state, and disposable Git repositories. They exercise routing rejection, global reservations, steering, queued turns, cancellation, descendant cleanup, restart/recovery, retained code, and MCP concurrency. See the [verification record](WORKER_CONTROL_VERIFICATION.md), including credential-free protocol checks and a separate authenticated Copilot MCP test of file edits, follow-ups, active cancellation, and same-session resume.

Live provider inference, model access, independent Antigravity keyrings/login/refresh, and real history continuation are separate validation boundaries. Never describe local fixture success as live-provider verification, installation, commit, push, or deployment.
