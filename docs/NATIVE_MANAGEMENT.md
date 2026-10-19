# Principal

A Linux-first terminal application for managing coding-agent accounts, native
profiles, sessions, and available usage observations. Run `principal` to open
its folder-style session explorer. Principal does not execute agentic tasks and
has no chat prompt.

The management command box is visible by default. Type `/` to see suggestions,
use **↑/↓** to select one, **Tab** to complete it, and **Enter** to run it.
**Esc** clears command entry. Menus and forms expose common operations.

| Command                     | View                                                             |
| --------------------------- | ---------------------------------------------------------------- |
| `/sessions` or `/dashboard` | Folder → project → native conversation/process tree              |
| `/profiles`                 | Native profiles, cached accounts, and active unassigned sessions |
| `/accounts`                 | Existing native profiles and previously enrolled accounts        |
| `/usage [--refresh]`        | Usage for the selected provider                                  |
| `/diagnostics` or `/doctor` | Installed-tool diagnostics                                       |
| `/help`                     | Management commands and keyboard shortcuts                       |
| `/back`                     | Session explorer                                                 |
| `/exit`                     | Close Principal                                                  |

In **Usage** and **Profiles**, **Tab** cycles Codex → Antigravity → Cline → Copilot → Claude;
**Shift+Tab** cycles backwards. Each provider shows only its own accounts.
Cline shows **Free · no software subscription quota** separately from connected
model/provider usage, which stays unavailable until verified. It supports profile
setup and native sign-in/launch. **↑/↓** scroll and
**u** refreshes supported observations. Open views with **/sessions**, **/profiles**,
**/usage**, and **/diagnostics**. Navigation stays available while usage loads.

In the session tree, **Space** opens actions, **Enter** selects, **f** searches,
and **/back** returns to the session view. **q** quits Principal without issuing agent stop
requests. Ended generic external-process observations are hidden from the normal
tree; live agents and saved or managed sessions remain visible. Records are retained.
Forms use **Tab** between fields and **←/→** for choices.

## Existing logins and usage

`/accounts` and `/usage` discover documented native configuration directories
for installed tools, including configured Codex/Claude directory selectors.
Discovery registers references; it never reads credential files, decrypts
keychains, signs in, or infers authentication from a directory's presence.
Supported native checks establish identity; unsupported identity remains unknown.
Copilot Profiles checks use the first-party SDK authentication-status interface
and show the current GitHub login. Copilot usage reads official account quota snapshots, with remaining percentages, reported entitlement units and reset dates; these are not converted into AI credits. Login is distinct from a running CLI session.
Use `/profiles` and **Tab / Shift+Tab** to switch providers, then **↑/↓** to select an account. Press **n** to add an account: enter a profile name and press **Enter** to open native sign-in. Principal selects the provider and supported configuration isolation automatically. Press **a** to use an existing native login without signing in again; **Shift+N** opens advanced directory/configuration setup. Copilot uses native account selection. Antigravity offers experimental Linux isolation when its dependencies are available. Native sign-in returns to the same provider tab with the signed-in profile selected, ready to launch with **s**. Press **Enter** for all profile actions, **r** to rename, and **d** to remove. Press **s** or choose **Launch native tool with this profile** to select a repository and optional native arguments, then press **Enter**. Principal passes the selected native configuration to the installed tool, reuses its existing login and returns to management when it exits. The native tool handles any expired-login prompt. The menu also provides authentication checks, native sign-in, history import and details. Removing requires typing `remove`; native credentials, configuration directories and session history are retained. Active or uncertain sessions and in-progress usage refreshes block removal. Removed configurations stay hidden during automatic discovery; explicitly add the existing directory to restore the profile and its history binding. Cached accounts and unassigned external sessions remain read-only observations.
The `/profiles` list includes the same enrolled accounts shown in `/usage`, labelled as cached, plus active sessions with no confirmed profile owner. Only native configuration profiles offer sign-in and launch; other entries offer metadata details. Empty profile names keep the form open with a readable validation message.

To add Cline: switch to the **Cline** provider tab, press **n**, enter a name and press **Enter**. Principal opens Cline’s native authentication wizard. Use **a** to register an existing native login instead.

