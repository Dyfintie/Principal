> Historical execution backend documentation. The current public TUI is account/session management only; chat and task execution described below are not exposed. See [native management](NATIVE_MANAGEMENT.md).

# Interactive sessions

Principal opens in the directory where you launch it. Type a message immediately;
no project-selection command or Git commit is required. A Git repository, an unborn
repository, a repository subdirectory, and an ordinary folder are supported.
`/project /path/to/folder` inside the TUI changes the selected directory.
Startup is local and lazy: project sessions begin on an explicit message.

For committed repository roots, staged changes, unstaged changes, and nonignored
untracked files are captured without touching the host index. Other directories
are mounted read-only for conversation and exploration. Before delegated work,
Principal creates a private Git-backed snapshot without initializing Git or
creating commits in the host directory. Reviewed changes are applied as ordinary
working-tree file updates. Snapshots exclude ignored files, dependency caches,
and standard credential/configuration directories; unsafe or oversized artifacts
remain rejected.

Run `principal`, then enter these commands inside the TUI:

```text
/pools create development --accounts codex-free-1,codex-free-2,antigravity-1
/pool development
/lead antigravity-1
/sessions --saved
/resume SESSION_ID
/conversations history SESSION_ID --after 0
```

The chat UI supports `/project PATH`, `/accounts`, `/pool [NAME]`, `/model [ID]`, `/workers [SESSION_ID]`,
`/usage`, `/sessions`, `/history`, `/context`, `/compact`, `/review`, `/apply`,
`/refresh`, `/stop`, `/resume`, `/answer ID TEXT`, `/help`, and `/exit`.
`/lead ACCOUNT confirm` explicitly approves a change across providers. Without
`confirm`, a cross-provider lead change is rejected. Native Codex questions use
`/answer native:ID JSON`, where JSON maps question IDs to `{ "answers": ["..."] }`.
Type `/` for command suggestions; keep typing to filter, use Up/Down to select,
Tab to complete, and Escape to dismiss. Enter completes a partial command and
executes an exact command. The input box shows the real terminal cursor. One terminal row is reserved so
redraws, polling, and resizing preserve its position. Narrow terminals show fewer
command suggestions, navigable with Up/Down. Long input scrolls horizontally to
keep it visible; Unicode cell widths and multiline drafts are supported.
Shift/Alt+Enter adds a newline. Outside suggestions,
Tab changes views. Page Up/Down scroll one screen; Up/Down scroll one row when
the command menu is closed. Mouse-wheel and touchpad gestures scroll the current
view. Home/End jump to the beginning/latest output. The footer reports the visible
row range, and terminal mouse mode is restored when you leave or enter sign-in.
The header shows the active pool, account
label, provider, model, and status; conversation and input have distinct borders.
`/exit` and Ctrl+C detach; `/stop` interrupts. Failed submissions retain the draft.

## Principal and native modes

`principal` opens Principal mode by default. Switch with `/mode native` to open
**the selected lead account's own Codex or Antigravity interface**. `/mode` shows
the current Principal mode and `/mode principal` selects the unified interface.
Exit the native provider using its normal exit command or keyboard shortcut to
return to the same Principal session. Principal commands are available again
once the native interface has exited; they are not intercepted inside that UI.

Select the pool/lead and enter native mode inside the same TUI:

```text
/pool development
/lead ACCOUNT_LABEL
/mode native
```

Use an enrolled account from the chosen pool. Without an explicit `/lead`, direct native
launch chooses an available ready account in that pool. Native first-use setup,
terms, data-sharing choices, commands, permissions and model controls belong to
the provider. Principal does not accept those choices for the user. Codex uses
its native TUI with `--no-daemon` because the runtime contains standalone binaries;
Docker provides its sandbox. Antigravity runs its normal interactive CLI. Neither
receives Principal prompts, JSON schemas, nor orchestration control messages.

Native mode mounts the launch directory directly, masks Principal-managed
credential state/configuration when they lie inside it, and allows the provider to
change its files and Git index. It does not use Principal's isolated edit/review
workflow. Principal mode continues to delegate edits into private copies and
require reviewed application. If native mode changed the host directory, use
`/refresh` before continuing project work in an existing Principal session;
review again before applying private changes.

The provider still runs inside the account's isolated Docker runtime. Normal
project paths retain their absolute directory name; paths overlapping runtime
directories receive a stable, unique guest path so different projects keep
distinct native histories. Host tools and files outside the mounted directory
are not automatically available inside that runtime.

