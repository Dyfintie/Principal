## Paginated local history compatibility import — 2026-10-10

Fixed the format gate that rejected the user's native paginated histories. Native app-server paginated fork remains unsupported in Codex 0.162.1. Principal now changes the metadata flag only inside a credential-free temporary snapshot, obtains a native fork identity, then preserves the complete original history body byte-for-byte beneath that fresh header. This handles both native-history loading into A and subsequent A-to-B copies. Native reserialization had dropped newer event fields, so complete body preservation also applies to legacy copies. Source files, profile logins and configuration remain separate. No inference is requested.

The copy rejects unknown modes, mismatched paginated metadata, unfinished turns, unsafe files and unsupported versions. Validation: 166/166 tests passed, including paginated body preservation through A-to-B copying and metadata mismatch rejection. Legacy and paginated native synthetic discovery, loading, onward copying and resume both passed. Eight completed native conversations were verified through temporary profiles without printing their contents. After reloading the manager, the failed load into codex_main was retried: nine of ten conversations loaded successfully; one unfinished source turn was skipped. Originals and logins were retained. Implementation remains local and uncommitted.

## Loading native Codex history into empty profiles — 2026-10-10

`/profiles` → Codex offers **Load existing Codex history** (Shift+I). It previews native stored conversations across all projects and active/archived history, then copies them into the selected profile after Enter. Loading reuses the verified native fork mechanism: complete stored records are checked, new conversation identities are registered to the destination, and logins/configuration stay separate. No native source account registration is required. Per-conversation requests avoid a single long batch timeout; progress and partial failures are visible. Saved source provenance deduplicates repeated loads. Finishing an active source turn and retrying loads only the remaining conversations. The source snapshot is not automatically synchronized afterward.

**h** now explicitly means showing history already inside a profile. The new loading action hydrates an empty A from the default native directory; the existing Shift+C action then copies A's conversations into B. The supported scope now includes Codex 0.162.1 legacy and paginated local JSONL history; repository files and external attachments are not copied. Missing project directories and unsupported or unfinished history are reported without replacing credentials or existing history.

Validation: 164/164 tests passed, including history loading, retry deduplication, overlapping requests, managed source protection, and real PTY preview/cancel navigation. The TypeScript build and formatting checks passed. The installed Codex binary discovered temporary synthetic native history, loaded it into A, copied it onward into B, and resumed B without inference or login. No real user conversation has been loaded automatically. Changes remain local and uncommitted.

## Independent Codex conversation copies — 2026-10-10

`/sessions` offers **Copy conversation to another profile** (Shift+C) for imported Codex conversations. Users choose the destination profile and project directory. The service snapshots a completed local rollout into a credential-free temporary directory, invokes the official native fork operation to allocate a new identity, preserves every original non-header byte beneath the fork header, publishes the independent file, and verifies native recognition. Each copy receives a new conversation ID and a destination-bound registry entry. Source history and both credential stores stay separate. No inference or native login is requested. Profile removal/authentication changes and new launches wait for an in-progress copy; unsupported formats and incomplete/active source sessions fail with actionable messages.

Validated scope: Codex 0.162.1, OpenAI-backed legacy and paginated local JSONL history, up to 64 MiB. Other providers and unknown storage modes are unsupported. Repository files and external attachments are not copied; selecting a separate worktree permits independent edits.

Validation: 158/158 tests passed, including complete record retention, credentials unchanged, independent continuation, unsupported format/version rejection, rollback, filesystem isolation, registry binding and real PTY copy-form navigation. The installed native binary independently recognized and resumed a synthetic cross-profile copy containing user/assistant messages, tool output and compaction history, with no inference requested. TypeScript build passed. Changes remain local and uncommitted; no user conversation was transferred automatically.

## Provider profile tabs and simpler sign-in — 2026-10-10

`/profiles` now uses the same provider order and Tab/Shift+Tab navigation as `/usage`. Native profiles, cached accounts and external process observations are filtered to the selected provider; changing providers resets account selection. Provider switching remains available while observations load, without restoring section navigation tabs.

