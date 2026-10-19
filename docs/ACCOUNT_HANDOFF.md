# Scoped Account Handoff Architecture & Safe Credential Sharing

## 1. Overview & Objective
When users have surplus, unused quota or token limits on an AI coding assistant (such as **Google Antigravity** or **OpenAI Codex**), they often want to share this allowance with a friend, collaborator, or team member before the quota window resets.

Traditionally, sharing an account would require giving someone the primary account credentials or logging in directly on their machine. For Google accounts, this is extremely hazardous: logging in via a browser grants full access to **Gmail, Google Drive, Google Photos, Saved Passwords, YouTube, search history, and financial billing**.

**Principal Scoped Account Handoff** solves this problem by enabling users to share **strictly assistant-scoped tokens** in an armored, tamper-resistant bundle. The recipient imports the bundle into Principal, which provisions an **isolated sandbox profile** on their machine. The recipient can use Antigravity or Codex CLI quota through Principal, while having **zero access** to the owner's Google account or browser data.

Furthermore, when sharing an account with a friend or collaborator who might otherwise use the quota recklessly, the owner (**f1**) can set **enforceable constraints**:
1. **Time Limit**: The session expires after $X$ hours from handoff (e.g. `4h`, `12h`, `1d`).
2. **Quota Limit**: The recipient is capped to consume at most $X\%$ of the weekly quota limit (e.g. `20%`). When that threshold is reached, sessions are automatically terminated and credentials scrubbed.

---

## 2. Threat Model & Security Boundaries

```mermaid
graph TD
    subgraph OwnerMachine["Account Owner's Machine (f1)"]
        GPass["Google Password / Master Auth"] -.->|NEVER EXTRACTED| Blocked[Excluded]
        GCookies["Browser Cookies / Chrome Vault"] -.->|NEVER EXTRACTED| Blocked
        Gmail["Gmail / Drive / Photos / Cloud"] -.->|NEVER ACCESSIBLE| Blocked

        OwnerProfile["Principal Profile Sandbox"] --> Extract["Scoped Token Extractor"]
        Extract --> Token["Assistant OAuth Token Only\n(Audience: Cloud Code Assist CLI)"]
        Constraints["Constraints Engine\n• Time Limit (e.g. 4h)\n• Quota Floor (e.g. baseline - 20%)"] --> Encrypt
        Token --> Encrypt["AES-256-GCM + Scrypt Key Derivation"]
        Encrypt --> ArmoredBundle["Armored Handoff Bundle\nPRINCIPAL-HANDOFF:v1:..."]
    end

    ArmoredBundle ==>|Encrypted Transport / Chat / QR| RecipientMachine

    subgraph RecipientMachine["Recipient's Machine (f2)"]
        Import["principal handoff import"] --> Decrypt["AES-256-GCM Decrypt\n(Passphrase Verification)"]
        Decrypt --> IsolatedSandbox["Principal Isolated Profile\n(chmod 0700/0600)"]
        IsolatedSandbox --> GuardEngine["Double Guard Enforcement\n• Pre-Launch Guard (prepare)\n• In-Flight Runtime Guard (tick & observe)"]
        GuardEngine --> AssistantExecution["Principal / CLI Agent Execution\n(Uses owner's quota)"]
        AssistantExecution -.->|RESTRICTED SCOPE| GoogleOAuth["Google OAuth Endpoint\n(Scopes: Cloud Code Assist CLI ONLY)"]
        AssistantExecution -.x|BLOCKED BY GOOGLE SCOPES| OtherGoogleServices["Gmail / Drive / Photos / Passwords"]
        GuardEngine -.->|Limit Reached| Terminate["Stop Active Process (SIGTERM/SIGKILL)\nScrub Local Credentials File"]
    end
```

### What is Shared:
- **Google Antigravity**: Only the OAuth access and refresh token for the official Cloud Code Assist CLI client (`1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`) stored in `antigravity-oauth-token` or native keyring.
- **OpenAI Codex**: Only the CLI assistant token payload from `auth.json`.
- **Metadata**: Tool name, masked email hint (e.g. `v***y@gmail.com`), expiration timestamp, baseline quota, and allowed floor.

### What is NEVER Shared or Extracted:
- Primary Google passwords or 2FA credentials.
- Browser cookies, WebKit/Chromium profile state, or active web sessions.
- Google Drive, Gmail, Photos, or Google Cloud IAM master keys.
- OpenAI platform organization billing or master API keys.

### Containment & Enforcement Guarantees:
1. **Cryptographic Tamper-Resistance**: AES-256-GCM authenticated encryption with a user-supplied passphrase, derived via `scrypt` (salt 32 bytes, N=32768, r=8, p=1). Constraints are embedded inside the encrypted payload. Modifying the time or quota limits invalidates the authentication tag.
2. **Delta Quota Budgeting**: When exporting, Principal captures the current remaining quota as a baseline (e.g., $85\%$ remaining). If f1 sets `--quota-limit 20%`, f2's cutoff floor is set to $85\% - 20\% = 65\%$ remaining. Even if f1 already used part of the quota, f2 is strictly limited to their allotted slice.
3. **Double Guard & Background Daemon (Pre-Launch, In-Flight & Idle Scan)**:
   - **Pre-Launch Guard** (`service.prepare`): Verifies `Date.now() < expiresAt` and `currentHeadroom > allowedQuotaFloor` before starting any agent. If expired or exhausted, the profile is purged immediately.
   - **In-Flight Runtime Guard** (`service.tick` & `service.observe`): Real-time statusline observation callbacks and periodic background daemon ticks monitor active sessions. If the time limit or quota floor is hit, Principal immediately stops the agent process (`SIGTERM` -> `SIGKILL`) and purges the profile.
   - **Idle Expiration Scan** (`service.tick`): Even when no agent is actively launched, the daemon continuously monitors all handoff profiles and purges them the moment their time expires.
