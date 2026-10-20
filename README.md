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

In **Usage** and **Profiles**, **Tab** cycles Codex → Antigravity → Copilot → Claude;
**Shift+Tab** cycles backwards. Each provider shows only its own accounts.
**↑/↓** scroll and **u** refreshes supported observations. Open views with **/sessions**, **/profiles**,
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

Antigravity **n** creates an experimental isolated login with its own HOME, private D-Bus session and encrypted keyring. Complete the native Google sign-in, exit to Principal, then press **s** to launch that profile again. New isolated profiles include the usage statusline automatically. **a** connects the existing shared login without initiating authentication. Different isolated profiles can run in different terminals; each permits one active agent. Linux keyring dependencies and an unlocked host Secret Service are required. Actual two-account login and natural refresh remain user-controlled and unverified; profile labels alone do not prove independence. Read [Codex vs Antigravity architecture and limitations](docs/ANTIGRAVITY_PROFILES.md).

Antigravity authentication becomes a native report when a validated statusline supplies account identity. Until then, **not verified** does not mean logged out. Compatible Antigravity updates no longer require an exact version match: native help checks resume support, and callback fields are validated independently.

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
layer remain unverified. Copilot/Antigravity use native account selection.

## Native tools and scope

Launch and resume hand this terminal to the official coding agent and return to
management after it exits. Principal itself accepts no task prompts. Historical
orchestration code and records remain preserved, but project chat, task planning,
model selection, delegation, and workspace apply are not exposed in this TUI.

## 🐝 Multi-Account Swarm Orchestration (Agent Delegation)

Principal includes a universal subagent delegation engine. Any **Lead Agent** (such as **OpenAI Codex**, **Claude Code**, **Cursor**, or **Antigravity**) can act as the central orchestrator, divide complex projects into parallel subtasks, and delegate them to a swarm of worker agents running across your isolated accounts (e.g. 4 parallel Antigravity accounts, multiple Codex accounts, or Copilot) with automatic quota headroom balancing and Git worktree isolation.

### Connect an Agent as Lead Orchestrator (MCP)

Principal provides a standards-compliant Model Context Protocol (MCP) server executable via `principal-mcp` (or `principal serve-mcp`).

**For OpenAI Codex (`~/.codex/config.toml`):**
```toml
[mcp_servers.principal_swarm]
command = "principal-mcp"
```

**For Claude Code:**
```sh
claude mcp add principal-swarm principal-mcp
```

### Available MCP Tools for Lead Agents:
- **`principal_deploy_swarm`**: Dispatches parallel worker agents across Antigravity or Codex accounts with ephemeral Git worktree isolation (`git worktree add`) and quota headroom balancing.
- **`principal_get_swarm_status`**: Queries live progress, worker logs, and unified git diffs for a running swarm.
- **`principal_cancel_swarm`**: Terminates an active swarm execution safely.
- **`principal_list_profiles`**: Checks available accounts, authentication states, and remaining weekly quota headroom.

### CLI Swarm Commands
```sh
# View available worker accounts and headroom
principal swarm profiles

# Dispatch parallel tasks across accounts
principal swarm run \
  --provider antigravity \
  --task "Audit src/cli.ts and report findings" \
  --task "Write unit tests for authentication in tests/auth.test.ts"

# Dispatch from JSON task file with structured output
principal swarm run --provider antigravity --tasks tasks.json --json
```

For full architecture and prompt examples, see:
- [Agent Swarm Orchestrator Guide](docs/AGENT_SWARM_ORCHESTRATOR_GUIDE.md)
- [Swarm Architecture Breakdown](docs/AGENT_SWARM_ARCHITECTURE.md)

## Install & Setup

### ⚡ One-Liner Install (Antigravity & Claude Code Feel)
```sh
# Via GitHub releases:
curl -fsSL https://raw.githubusercontent.com/dyfintie/principal/main/install.sh | bash

# Or over local network / Tailscale from friend:
curl -fsSL http://<friend-ip>:8088/install.sh | bash
```
Installs in < 2 seconds with zero build tools, zero C++ compilation, and automatic PATH configuration.

### 📦 Self-Extracting Single-File Script
```sh
bash principal-installer.sh
```

### 📡 Instant Local Sharing (`npm run serve`)
```sh
npm run serve
# Automatically serves pre-built packages over Wi-Fi / Tailscale with copy-paste install commands
```

### 🛠️ Developer Install (Git Checkout)
```sh
git clone https://github.com/dyfintie/principal.git
cd principal
./install.sh --dev
```

### 📦 Create Release Packages
```sh
npm run package
# Produces dist-package/principal-installer.sh, principal-linux-x64.tar.gz, and principal-cli-0.1.0.tgz
```

See [Installation & Packaging Guide](docs/INSTALLATION.md) and [Account Handoff Guide](docs/ACCOUNT_HANDOFF.md).
Inside the app, use `/doctor` (or CLI `principal doctor`) to inspect supported tool interfaces.

See [native management](docs/NATIVE_MANAGEMENT.md),
[interactive sessions](docs/INTERACTIVE_SESSIONS.md), and
[implementation evidence](docs/STATUS.md).

Antigravity history: `/profiles` → Antigravity → destination profile → **Shift+I** → choose native history or another profile → confirm. These are experimental independent local snapshots for 1.3.3, with credentials kept separate. Native IDs and workspace paths are retained; actual continuation across Google accounts remains unverified. [Details and limitations](docs/ANTIGRAVITY_HISTORY.md).

To reopen a local agent session here, select it in `/sessions` and use **Shift+P**, **Enter → Reopen on this terminal**, or `/pull`. Confirm before an owned live agent is stopped and relaunched. This resumes saved history; it does not move a live process or fetch remote-only history.