The primary add-account action asks only for a profile name, selects the current provider and supported configuration isolation, then hands off to native sign-in. Existing native logins have a separate `a` action that avoids unnecessary sign-in. Directory and configuration choices remain in explicit advanced setup (`Shift+N`). Copilot and Antigravity use the native account selection boundary rather than inventing independently stored logins. Missing executables produce an installation message. Sign-in and native launch return to the originating provider tab; the signed-in profile is selected automatically so `s` launches that profile.

Validation: 151/151 tests passed. Real PTY checks cover provider filtering, forward/backward wraparound, one-field name validation, missing Cline installation, existing-login reuse, advanced setup, a synthetic native Codex login with a new isolated configuration, and selecting the new account after returning to Profiles. TypeScript and formatting checks passed. Native account credentials and running user agents were not modified; actual provider sign-in remains user-controlled. The installed local Principal uses the updated build. Changes remain local and uncommitted.

## Account inventory reset and archival — 2026-10-10

Cleared three native profile registrations and archived six legacy account references from the unified inventory, retaining Cline and Copilot. Native credentials and directories, historical runs/sessions, and running native processes were preserved. Private metadata backups were created before resetting registrations. Removed native configurations remain excluded from automatic discovery; archived legacy IDs are stored in management settings and filtered from both live-service and cached inventory sources. Re-adding native configurations uses the regular profile form.

Added a scoped internal `accounts.dismiss` operation for archival without invoking the legacy account removal flow, which would revoke credentials and reject historical references. Validation: 151/151 tests passed, including persistent archival, duplicate ID handling, malformed ID rejection and retained profile/history checks. Live inventory verification after refresh showed only Cline and Copilot registrations, no visible legacy accounts, and two external process observations retained. Changes remain local and uncommitted.

## Native profile editing, removal and launching — 2026-10-10

`/profiles` exposes add, rename, remove, authentication inspection, native sign-in, native launch, history import and details through its action menu. The screen shows shortcuts for common actions. Rename keeps the stable profile ID, credentials, configuration directory and history links; asynchronous authentication/usage updates preserve concurrent name edits.

Removal requires typing `remove` in the TUI. It hides the profile using a retained registry marker and preserves credentials, directories, usage observations and session history. Active or uncertain invocations and in-progress quota probes block removal. Automatic discovery respects removed configurations, including retries from stale discovery snapshots; explicitly adding the existing directory restores the original profile ID with authentication awaiting inspection. Cached enrolled accounts and unassigned external sessions remain read-only.

Native launching selects a profile, project directory and optional native arguments, and passes the selected configuration to the installed CLI. Launch forms resolve the selected profile to its stable ID. Native tools handle expired authentication; Principal returns after exit. Ctrl+U clears editable text fields. Usage refresh now reports “Usage updated. See each provider for available balances.” Unsupported balances remain explicitly unavailable in provider details.

Validation: 150/150 tests passed, including a delayed native-quota rename race, active/probe removal guards, discovery suppression/restoration, credential-file preservation, and real PTY add/rename/remove/launch workflows. The terminal fixture verifies the selected native configuration and project directory and returns to management. Formatting and TypeScript checks passed. The local installed Principal uses the updated build; the management service was reloaded and its new validation RPC verified without changing user profiles or signalling native agents. Changes are local and uncommitted.

## Profile validation and shared account inventory — 2026-10-10

`/profiles` now uses the account inventory shared with `/usage`: native configuration profiles, cached enrolled accounts and active sessions without a profile binding. Only native profiles receive authentication, login and launch actions. Cached and unassigned entries provide read-only details and explicitly avoid claiming a verified login or credential ownership. Native profiles show active invocation counts and supported identity observations.

An empty profile label now produces “Enter a profile name, such as Personal or Other.” The form retains its fields, focuses the label and remains open on submission errors. Server-side empty-name rejection occurs before directory or profile creation.

