# Principal CLI: Installation, Packaging & Setup Guide

Principal is designed with a **zero-friction, zero-compilation** philosophy. Anyone on any machine can install and run Principal in seconds with a modern, seamless experience identical to tools like **Antigravity**, **Claude Code**, and **OpenAI Codex**—with zero C++ compilers (`gcc`, `g++`), zero `node-gyp` builds, and no root (`sudo`) privileges.

---

## 🚀 Installation Methods

### Method 1: The One-Liner Web Installer (Antigravity Feel)
Run this single command in your terminal:

```bash
# Via GitHub:
curl -fsSL https://raw.githubusercontent.com/dyfintie/principal/main/install.sh | bash

# Or over your local network / Tailscale (if hosted by friend f1):
curl -fsSL http://100.120.248.19:8088/install.sh | bash
```

**What happens automatically:**
1. Detects your operating system (Linux / macOS) and CPU architecture (x64 / ARM64).
2. Verifies Node.js (Node v24+ recommended, v20+ supported).
3. Downloads the pre-compiled standalone bundle (~6.7 MB) into `~/.local/share/principal`.
4. Creates executable symlinks in `~/.local/bin/principal`.
5. Automatically configures your shell `PATH` (**Bash**, **Zsh**, or **Fish**).
6. Runs `principal doctor` to verify system health. Ready to code in < 2 seconds!

---

### Method 2: Global NPM Package (Codex & Claude Code Feel)
Just like `@anthropic-ai/claude-code` or `@openai/codex`:

```bash
# If installing from npm registry:
npm install -g principal-cli

# Or installing from a packaged tarball:
npm install -g ./dist-package/principal-cli-0.1.0.tgz
```

---

### Method 3: Self-Extracting Single-File Script (Zero-Download Offline)
If your friend sent you the all-in-one installer script `principal-installer.sh`:

```bash
bash principal-installer.sh
```

- This is a single, self-contained **6.7 MB** script with the compressed application embedded directly inside.
- It extracts itself, deploys to `~/.local/share/principal`, configures `PATH`, and sets up `principal` without needing any internet downloads or extraction utilities.

---

### Method 4: Developer / In-Place Source Installation (Git Clone)
If you are developing Principal or contributing to the codebase:

```bash
git clone https://github.com/dyfintie/principal.git
cd principal
npm install
npm run build
./install.sh --dev
```

When installed with `--dev` (or `--link`):
- `~/.local/bin/principal` symlinks directly to your working git repository.
- Changes made in `src/` (after `npm run build`) are instantly live without re-running the installer.

---

## 📡 Sharing Over Local Network or Tailscale (`npm run serve`)

If you (`f1`) want to let friends (`f2`) install Principal directly from your laptop without needing GitHub or public hosting:

```bash
# In the principal repository root:
npm run serve
```

Principal starts a dedicated, lightweight local distribution server and prints copy-paste commands for your friends:

```text
================================================================
🚀 Principal Distribution Server Running!
================================================================
Anyone on your network can install Principal with ONE command:

  • Over Tailscale (Phone, Laptop, Remote):
    curl -fsSL http://100.120.248.19:8088/install.sh | bash

  • Over Local Network (Wi-Fi / LAN):
    curl -fsSL http://172.19.16.190:8088/install.sh | bash

Press Ctrl+C to stop the server.
================================================================
```

When your friend runs the `curl ... | bash` command, the installer automatically fetches the pre-compiled bundle directly from your laptop and completes the setup in 2 seconds!

---

## 📦 Packaging for Distribution (`npm run package`)

To create fresh distribution archives to share via AirDrop, WhatsApp, Google Drive, or GitHub Releases:

```bash
npm run package
```

This generates all release formats in `dist-package/`:
1. **`dist-package/principal-installer.sh`**: Self-extracting single-file script.
2. **`dist-package/principal-linux-x64.tar.gz`**: Pre-compiled production bundle (zero build tools needed on target).
3. **`dist-package/principal-cli-0.1.0.tgz`**: Global NPM package.
4. **`dist-package/install.sh`**: Standalone curlable web installer.

