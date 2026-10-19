# 🔄 Context Export & Seamless Assistant Handoff

## 1. Overview & Problem Statement

When working with LLM coding assistants like OpenAI Codex, users frequently exhaust their usage allowances or hit weekly / 5-hour quota rate limits mid-task. Switching assistants (for example, continuing the work in **Google Antigravity**) traditionally required tedious manual copy-pasting, re-explaining the goals, re-reading modified files, and debugging context gaps from scratch.

Principal's **Context Export Engine** solves this problem by parsing native Codex rollout execution logs and synthesizing a high-fidelity, LLM-optimized **Context Handoff** document and a compact CLI seed prompt. This enables immediate, seamless continuation of the task in Antigravity or any supported assistant with zero loss of progress.

---

## 2. Core Architecture

```
   ┌─────────────────────────────────────────────────────────┐
   │            Codex Session Rollout (.jsonl)               │
   │  (session_meta, user turns, tool calls, error states)   │
   └───────────────────────────┬─────────────────────────────┘
                               │
                               ▼
   ┌─────────────────────────────────────────────────────────┐
   │               Context Export Engine                     │
   │  • stripBoilerplate()   - cleans system XML wrappers    │
   │  • parseCodexRollout()  - extracts goals, tools, files  │
   │  • synthesizeContextHandoff()                           │
   └─────────────┬───────────────────────────┬───────────────┘
                 │                           │
                 ▼                           ▼
   ┌───────────────────────────┐  ┌───────────────────────────┐
   │  High-Fidelity Markdown   │  │   Condensed Seed Prompt   │
   │   .principal/context-     │  │   • System Clipboard      │
   │   handoff-<id>.md         │  │   • Immediate CLI Launch  │
   └───────────────────────────┘  └───────────────────────────┘
```

### Key Components

1. **`stripBoilerplate(text: string)`**:
   Strips internal XML blocks (such as `<environment_context>`, `<skills_instructions>`, `<multi_agent_role>`, `<system_reminder>`, `<turn_aborted>`) so the exported context contains only true human intent and instructions.

2. **`parseCodexRollout(records: any[])`**:
   Extracts:
   - All human user goals and queries in chronological order.
   - Files read, edited, created, or patched (`write_to_file`, `edit_file`, `apply_patch`, etc.).
   - Commands executed with execution status, highlighting failures and exit codes.
   - Last assistant response and runtime error traces.

3. **`synthesizeContextHandoff(parsed, meta)`**:
   Generates two deliverables:
   - **Full Markdown Handoff Document**: Includes task objectives, touched files list, recent shell commands, last recorded error/blocker, and recommended immediate actions for the target tool.
   - **Condensed Seed Prompt**: A focused 150–250 word prompt suitable for launching `agy "<seedPrompt>"` or pasting into a new chat.

4. **Storage & Clipboard**:
   - Saves handoff documents to `.principal/context-handoff-<id>.md` (tracked cleanly in the project directory).
   - Copies the seed prompt to the system clipboard using Wayland `wl-copy` or X11 `xclip`.

---

## 3. Usage Guide

### A. CLI Commands

From any terminal shell:

```bash
# Export the most recent Codex session to .principal/context-handoff-<id>.md
principal export

# Export a specific session by native thread ID or entry ID
principal export 01912345-6789-abcd-ef01-23456789abcd

# Export and automatically copy the seed prompt to your clipboard
principal export --clip

# Export and immediately launch Antigravity seeded with the context
principal export --launch

# Export to a custom path or specific target assistant
principal export --to claude --output ./handoff.md
```

### B. Inside Principal TUI

1. **Interactive Keyboard Shortcut**:
   - In `/sessions` (default tab), navigate to any Codex session row.
   - Press **`Shift+E`** (or press **`Space`** and choose **`Export context to Antigravity (handoff)`**).
   - An interactive modal appears allowing you to customize destination assistant, clipboard copy, file persistence, and automatic launch.
2. **Slash Command**:
   - Press `/` from anywhere in Principal.
   - Type `/export` or `/export <sessionId>` (supports Tab autocomplete and Up/Down history recall).
   - Press Enter to review the formatted handoff summary in the TUI text viewer.

---

## 4. Example Output

### Generated Markdown Document (`.principal/context-handoff-01912345.md`)

```markdown
# 🔄 Context Handoff: Codex → Antigravity

**Original Session**: Refactor authentication flow  
**Native Thread ID**: `01912345-6789-abcd-ef01-23456789abcd`  
**Working Directory**: `/home/varun/my-project`  
**Export Date**: 2026-10-18T04:15:00.000Z  

---

## 🎯 Task Objective & User Requests
1. Refactor authentication flow to support multi-account sessions.
2. Ensure token refresh errors do not invalidate the persistent keyring.

---

## 🛠️ Files Touched & Modified
- `src/auth.ts`
- `src/keyring.ts`
- `tests/auth.test.ts`

---

## 💻 Recent Commands Executed
- `npm run build` ✔
- `npm test` ❌ *(failed)*

### ⚠️ Last Recorded Error / Blocker
```
FAIL: Token expiry test failed: expected valid refresh token
```

---

## 💬 State When Codex Stopped (Quota Limit Hit)
I updated keyring.ts and added the refresh method in auth.ts, but test runner failed on token expiry assertions. Needs token validation tweak.

---

## 🚀 Recommended Immediate Actions for Antigravity
1. Review current workspace status and git diff in `/home/varun/my-project` (`git status`, `git diff`).
2. Verify existing changes and resolve any pending errors noted above.
3. Continue implementing the task objectives outlined in Section 1 without restarting from scratch.
```

---

## 5. Verification & Tests

Unit tests are implemented in `tests/context-export.test.mjs`:
- `stripBoilerplate` cleans system tags from prompt text.
- `parseCodexRollout` correctly extracts turns, commands, errors, and modified files.
- `synthesizeContextHandoff` produces rich markdown and seed prompt.
- `locateCodexRollout` and `saveHandoffDocument` safely read and write to disk.
- `service.exportContext` validates full RPC handling with mock rollouts and database profiles.
