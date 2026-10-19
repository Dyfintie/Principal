# Principal · User Experience & Usability Guide

This document covers user-facing interaction workflows, shortcuts, command history navigation, multi-profile launching, and installation containment in Principal.

---

## 1. Shell-Like Command History Navigation

Principal features Linux shell-like command recall inside the interactive command prompt (`/`).

### How It Works:
- **Up Arrow (`↑`)**: Recalls the previous command from history, exactly like Bash, Zsh, or Fish. Pressing Up Arrow repeatedly walks backward through previously executed commands.
- **Down Arrow (`↓`)**: Walks forward through history towards the newest command. When reaching the bottom, it restores whatever draft text you were originally typing.
- **Tab (`⇥`)**: Autocompletes the selected slash command suggestion with a trailing space.
- **Shift+Tab**: Cycles backward through autocomplete suggestions.
- **Enter (`↵`)**: Executes the command, registers it into the persistent command history, and resets the cursor.
- **Escape (`Esc`)**: Closes the command palette without modifying state.

---

## 2. Streamlined Commands & Shortcuts

The command list is structured around essential, high-frequency operations so you are never overwhelmed by rarely used options:

| Full Command | Short Alias | Description | Example |
| :--- | :--- | :--- | :--- |
| `/launch` | `/l` | Launch one or multiple agent profiles | `/launch anti_main anti_2` or `/l agy` |
| `/swap` | `/sw` | Hot swap active account for a provider | `/swap agy` or `/swap --best` |
| `/usage` | `/u` | View token and quota balances across providers | `/usage` or `/usage --refresh` |
| `/profiles` | `/p` | View and manage provider accounts & credentials | `/profiles` |
| `/sessions` | `/s` | Browse folders, projects, and saved conversations | `/sessions` |
| `/doctor` | `/d` | Run system diagnostics and verify tool health | `/doctor` |
| `/help` | `/h` | View quick commands and navigation shortcuts | `/help` |
| `/exit` | `/q` | Exit Principal | `/exit` or `/q` |

> [!TIP]
> Secondary commands like `/accounts`, `/pull`, `/diagnostics`, `/folders`, `/agents`, `/warnings`, and `/back` remain available if typed, but are kept out of default suggestions to keep the interface clean and focused.

---

## 3. Multi-Profile Launching in a Single Command

You can launch multiple profiles concurrently with a single command, both from your terminal shell and inside the Principal TUI.

### From Your Terminal Shell:
```bash
# Launch two accounts side-by-side:
principal launch anti_main anti_2

# Launch three accounts simultaneously:
principal launch anti_main anti_2 anti_3

# Comma-separated syntax:
principal launch --profile anti_main,anti_2
```

### Inside the Principal TUI:
```
/launch anti_main anti_2
/l anti_main anti_2
```

### Multiplexed Workspace Architecture:
1. Each profile launches inside an isolated tmux session under Principal's management runtime (`principal-<uuid>`).
2. Principal automatically links each secondary window into a unified primary session:
   - **Window 0**: Profile 1 (`anti_main`)
   - **Window 1**: Profile 2 (`anti_2`)
3. Switching between profiles:
   - `Ctrl+b 0` or `Ctrl+b 1` (or `Ctrl+b n` / `Ctrl+b p`) flips between accounts instantly in full-screen.
   - `Ctrl+b %` or `Ctrl+b "` splits the window horizontally or vertically to view accounts side-by-side.
   - `Ctrl+b d` detaches back to Principal while all agents continue working safely in the background.

---

## 4. One-Step Installation & Containment

Principal includes a self-contained bootstrap script that handles building, native SQLite binding verification, and symlinking into your user PATH.

### Install / Update:
```bash
cd /home/varun/principal
./scripts/install.sh
```

### What `install.sh` Does:
1. Verifies Node.js runtime and detects recorded ABI.
2. Builds the TypeScript bundle and runtime manifest (`npm run build`).
3. Establishes the global binary symlink in `~/.local/bin/principal` -> `bin/principal.mjs`.
4. Executes an automated health preflight (`principal --version`).