Conversation histories remain separate: Principal retains its canonical messages
and native histories stay in that account's encrypted provider home. Native
settings are preserved separately from Principal-generated runtime policies.
A selected Principal model is forwarded when switching from that session;
direct native launch otherwise uses the provider's saved preferences/default.

Both modes share account leases and inference slots. Switching requires idle or
stopped Principal work; use `/stop` if necessary. Background probes finish before
launch, and idle warm conversations are parked. Native attachment heartbeats
survive daemon restart; abandoned attachments are stopped and snapshotted without
replaying work. Unconfirmed stop retains the lease. Native terminal descriptors
are reopened independently so Docker cannot change Ink's descriptor blocking
flags; native exit saves account state before restoring the Principal UI.

## Persistence and recovery

The daemon's lifetime flock protects schema migration. Schema 1 is checkpointed
and backed up to `principal.sqlite.pre-sessions` before the additive schema 2
migration. Existing accounts, credentials, pools, runs, and batch RPCs remain.
CLI session RPCs negotiate transport protocol 2; batch protocol 1 remains supported.
Do not downgrade a daemon against a schema 2 database. Restore the pre-migration
backup only after stopping the daemon and retaining the newer database and vault;
that backup does not include later sessions or account generations.

Input admissions and client IDs are durable before dispatch. Repeated identical
client IDs return the original receipt; different content with the same ID is
rejected. The inbox holds 32 pending messages. Mutations are serialized per
session; all runtime operations share the existing account lease table.
Steering and answers record their delivery intent before transport. Ambiguous
transport failures require review rather than replay. A daemon restart marks
in-flight dispatches `needs_review`, snapshots and stops residual containers
where possible, and retains leases whenever Docker cannot attest cleanup.
Queued, undispatched input survives a restart. Resume does not replay uncertain
turns; inspect their history and submit a new instruction if needed.

The transcript stores typed text, questions, tool states, results, context
operations, and artifact references. Token fragments are transient display data
and do not advance the durable event cursor. Large Principal-owned results have
200-line / 8-KiB previews, hashes, session-scoped retrieval, and bounded searches.
Child histories project batch events and link their task, account, native session,
accepted patch, and validation records. Worker results cannot grant permissions.
Instruction-file and operational-config changes from workers are rejected until
an explicit admission workflow is added; they cannot silently become lead prompts.

## Add accounts from chat

Type `/enroll codex` or `/enroll antigravity`. Principal chooses an unused label automatically.
Codex opens the browser and shows its device code; Antigravity hands the terminal
to its native Google sign-in flow. Follow the provider's sign-in instructions.
Principal verifies the identity, encrypts credentials, adds the account to the
active pool without replacing existing members, and returns to the same chat.
The first successful account creates the default pool when needed. Active runs
keep their frozen account set; settled sessions update their pool for future turns.

Labels are optional: `/enroll codex personal` or `/enroll antigravity work`. A cancelled,
unidentified sign-in can be retried without creating another account record.
Ctrl+C during sign-in cancels and returns to chat after native cleanup; unconfirmed
container stops retain their lease. `/accounts` lists connected accounts and
`/usage` shows their remaining allowances. Existing CLI account-add and reauth
commands remain available.

## Account usage

`/usage` displays meters for every enrolled account, including accounts outside the
active pool. Each meter shows reported remaining allowance and a reset countdown.
Antigravity has separate Gemini and Claude/GPT weekly meters; other reported
buckets remain separate. Codex uses its reported window durations. Missing values
are shown as unknown; stale observations are labelled as last reported values.
Use Page Up/Down to scroll. `/usage --refresh` updates eligible idle accounts;
busy account leases are preserved. `/usage` is the unified usage view; shell usage commands are removed.

## Native conversations and context

Codex uses app-server threads, native steering, interruption, question answers,
and native compaction. Antigravity keeps a stream-json process open across turns,
waits for each result, and restores through `--conversation`. Principal never sends
Antigravity `control_request`, `control_response`, or CLI slash commands into the
conversation stream. Read-only Docker mounts enforce the lead's project access;
Principal does not force Antigravity's native planning workflow. Antigravity
conversational leads use `--effort medium`; delegated workers retain their native
reasoning setting. Greetings and general questions avoid unnecessary file tools.
The conversation shows elapsed response time, real provider/tool activity, and
account waiting. Internal structured control JSON is hidden until the validated
human-facing reply is available. Activity transitions are deduplicated across
text fragments, and cumulative usage is not presented as context occupancy.