Validation: 147/147 tests passed; terminal regression checks cover blank-name correction and cached account details without a native launch action. Live inventory inspection found five native configurations, six cached enrolled accounts and two active unassigned sessions at the time checked. No credentials were copied, no cached entries were converted into fake native profiles, and native sessions were not terminated. Changes remain local and uncommitted.

## Slash-only view navigation and Cline display — 2026-10-10

Removed the Sessions/Profiles/Usage/Diagnostics navigation bar and numeric/Tab section switching. Views open through `/sessions`, `/profiles`, `/usage`, and `/diagnostics`; `/doctor` remains an alias. Tab still switches providers in Usage, completes slash suggestions and moves through form fields. Section commands and exit stay responsive while observation refresh is busy; switching views during a refresh displays cached content until the current operation completes.

Cline retains “Free · no software subscription quota” and separate unknown model/provider usage. Unsupported Cline quota collection no longer produces repeated per-profile notices or global refresh warnings. No fake quota records are created. Provider credentials, native processes and existing records remain unchanged.

Validation: the full suite passed 145/145. Real PTY checks use slash view navigation, provider switching and a delayed synthetic usage response to exercise navigation while busy. Changes remain local and uncommitted.

## Native observer refresh warnings — 2026-10-10

Claude and Antigravity are callback-based usage integrations. Resource refresh no longer treats the absence of polling APIs as a missing-callback warning. Profiles awaiting quota data show a waiting message; external observations retain their original attribution and timestamps. Read-only inspection confirmed both local statusline settings reference Principal’s callback, and Antigravity had already provided external quota observations. Reloading revealed that Claude Code had updated to 2.1.296; its installed help and the current official statusline/hook schemas were checked before enabling compatibility. Unknown versions now report their actual version gate rather than suggesting missing setup. Provider settings and native sessions were not modified.

## Cline profiles, Copilot quota, and clearer authentication status — 2026-10-10

Cline now appears in the TUI add-profile form and native discovery. Installed 3.0.70 help validates `auth`, `--config`, `--data-dir`, `--tui`, and `--id`; login and launch use matching configuration/data paths. Principal does not read credential files or claim independently refreshed multi-account authentication. Cline usage collection and identity inspection remain unavailable.

Copilot account quota now uses the first-party `account.getQuota` interface. The installed CLI updated to 1.0.95; read-only authentication and quota queries passed against it, without creating a session or running inference. Quotas display named provider buckets, remaining percentages, native entitlement units and reported reset dates; no unverified AI-credit conversions. Unknown authentication now reads “not verified,” with an explicit Antigravity explanation: lack of a validated auth-status query is not evidence of logout.

Validation: `npm test` passed 141/141 and `npm run check` passed. Synthetic native commands verify matching Cline directory arguments and resume IDs; quota fixtures verify framing, field allowlisting and invalid-percentage rejection. Live Cline login and two-account refresh were not performed. Workspace changes remain uncommitted and unpushed.

# Compatibility and implementation status

## Default management command box and session decluttering (2026-10-10)

The command box is visible on the main views by default. Typing `/` shows a
management-only command catalog, with prefix filtering, arrow-key selection,
Tab completion, and Enter submission. Idle Tab navigation still switches views
or usage providers; forms keep their own input controls. Plain task execution
remains unsupported.

The observed Antigravity clutter consisted of 56 ended generic external-process
sightings. The normal tree now excludes such ended sightings without deleting
records, altering native authentication, or stopping processes. Live external
agents, owned launches, saved conversations, and user-renamed entries remain
visible. Archived observations can still be inspected in the archive view.

Verification: all 139 tests passed, including real PTY startup with the default
box, slash suggestions, arrow selection, Tab completion, account-view execution,
usage-provider cycling, and session-tree filtering without record deletion.

## Copilot account and native-process detection (2026-10-10)