Antigravity **n** adds an **experimental isolated account** on Linux when `dbus-daemon`, `gnome-keyring-daemon`, `gdbus` and `secret-tool` are available. Enter one profile name, complete native Google sign-in, and exit the native tool to return. Each new profile gets its own HOME, encrypted keyring, private D-Bus session and usage statusline. Desktop Secret Service must be unlocked. Each isolated profile permits one active native agent; different profiles can run in separate terminals. Existing profiles are not migrated or signed out.

Antigravity **a** connects the shared native login without opening a browser; it does not initiate sign-in. **l** opens native sign-in for the selected profile after explaining the handoff. Native `agy` owns OAuth, browser launch, onboarding and refresh; no documented sign-in-only command was found. Signing out inside an isolated profile affects that profile; signing out inside a shared native profile changes the shared login. Authentication stays **not verified** until a validated statusline reports an account, and is not an authoritative token-validity check.

Private keyring separation, encrypted storage and restart behavior passed synthetic tests. **Two real Google logins and natural token refresh remain user-controlled and unverified.** This wraps the official CLI with OS-level isolation, rather than using an official Antigravity profile API. See [architecture and limitations](ANTIGRAVITY_PROFILES.md) and [official authentication documentation](https://www.antigravity.google/docs/cli/install/) (checked 2026-10-10).

To populate an empty Codex profile with conversations already stored on this machine, select that profile in `/profiles` → Codex and press **Shift+I**, or choose **Load existing Codex history** from its action menu. Principal previews the count and conversation names from the native Codex directory (`CODEX_HOME`, or `~/.codex`), across all projects and including archived history. Press **Enter** to copy them, or **Esc** to cancel. Each completed conversation gets an independent native ID and appears in `/sessions` under the selected profile. Native originals, credentials and configuration stay separate. The **h** action instead shows history already in the selected profile; it does not copy from another directory.

Loading is resumable: already loaded conversations are skipped, completed copies remain if another fails, and the results explain unfinished turns, missing project directories or unsupported formats. Finish active source turns and retry **Shift+I** for the remaining conversations. Loading is a one-time snapshot per conversation, not ongoing synchronization. If the selected profile already uses the native directory, use **h** directly.

To copy a complete Codex conversation between profiles, first import A's history with **h** in `/profiles`. In `/sessions`, select the conversation, press **Shift+C** (or choose **Copy conversation to another profile**), select profile B, choose a project directory, and submit. The copied entry has its own native conversation ID; **Shift+R** resumes it with B. A's original history and both profiles' credentials remain separate. Choose a separate worktree directory if the two agents should edit independently; the history copy does not duplicate project files or external attachments.

Exact copying is validated for **Codex 0.162.1, OpenAI-backed local legacy and paginated JSONL rollouts**. The app-server cannot directly fork paginated mode in this version. Principal changes only the temporary snapshot's metadata flag to obtain a native fork identity, then places every original non-header byte beneath the new native header. This also avoids fields being dropped by native reserialization when copying A onward into B. Originals, credentials and configuration remain untouched; destination recognition is checked before registering the copy. The imported copy uses compatible legacy mode while preserving messages, tool records, compaction, world state and newer event fields. This is a local rollout compatibility import, not a paginated-history API integration. It requests no inference. Incomplete turns, unknown storage modes, unsupported versions and unsupported providers are rejected. Antigravity has a separate experimental SQLite snapshot mechanism, described below. Copies are independent snapshots; subsequent messages are not synchronized. The limit is 64 MiB per conversation; remote-only history, external attachments and repository files are not copied. `npm run test:history-copy` checks legacy history; `npm run test:history-copy -- --paginated` checks paginated loading and onward copying with disposable synthetic history and no login or inference requests.

For the supported Codex version, Principal launches and resumes with `--no-daemon` so the native tool loads the selected profile directly instead of reusing a background server's authentication state. Existing Codex servers and sessions are left running. From `/profiles` → Codex, select an account and press **Shift+D**, or choose **Sign in with device code** from the action menu. This runs the official `codex login --device-auth` with the same `CODEX_HOME` used by launch; browser login remains the default. Enable device-code login in your ChatGPT security settings (or workspace permissions) if required. Device login changes how you authorize the account, not where its login is saved or how long it remains valid. See [OpenAI authentication](https://developers.openai.com/codex/auth).

Codex supports read-only native account/limit/history observations for verified
interface versions. Claude and Antigravity native usage requires an explicitly
configured observer; `/profiles` shows its setup. New isolated Antigravity profiles include it automatically. Previously enrolled Principal
accounts appear alongside native profiles, in a separate authentication scope.
Native and enrolled entries may refer to the same account; balances are never
summed. Unknown quotas stay unavailable, and stale observations stay labelled.
Previously enrolled accounts are read as cached metadata; usage navigation never
starts or refreshes historical execution runtimes.

The application cannot enumerate every browser login, remote session, private
keychain account, Windows process from WSL, or containerized agent. External
process detection is conservative; a running process alone does not establish
its account or whether it is working. Existing external terminals cannot be
attached. Concurrent foreground native agents currently need separate terminals.
Independent two-account authentication and natural refresh in the new management
layer remain unverified. Copilot uses native account selection; Antigravity also offers experimental Linux isolation.

## Native tools and scope

Launch and resume hand this terminal to the official coding agent and return to
management after it exits. Principal itself accepts no task prompts. Historical
orchestration code and records remain preserved, but project chat, task planning,
model selection, delegation, and workspace apply are not exposed in this TUI.

## Install locally

Requires Linux/WSL, Node.js 24+, `flock`, and the official agents you use.

```sh
cd /home/varun/principal
npm ci
npm run build
npm link
principal
```

If npm blocks native install scripts, approve `better-sqlite3` and rebuild it
before building Principal. Inside the app, use `/doctor` to inspect supported tool interfaces.

See [native management](docs/NATIVE_MANAGEMENT.md),
[interactive sessions](docs/INTERACTIVE_SESSIONS.md), and
[implementation evidence](docs/STATUS.md).

### Unified profile inventory

`/profiles` loads the shared account inventory used by `/usage`. Native configurations remain actionable sign-in/launch profiles and display supported authentication checks and active invocation counts. Earlier enrolled accounts appear as cached metadata rows, with details and no native login/launch actions. Active invocations with no profile binding appear as external-session rows; a process is not treated as proof of login. Identity matches alone do not merge configurations or copy credentials.

Blank profile labels produce a readable message and focus the name field without closing the form. Submission failures retain form values; server-side registration rejects empty names before creating directories or database records.

In profile and launch text fields, **Ctrl+U** clears the current value. Profile launching binds to the selected profile ID, so a concurrent label change cannot select a different login configuration.

Antigravity no longer requires an exact version match. Safe `--help` checks enable resume only when `--conversation` is advertised; every statusline callback validates account, session and quota fields independently. Compatible future versions stay usable. Unknown fields are ignored; malformed quota buckets are omitted with an account-specific diagnostic, while valid account/session fields continue updating. Missing optional quota remains unavailable rather than becoming an estimated balance. Checks verified 2026-10-10. Its full-TUI sign-in handoff is now tracked as a profile-bound invocation, so a validated callback can report the account identity and quota under that profile. A sign-in alone does not guarantee quota data: the native callback must run and include its optional `quota` fields. Refresh does not initiate model requests or poll a private API. Callback-based providers ignore polling backoff inherited from an earlier unsupported CLI version.

Antigravity supports experimental local history copying when the installed storage contracts match the inspected baseline: in `/profiles`, select the destination and press **Shift+I**, then choose native history or another Antigravity profile as the source. Review the preview and confirm. In `/sessions`, **Shift+C** copies one imported conversation. **Shift+R** shows an experimental continuation warning before handing off to the native tool. See [format limits, security and verification](ANTIGRAVITY_HISTORY.md).


### Reopen a session on this terminal

In `/sessions`, select a session and press **Shift+P**, or **Enter** → **Reopen on this terminal…**. `/pull` opens the same action for the selected row; `/pull ENTRY_ID` selects a specific registry entry. The form explains what will happen before Enter confirms it.

New interactive launches use a persistent tmux terminal automatically when tmux is installed and the current terminal is outside tmux. The launch form offers Automatic, Persistent (tmux), and Direct. For a persistent invocation, Jump attaches to the same live native process after checking the wrapper/pane identity; **Ctrl+b, then d** detaches back to Principal. No native stop or history restart occurs. Existing direct or external invocations cannot be converted; the following stop/resume path applies to those.

Principal rechecks the local process identity before reopening. An exited process is reconciled without signaling anything. If an owned native process is still alive, confirmation requests a graceful stop through its original launch wrapper. Principal waits up to 30 seconds for both native process and private keyring runtime to exit; a timeout or replacement invocation blocks the launch. No bare PID termination or process takeover is used. A different active conversation in the same isolated Antigravity profile must be stopped separately.

If the native agent ignores graceful shutdown, reopen the action after the timeout and change **Stop method** to **Force stop and reopen** with the arrow keys. This explicitly discards unfinished in-memory work. Recovery is Linux-only and requires Python 3 with `os.pidfd_open` and `signal.pidfd_send_signal`; there is no unsafe bare-PID fallback. The daemon opens a pidfd, verifies the native process identity, same-user ownership and ancestry under the live original wrapper, and kills only that native process. Its private runtime can then flush the keyring and exit normally. A new launch still waits for both to exit; missing ownership, unsupported pidfds or a stuck private runtime block recovery.

The existing management daemon attempts resource refreshes on startup and every 60 seconds thereafter, including when the TUI is closed. Codex and Copilot use their supported native reads; Antigravity and Claude update through native callbacks, and Cline has no software subscription quota to poll. Overlapping refresh requests share a collection job, provider reads are bounded to two profiles at a time, and failed profiles retain exponential retry backoff. The open `/usage` view receives daemon snapshots automatically. Successful reads update observation timestamps; skipped or failed reads retain their original timestamps and can remain stale. Background polling never starts inference, login flows or the historical orchestration daemon. The manager starts when Principal is opened; this is not an installed boot service.

`/doctor` and `/diagnostics` show a bounded native authentication health report, local Codex token-expiry evidence and private-isolation dependencies. Confirmed Codex 401s mark authentication rejected and offer `l`/`D` native sign-in; network failures do not claim logout. Raw provider errors and tokens are not printed or persisted. After a successful native authentication inspection, old observation backoff is cleared. See [reviewed improvement decisions](IMPROVEMENTS_IMPLEMENTED.md) for version compatibility, storage retention and browser relay limits.

A saved native ID resumes the same local conversation with its original profile and workspace. When an Antigravity ID was never observed, the installed help must confirm `--continue` before Principal uses it: this attempts the latest conversation for that profile/workspace, not a guaranteed recovery of the unknown conversation. Otherwise Principal opens the native UI for manual history selection. Other supported providers can use their native resume picker. Copied Antigravity histories retain their experimental continuation warning.

This is a restart from locally available history. It does not reattach an existing terminal, retrieve remote-only conversations, migrate a process from another machine or reconstruct unsaved turns. External/unassigned processes and missing or uncertain launch ownership require native intervention; Principal will not assume their account or stop them. Missing workspace paths must be restored first. No model prompt is sent by this action; native login or resume errors remain visible in the native tool.

Process rows can show **no controlling terminal** even while the process is alive. This is local process evidence, not proof of a provider-side active session. `/profiles` counts running processes separately from starting/uncertain launches.

Antigravity `/usage` shows two weekly windows per profile: **Gemini weekly** and **Claude weekly**. Five-hour bars are hidden for every Antigravity account. Claude labels refer to the native third-party (`3p`) quota pool, which may also cover GPT models; these are not invented separate model allowances. Repeated native observations across invocations are consolidated using the newest matching account/window report. Missing weekly windows remain unavailable, with reset/source/freshness evidence retained. Raw observation history stays stored; it does not produce additional dashboard bars.

From `/profiles`, select an account and press **Enter → Jump to current run…**, or **Shift+P**. Principal finds invocations bound to that exact configuration. One run opens the reopen confirmation directly; multiple runs show a chooser. The same confirmed stop/wait/resume behavior applies, and the TUI returns to that profile after native exit. No recorded run produces a message with launch/history alternatives; authentication alone does not imply a running agent. Unassigned external processes are never guessed into an account.