[Codex protocol reference](https://learn.chatgpt.com/docs/app-server) and
[Antigravity headless reference](https://antigravity.google/docs/cli/headless/)
inform the drivers; runtime behavior remains pinned to tested versions.

Portable checkpoints retain the cumulative objective, corrections, decisions,
active work, and references supplied through validated lead responses, plus recent
canonical messages. Coordinator constraints and instruction hashes are built from
trusted state on every dispatch, independently of the model's summary. Root
`AGENTS.md` and `principal.config.json` are hashed at admission and reconciled
between turns; temporary read failures preserve the previous observation.

Principal's supplied continuation target is at most 16,000 estimated tokens,
reduced when a smaller native model window is reported. Summary material targets
4,000 tokens and recent material targets 8,000, with constraints and current input
sharing the remaining budget. The estimate uses UTF-8 bytes; it is not native
context occupancy. Cumulative native usage is shown separately. Cached tokens are
not subtracted from input occupancy estimates. Native hidden prompts and internal
history remain provider-owned.

Automatic native compaction uses reported input/window telemetry plus supplied
context estimates where available. Account handoffs and context-budget rebuilds
use portable checkpoints. Failed native compaction does not replace the previous
checkpoint. A typed context-overflow error permits one rebuild only when no tool
effects were observed. Three identical command failures without progress interrupt
execution. Context retrieval loops are bounded. Maintenance shares the account
lease and idle runtimes release after 60 seconds or when other work is waiting.

Version 2 credential archives stream authenticated AES-GCM ciphertext to durable
files and authenticate to a private temporary plaintext file before restoration.
Legacy version 1 JSON vault files remain readable. The 256-MiB archive bound and
write-before-database-pointer generation ordering remain. A failed archive never
advances the durable account generation.

## Delegation and applying changes

The lead can respond, ask a question, delegate, await workers, or retrieve context.
Edits become existing isolated batch worker tasks, represented as child sessions.
Tasks are checked against the frozen approved account pool, dependency graph,
path policy, and 20-task bound. Explicit worker account pins remain pins. Recursive
and unmanaged delegation are disabled by Principal policy and Codex's native flag.
Malformed completed worker reports can receive up to two checkpoint-preserving
report corrections; these do not authorize redoing external actions.

Independent workers run concurrently through the existing scheduler. Principal
checks their patches and runs configured validation before integrating them into
the private session workspace. Following turns see those private changes. Model
IDs are checked against native catalogs. Routing preserves the 10% quota reserve
and 300-second freshness limit. With no model pin, Antigravity's unscoped reported
buckets are all considered conservatively; a pinned model with unknown membership
remains ineligible. Unknown quota is not enabled by the interactive interface.

`/review` compares the private agent changes to the captured user baseline and
records a patch hash and workspace version. `/apply` requires this review and an
idle or explicitly stopped session. It rechecks host HEAD, index bytes, and the
file manifest, applies only agent changes, and preserves HEAD and the index.
Backups and a durable replacement journal support partial-apply recovery. Recovery
pauses if affected host content has drifted rather than overwriting newer edits.
After success, the baseline advances. `/refresh` captures the newer host state,
reconciles private changes, and invalidates the previous review. Conflicts preserve
the prior session workspace.

Unresolved merges, submodules, nonregular artifacts, Git
control-file changes, unsafe paths, and oversize files are rejected. Ignored files
are excluded and cannot be overwritten through an agent add.

Historical batch `runs.apply` still fast-forwards a clean repository. Runs owned
by interactive sessions reject that endpoint and require `sessions.apply`.
`/conversations prune ID` explicitly removes stopped/inactive session history
and artifacts. Retained session artifacts are never automatically pruned.

## Evidence and remaining gates

Automated and live evidence is recorded in `INTERACTIVE_EVIDENCE.json`. The live
scripts use temporary repositories and a separate `session-smoke` pool, preserving
the user's existing development pool. They consume the enrolled accounts' quotas:

```sh
node scripts/session-smoke.mjs [codex-free-1|antigravity-1]
node scripts/session-workflow-smoke.mjs
python3 scripts/chat-smoke.py SESSION_ID
```

Fixture tests establish protocol and failure behavior, not vendor entitlement or
live quota exhaustion. A live headless read outside the scoped workspace was denied. Full release evidence
still requires real exhausted-quota handoff, native interactive-question denial,
OAuth refresh, broader live crash/container failure injection, and concurrent isolation
across two Antigravity accounts. Only one Antigravity account is enrolled here.
Native provider failures retain evidence and require review rather than inventing
completion. Session forks, message editing, host undo, remote HTTP, plugins,
images, and additional providers remain deferred.