The native npm launcher delegates to a platform binary, so matching only the
launcher missed independently running Copilot agents. Installation discovery now
resolves the installed package entrypoint without executing loader code. Process
detection matches exact paths, suppresses duplicate wrapper rows, excludes SDK
helpers, and preserves unknown account ownership for external agents. Managed
launch/login uses the native executable to retain the correct process handle.

Copilot authentication inspection now uses first-party SDK `auth.getStatus`
over bounded stdio JSON-RPC. Profiles and account/usage inventory show the current
GitHub login and authentication state without reading credential files or
creating agent sessions. Subscription quota and multi-account pinning remain
unsupported. Authentication is distinct from a running CLI invocation.

Live verification: the installed 1.0.89 CLI returned authenticated status and an
account name. The management service was reloaded and the verified observation
was stored; no native agent was stopped or login changed. No active Copilot
process was observed at verification time. Account names and credentials are
omitted from this record. Synthetic coverage includes npm wrappers, native
processes, helper exclusion, split protocol frames, and secret-field removal.
All 137 automated tests passed; TypeScript compilation and formatting passed.

## Management-only TUI and provider usage tabs (2026-10-10)

The public entrypoint now opens native management directly, with no project
conversation or task prompt. Slash input appears only when requested. `/usage`
shows one provider at a time; Tab and Shift+Tab cycle the provider catalog, and
number keys switch sections. Cline has no adapter and shows unavailable data.
Only management commands are reachable from the public app; historical execution
modules and user records remain intact. Enrolled-account reads reuse existing
cached observations or open the local database read-only; they never start the
historical execution coordinator or refresh its runtimes.

Verification: 135/135 automated tests passed, including real PTY provider-tab
cycling and wraparound, prompt-free startup, management-only command rejection,
native launch/resume return, read-only cache preservation, and missing-coordinator
non-startup. Type checking and formatting passed. Provider behavior was exercised
with synthetic credentials/state; real-account quotas were not checked.

## Previous conversational interface (superseded)

`principal` is now the only user workflow entrypoint. Shell subcommands are
removed (help/version flags remain). The default conversational interface has
slash-command suggestions and scrolling views. `/accounts` combines discovered
native configurations with enrolled accounts; `/usage` shows both scopes without
summing quotas. `/sessions` and `/dashboard` open the folder explorer;
`/profiles` opens account management; `/dashboard runs` opens run monitoring.
Slash commands in browser views return to the same Principal prompt. Native
login/launch handoffs return without starting or replaying project work.

Default configuration discovery records references only and does not touch
credentials. Startup no longer creates a project conversation: that happens on
an explicit message or native project-mode request. Existing backend services,
provider helpers, records, workspace review/apply, and safety gates remain.
Former shell operations are available through internal slash-command routing.

The unified change passed 132 automated tests, including synthetic provider
integration and real PTY navigation, native return, usage/account views, shell
subcommand removal, discovery idempotence, and credential-file non-access.
These tests do not establish live authentication refresh, live multi-account
independence, real quota retrieval in the new layer, or Windows/WSL portability.
Work remains local, uncommitted, unpushed, and unpublished.

## Historical native management MVP (2026-10-10)

Bare `principal` opens the native session explorer with nested virtual folders,
project grouping, saved expansion/selection, search, rename, move, and archive.
Profiles, native foreground launching, supported resumption/history, observations,
and diagnostics run through a separate management daemon, SQLite database, and
owner-only Unix socket. Existing explicit orchestration/chat/native commands and
their storage remain available without migration.

The implementation passes 127 automated tests, including CLI integration with
synthetic native binaries, real PTY navigation/resize/resume/return, metadata
redaction, quota scope/freshness, process ownership, queued stop control through
the original child handle, and database/daemon restart without replay. The
existing orchestration regressions are included in that count.

Installed interface versions were inspected without login or inference:
Codex 0.162.1, Claude Code 2.1.281, Copilot CLI 1.0.89, Antigravity 1.3.1.
Unknown versions disable deeper reads/parsers/resumption while retaining native
launching. Codex provides read-only app-server observations/history; Claude and
Antigravity observers require explicit native configuration. Claude hook helpers
emit no context or permission decisions. These interfaces and fixture results
do not establish live account isolation or quota retrieval.