4. **Total Data Purge Everywhere (Zero Residue)**:
   Upon constraint breach or expiration, Principal does not merely mark the profile inactive—it executes an atomic **Total Purge**:
   - **Profile Record**: Removed from SQLite (`records` table `kind='profile'`).
   - **Usage Observations**: All quota/token observations (`kind='resource'`) for this profile are permanently deleted from database and unified inventory.
   - **Auth Observations**: All auth logs (`kind='auth-observation'`) for this profile are deleted.
   - **Sandboxes & Tokens**: The isolated profile sandbox directory (`~/.local/state/principal/profiles/<id>`), token files (`antigravity-oauth-token`, `auth.json`), and settings on disk are deleted (`rm -rf`).
   - **Active Pointers**: Profile references in `settings` (`active-profiles`, `ui.selected`) are cleaned up.
   - Zero ghost records remain in `principal usage`, `principal profiles`, `principal doctor`, or disk.
5. **Headless & Container-Ready Direct Launch**:
   Handoff profiles in Docker or headless environments (where desktop Secret Service, `gdbus`, or `secret-tool` are unavailable) launch seamlessly via direct token binding without waiting on native keyring IPC, completely preventing startup timeouts.
6. **Instant Revocation**: The account owner can revoke access at any time from:
   - Google: `https://myaccount.google.com/permissions` -> remove **Google Cloud Code Assist** / **Antigravity**.
   - OpenAI: `https://platform.openai.com/api-keys` or Codex settings.

---

## 3. Data Flow & Bundle Format

### Armored Handoff Bundle Format
The bundle is serialized as JSON, optionally encrypted, and encoded with a standard armor header:
```text
PRINCIPAL-HANDOFF:v1:<base64-payload>
```

When inspected or exported as JSON:
```json
{
  "version": 1,
  "tool": "antigravity",
  "label": "shared-antigravity",
  "accountHint": "v***y@gmail.com",
  "createdAt": "2026-10-18T21:00:00.000Z",
  "encrypted": true,
  "salt": "a1b2c3d4...",
  "iv": "e5f6g7h8...",
  "authTag": "i9j0k1l2...",
  "payload": "<ciphertext-base64>",
  "constraints": {
    "timeLimitHours": 6,
    "expiresAt": "2026-10-19T03:00:00.000Z",
    "quotaLimitPercent": 20,
    "baselineQuotaRemaining": 85.0,
    "allowedQuotaFloor": 65.0,
    "exportedAt": "2026-10-18T21:00:00.000Z",
    "status": "active"
  }
}
```

The decrypted `payload` contains:
```json
{
  "credentials": {
    "token": { "access_token": "ya29...", "refresh_token": "1//0..." }
  },
  "constraints": {
    "timeLimitHours": 6,
    "expiresAt": "2026-10-19T03:00:00.000Z",
    "quotaLimitPercent": 20,
    "baselineQuotaRemaining": 85.0,
    "allowedQuotaFloor": 65.0
  }
}
```

---

## 4. Usage & Workflows

### A. CLI Commands

#### 1. Exporting an Account with Constraints (Owner)
```bash
# Export with 4-hour time limit and 20% weekly quota limit to clipboard:
principal handoff export antigravity --time-limit 4h --quota-limit 20% --clip

# Export with encryption passphrase and 1-day time limit:
principal handoff export cdx-secondary --passphrase "secret" --time-limit 1d --quota-limit 15% --out ./friend.pauth

# Shorthand alias:
principal ho export antigravity --time-limit 6h --quota-limit 25% --clip
```

#### 2. Importing an Account (Recipient)
```bash
# Import an armored bundle directly from CLI argument:
principal handoff import "PRINCIPAL-HANDOFF:v1:ey..." --passphrase "secret"

# Import from a file with a custom profile label:
principal handoff import ./friend.pauth --label "shared-antigravity"
```

#### 3. Checking Handoff Status & Remaining Limits
```bash
# View active handoff profiles, remaining time, and quota allowance:
principal handoff status

# JSON output for scripting:
principal handoff status --json
```

#### 4. Manual Profile Removal & Total Purge
```bash
# Soft removal (marks profile removed, preserves credentials & history):
principal profiles remove <profile-id-or-label>

# Complete total purge (permanently wipes profile, credentials, sandboxes, and usage data everywhere):
principal profiles purge <profile-id-or-label>
# or
principal profiles remove <profile-id-or-label> --purge
```

### B. Interactive TUI & Slash Commands

Within the Principal Dashboard:
- Run `/handoff export` or `/handoff import`.
- In the `/profiles` tab:
  - Press `W` to export the currently highlighted profile (opens dialog with Passphrase, Time limit, and Quota limit fields).
  - Press `Y` to open the handoff import modal.
- Active handoff profiles display:
  - List badge: `[HANDOFF]`, `[TIME EXPIRED]`, or `[QUOTA EXHAUSTED]`.
  - Details pane: Shows masked email hint, remaining hours, and quota budget percentage.

---

## 5. Shared History Integration
Imported handoff profiles are immediately wired into Principal's **Shared Conversation History** (`SHARED_CONVERSATION_HISTORY.md`):
- The recipient has their own isolated execution environment for tokens and quotas.
- If common conversation history is enabled, both accounts can access shared project artifacts and logs without copying or overwriting data.