---

## 🩺 System Verification (`principal doctor` / `principal setup`)

Run `principal doctor` (or `principal setup`) from any terminal:

```bash
principal doctor
```

```text
🩺 Principal Doctor - Environment & System Check
==================================================
✓ Node.js Runtime:    v26.10.0 (x64-linux)
✓ Database:          ~/.local/state/principal/management/manager.sqlite
✓ Management Socket: /run/user/1000/principal-management/manager.sock

🤖 Detected Coding Agents:
  ✓ OpenAI Codex (cdx)    : Installed (0.163.0) [~/.local/bin/codex]
  ✓ Claude Code (cld)     : Installed (2.1.296) [~/.npm-global/bin/claude]
  ✓ GitHub Copilot (cop)  : Installed (1.0.95)  [~/.npm-global/bin/copilot]
  ✓ Antigravity (agy)     : Installed (1.4.2)   [~/.local/bin/agy]

👥 Registered Profiles:
  ✓ [codex] codex_main [user@example.com] (ACTIVE)
  ✓ [antigravity] anti_main [user@example.com] (ACTIVE)

💡 Quick Start:
  • Launch Dashboard:     principal
  • Launch Agent:         principal launch agy  (or: principal launch cdx)
  • Share Quota:          principal handoff export <profile>
  • Import Quota:         principal handoff import <code>

✓ All systems operational! Ready to code.
```

---

## 🔐 Scoped Account Sharing (The `f1` ➔ `f2` Workflow)

Once Principal is installed on both machines:

### Step 1: Owner (`f1`) Exports Scoped Quota with Constraints
```bash
principal handoff export anti_main --time-limit 12h --quota-limit 25% --clip
```
Principal generates a cryptographically signed armored token.

### Step 2: Friend (`f2`) Imports the Code
```bash
principal handoff import "PASTE_TOKEN_HERE" --label friend_quota
```

### Step 3: Friend Launches AI Assistant via Principal
```bash
principal launch agy
```
- Pre-launch checks enforce the time limit (`12h`) and quota limit (`25%`).
- In-flight background probes monitor weekly quota consumption.
- Once the time expires or quota limit is reached, Principal automatically stops the session and scrubs credentials from `f2`'s machine.

---

## ⚡ Runtime Auto-Discovery & Node Compatibility

Principal requires Node.js 24+ for its ES modules and pre-compiled native SQLite runtime. The launchers (`bin/principal.mjs` and `bin/principal-mcp.mjs`) and installer (`install.sh`) feature intelligent **runtime auto-discovery**:

- **Transparent Version Switching**: If your current interactive shell is running an older Node version (e.g. Node 20 or Node 22 via `fnm`, `nvm`, or system packages), Principal automatically scans candidate runtimes across:
  - FNM aliases and versions (`~/.local/share/fnm/aliases/default/bin/node`, `~/.local/share/fnm/node-versions/v24*`)
  - NVM installations (`~/.nvm/versions/node/v24*`)
  - Local and package manager paths (`~/.local/bin/node`, `/usr/local/bin/node`, `/opt/homebrew/bin/node`)
- **Native ABI Verification**: Before delegating, Principal performs an inline verification check ensuring the candidate binary matches `better-sqlite3`'s native ABI (preventing `NODE_MODULE_VERSION` mismatches and `spawn ENOENT` errors).
- **Zero Configuration**: If Node 24+ is installed anywhere on your system via standard version managers, Principal runs seamlessly without requiring you to switch versions manually in your shell.

---

## 🧹 Uninstallation

```bash
# Automatic uninstall:
./install.sh --uninstall

# Or manually:
rm -f ~/.local/bin/principal ~/.local/bin/principal-mcp
rm -rf ~/.local/share/principal
```