Open gates: real two-account authentication/refresh, native CLI terminal behavior,
live provider callbacks/history/resume/resource collection, Copilot account pinning,
Antigravity credential namespace isolation, and actual WSL validation. No user
credentials were changed and validation issued no live provider inference requests.
Existing-terminal attachment, Cline/Muse expansion, persistent tmux terminals,
cross-environment aggregation, and native Windows/macOS remain later phases.

Changes are workspace-only; no commit, push, publication, or deployment was made.
See [native management](NATIVE_MANAGEMENT.md) for commands and boundaries.

## Historical orchestration evidence

- TypeScript compile completed during implementation; the final compile and runtime syntax checks passed.
- Runtime JavaScript syntax was checked with `node --check`.
- npm dependencies are locked; the native SQLite addon was rebuilt for the current Node runtime.
- Codex protocol TypeScript bindings were generated from the installed 0.160.1 binary into `src/generated/codex` as a pinned protocol reference.
- The runtime Docker image is built locally from the installed provider binaries; no credentials are added to the build context.
- Two Codex Free accounts completed device-code login. The live smoke run `bc096928-55fc-4135-a906-6035798f4391` restored their saved credentials, ran concurrent read tasks returning unpredictable file markers, verified rejected workspace writes, completed a dependent write task, passed credential-free integration validation, and applied to its isolated temporary repository.
- Unit tests cover readable logs/results, task account pinning, account leases in scheduling, quota reserves, and unknown quota/model scopes. A separate Docker smoke test verifies helper packaging, read-only mounts, writable tmpfs, default seccomp, and zero effective capabilities.
- Before the interactive-session extension, the Agents dashboard was the default view. Its event reducer and concurrent task panels are covered by rendering tests; actual TTY checks cover saved event replay, two panels, task selection, result scrolling, tabs, and clean detach. That build recorded 56 passing automated tests, including audit regressions and quota precision formatting. `python3 scripts/dashboard-smoke.py RUN_ID` checks terminal navigation on a saved run without starting inference.
- Exhausted allowance handoffs, native OAuth refresh, and recovery failure scenarios remain unverified.
- Antigravity login infrastructure checks pass: interactive SSH PTY allocation, private Secret Service store/read, and cold keyring restoration using synthetic values. Native Google sign-in completed on 1.3.0; encrypted credential restoration, quota retrieval, and a live stream worker writing a random marker passed on 1.3.1. The temporary SSH server receives AUDIT_WRITE; inference worker capabilities remain dropped. Random private keyring passwords persist only within encrypted home archives on the host.
- Work is local. No commits, push, npm publication, or external deployment have been performed.

## Interactive extension (2026-10-07)

The default command now opens interactive chat. Persistent sessions, durable deduplicated
input, native conversations, portable checkpoints, child-agent histories, mixed pools,
dirty-workspace capture, review, and unstaged application are implemented locally.
All 80 automated tests pass, including the existing batch and audit regressions.
The rebuilt runtime passes the Docker isolation smoke check.

Live Codex and Antigravity sessions passed repeated turns and cold resume. Codex
native compaction and Antigravity portable continuation passed. A mixed-provider
run overlapped two isolated workers, independently validated their changes, and
applied reviewed edits while preserving host HEAD, Git index bytes, staged and
unstaged user changes, and untracked user files. Narrow-terminal navigation,
multiline bracketed paste, scrolling, and detach pass the PTY smoke check.

See [INTERACTIVE_SESSIONS.md](INTERACTIVE_SESSIONS.md) for commands, migration,
recovery contracts, and limits, and [INTERACTIVE_EVIDENCE.json](INTERACTIVE_EVIDENCE.json)
for recorded evidence. Earlier BUILD.json results remain historical snapshots.

| Capability                     | Codex 0.160.1                            | Antigravity 1.3.1                                                    |
| ------------------------------ | ---------------------------------------- | -------------------------------------------------------------------- |
| Repeated turns and cold resume | Live verified                            | Live verified                                                        |
| Incoming input                 | Native steer, fixtures                   | Durable FIFO queue, fixtures                                         |
| Context compaction             | Native, live verified                    | Portable new conversation, live verified                             |
| Provider questions             | Individual app-server requests, fixtures | Principal structured questions; native headless requests unsupported |
| Interrupt and cleanup          | Bounded, automated checks                | Bounded, automated checks                                            |
| Mixed isolated workers         | Live verified                            | Live verified                                                        |

Antigravity 1.3.0 remains an accepted legacy adapter target; this extension was
live-tested on 1.3.1. Runtime upgrades require repeated protocol and live-resume checks.
Full release gates remain open: exhausted-quota handoff, live native credential
refresh, native interactive-question denial, broader live crash/container failure
injection, and concurrent isolation across two Antigravity accounts. Only one
Antigravity account is enrolled. Existing automated failure-injection coverage is
not substituted for those live gates. No commit, push, publication, or external
deployment was performed.

## Provider matrix

| Provider    | Pinned adapter version | Execution                 | Login                                     | Quota                                    | Live evidence                                                     |
| ----------- | ---------------------- | ------------------------- | ----------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| Codex       | 0.160.1                | App-server stdio JSON-RPC | Managed ChatGPT device code               | rateLimits/read and updates              | Two Free accounts: login, parallel reads, write/integration/apply |
| Antigravity | 1.3.0 / 1.3.1          | Headless stream-json      | Native remote login through temporary SSH | Validated structural JSON /usage parsing | Login, restore, quota, and scoped workspace writing verified      |

Runtime operations reject versions outside these pinned targets. These are adapter targets, not a declaration of validated provider support. The model catalog is not an entitlement guarantee. Free Codex CLI account support is included in the product design. Provider access, quotas, and permissions still depend on each account.

## Remaining release evidence

Public beta requires live evidence for cold credential restoration, native token refresh, concurrent isolation across at least two accounts per provider, denied headless permissions, exhausted quota handoffs, same-account conversation resume, supervisor bounds, daemon crash recovery, container disappearance, integration conflicts, and expected-base apply. Those checks must not be represented by fixture-only results.

The runtime image adapts to the building user's UID/GID and the coordinator accounts for rootless Docker bind ownership. The initial workstation uses UID 1000 / GID 982. Rootless Docker and other host IDs, macOS, Windows, and custom provider distributions are not validated. The image copies the Codex executable and its required sibling `codex-code-mode-host`; other distribution layouts need a packaging adapter.

Account and routing state transitions classify only recognized structured provider errors. Task summaries and unstructured error text do not establish auth, quota, or account restrictions; unknown errors require review. Provider-specific error changes may require adapter updates. JSON quota fields that do not match the documented or observed shape produce unknown/unsupported observations, never an invented percentage.

Native providers can apply their own account billing/overage preferences. Principal never supplies a paid API fallback, but it cannot override vendor account settings that already permit credit spending. Select appropriately configured accounts for a free-resource-only pool.

## Sources used during implementation

- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex in ChatGPT plans](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Antigravity headless CLI](https://antigravity.google/docs/cli/headless)
- [Antigravity permissions](https://antigravity.google/docs/permissions)
- [Antigravity usage command](https://antigravity.google/docs/cli/commands/usage/)
- Local prototype docs under `/home/varun/docs`, used for observed private keyring and quota response formats.

## Final build artifacts

The local `principal` command points to the launcher using the recorded build runtime. `principal-runtime:local` built successfully, including Codex 0.160.1, its command host, Bubblewrap, and Antigravity 1.3.1. Machine-readable build and live smoke evidence is in [BUILD.json](BUILD.json). Codex uses Docker through the external-sandbox protocol because nested Bubblewrap namespaces are blocked by Docker's default policy.

## External audit review (2026-10-07)

See [AUDIT_REVIEW.md](AUDIT_REVIEW.md) for all 13 findings, corrections to unsupported claims, fixes, test coverage, and limits. The updated coordinator and runtime are installed locally. Existing runs retain their frozen images.

## Second audit hardening

See [SECOND_AUDIT_REVIEW.md](SECOND_AUDIT_REVIEW.md) for verified findings, fixes, current automated/infrastructure checks, and remaining live evidence gaps. Credential archives now advance generation using durable versioned files and a database pointer; actor cleanup retains leases when stop cannot be confirmed. Dedicated Docker networking blocks peer runtime connections while preserving provider egress and host login access.

## Automatic working directory (2026-10-08)

`principal` now starts a session in its launch directory automatically, including
ordinary folders, repositories with no commits, and repository subdirectories.
No `/project` command is required. Conversation uses a read-only directory mount;
workers receive a private snapshot before editing. Host Git initialization and
commits are never performed. Review/apply and existing index preservation remain.
All 85 automated tests pass. A live Codex conversation read an unpredictable file
marker from an ordinary folder. Home/installation terminal startup also passed.

## Cursor and Antigravity response fixes (2026-10-08)

The chat reserves one terminal row for Ink's trailing newline, keeping the cursor
inside the draft during redraws, snapshot polling, multiline editing, slash menus,
and resizing. Command suggestions shrink to fit narrow terminals. Actual-screen
PTY checks cover 12x55 and 24x100 terminals, Unicode and long drafts, repeated
refreshes, navigation, keyboard/mouse/touchpad scrolling, and clean detach.

Antigravity conversational leads now use the supported `--effort medium` setting.
Greetings avoid unnecessary project tools. Chat displays elapsed response time,
account waiting, and deduplicated native activity; internal structured control
JSON stays hidden until the validated reply is available. Delegated workers keep
their native reasoning setting.

All 102 automated tests pass. Live Antigravity 1.3.1 completed a greeting from an
ordinary folder with no tools in 35 seconds end to end (about 34 seconds after
dispatch). An earlier native-default greeting took 120 seconds including account
waiting; these individual observations are not a latency guarantee. A separate
four-turn test passed duplicate admission, file exploration, repeated responses,
cold resume with the same native conversation ID, and portable continuation
using the updated driver. Exact local evidence is in
[RESPONSE_FIX_EVIDENCE.json](RESPONSE_FIX_EVIDENCE.json).

The CLI, coordinator, and runtime image are installed locally. Reopen the chat to
load the updated interface. Work remains uncommitted and unpushed.

## Native and Principal interface modes (2026-10-08)

`/mode native` opens the selected lead account’s actual Codex or Antigravity
terminal interface. Exiting the provider returns to the same Principal session;
`/mode principal` selects the unified interface there. Direct launch supports
`principal --mode native` and `principal native`, with pool and account flags.
The native provider receives no Principal orchestration prompts or JSON schema.

Native mode edits the launch directory directly, including its Git index, inside
the account’s isolated Docker runtime. Principal mode retains private workspaces
and reviewed application. Histories stay separate; use `/refresh` after native
changes before continuing an existing Principal project session. Native account
state and preferences are saved in the encrypted home. Managed vault/configuration
paths are masked in home-directory workspaces. Shared leases, attachment recovery
and confirmed-stop cleanup remain enforced.

All 112 automated tests and TypeScript checks pass. Actual Codex 0.160.1 and
Antigravity 1.3.1 native interfaces each passed two launch/exit/return cycles.
Codex returned the live arithmetic answer 43. Antigravity reached its own setup
screen; native inference past its terms/data-sharing choices remains unverified
and those choices were left to the user. Docker checks verified direct file and
Git access, preservation of existing user files, distinct working paths and hidden
Principal account storage. See [NATIVE_MODE_EVIDENCE.json](NATIVE_MODE_EVIDENCE.json).

The CLI, daemon and runtime image are updated locally. Work remains uncommitted
and unpushed.
