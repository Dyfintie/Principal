# Principal: Suggested Architecture & Implementation Improvements

> Reviewed and implemented on 2026-10-11. See [implementation decisions and verification](IMPROVEMENTS_IMPLEMENTED.md) before treating the instructions below as current requirements. Wrapped Codex 401 errors use JSON-RPC code `-32603`; raw error data must not be persisted. Indexed records were retained instead of forcing a relational migration. tmux attachment applies to newly multiplexed launches, and the browser bridge is deliberately limited to supported Google HTTPS login links. Older version-specific line numbers below are historical.

This specification is an actionable roadmap for implementing the recommended improvements across the Principal codebase (`/home/varun/principal`). It is structured so an engineering agent can execute each section with exact file locations, line numbers, root-cause details, and concrete acceptance criteria.

---

## Repository Context & Rules of Engagement

- **Root directory**: `/home/varun/principal`
- **Stack**: Node.js 24+, TypeScript, React/Ink (TUI), `better-sqlite3`, Unix Domain Sockets.
- **Workflow verification commands**:
  - Build & compile: `node scripts/workflow.mjs build`
  - Type-check: `node scripts/workflow.mjs check`
  - Test suite (184 tests): `node scripts/workflow.mjs test`
- **Important context**:
  - All existing files are untracked; do not delete or overwrite user data.
  - Sensitive profile and state data lives in `~/.local/state/principal/management/` (including `manager.sqlite`).
  - Antigravity isolation is Linux-only (private HOME, private D-Bus, GNOME keyring).
  - Codex uses `CODEX_HOME` directory isolation.

---

## 1. P0: Fix Codex 401 Unauthorized & Authentication Desync

### The Problem
During diagnostics, profile `codex_main` returned `401 Unauthorized`, but Principal continued displaying `auth: "authenticated"`. The user interface remained out-of-sync with actual provider credentials.

### Root Causes
1. **Error Squashing in [`src/management/codex.ts`](file:///home/varun/principal/src/management/codex.ts#L86-L95)**:
   ```ts
   // codex.ts lines 86-94
   if (item && ('result' in value || 'error' in value)) {
     pending.delete(value.id);
     value.error
       ? item.reject(
           new Error(
             'Codex read operation unavailable; use native authentication or diagnostics',
           ),
         )
       : item.resolve(value.result);
   }
   ```
   When the Codex `app-server` responds with `{ id, error: { code: 401, message: "Unauthorized", ... } }`, `codexRequests` discards the entire `value.error` structure (status code, error message, and error data). It throws a static generic error string.

2. **Silent Swallowing & Cache Retention in [`src/management/service.ts`](file:///home/varun/principal/src/management/service.ts#L704-L715)**:
   ```ts
   // service.ts lines 704-715 (refreshProfile)
   } catch {
     const count = (failure?.count ?? 0) + 1;
     this.failures.set(profile.id, {
       count,
       next: Date.now() + Math.min(300_000 * 2 ** (count - 1), 3_600_000),
     });
     return {
       profileId: profile.id,
       refreshed: false,
       reason:
         'Native observation unavailable; existing data retained with its original timestamp',
     };
   }
   ```
   When `codexRead` throws, `refreshProfile` catches it, sets exponential backoff (starting at 5 minutes and scaling to 1 hour), and **never updates `profile.auth`**. The stored record in `manager.sqlite` retains `auth: 'authenticated'` indefinitely.

3. **Unhandled RPC Rejection in [`src/management/service.ts`](file:///home/varun/principal/src/management/service.ts#L744-L753)**:
   In `inspectProfile`, `codexRead` is called without a local `try/catch`. When `codexRead` rejects on an expired token, the entire RPC call fails, preventing Principal from returning a structured profile state to the caller.

4. **Missing Profile Inspection on Tab Switch in [`src/management/dashboard.tsx`](file:///home/varun/principal/src/management/dashboard.tsx#L126-L150)**:
   On switching to the `/profiles` tab, `inspectCopilotProfiles()` runs, but **Codex and Claude profiles are never inspected**.

### Step-by-Step Implementation Instructions
1. **Update `src/management/codex.ts`**:
   - Create a typed error class `CodexRpcError extends Error` containing `code?: number`, `data?: unknown`.
   - In `lines.on('line')`, if `value.error` is present, construct `new CodexRpcError(value.error.message || 'Codex read error')` and attach `error.code = value.error.code`.
2. **Update `src/management/service.ts`**:
   - In `refreshProfile`: inspect the caught error. If the error is an authentication error (e.g. `code === 401`, or message matches `/unauthorized|invalid token|expired/i`):
     - Update the profile: `auth: 'unauthenticated'`.
     - Record an `auth-observation` record in `this.store` with `status: 'unauthenticated'` and the specific error message.
     - Emit event `this.store.event('profile.observed', profile.id)`.
   - In `inspectProfile`: wrap `codexRead` in `try/catch`. If an auth error occurs, update the profile to `'unauthenticated'` in `this.store` and return `{ profile: updated, reason: `Authentication expired (401 Unauthorized): ${error.message}. Use Shift+D or l to sign in.` }`.
3. **Update `src/management/dashboard.tsx`**:
   - In `selectTab(1)` (Profiles tab), trigger bounded inspections across all configured providers (`codex`, `copilot`, `claude`), not just `copilot`.
   - When a profile's `auth === 'unauthenticated'`, display a clear inline badge in `/profiles`: `[!] Expired (401) · Press D for device login or l to sign in`.

---

## 2. P0: Enrich the `/diagnostics` & `/doctor` View

### The Problem
Tab 3 in [`src/management/dashboard.tsx`](file:///home/varun/principal/src/management/dashboard.tsx#L1556-L1573) currently only displays static CLI binary paths and capability booleans (`installations.map(...)`). It does not run diagnostic checks on enrolled profiles, token expiration, or API reachability.

### Implementation Instructions
1. In `src/management/service.ts`, add an RPC method `diagnostics.report` that:
   - Probes binary availability and version strings for all 5 providers (`codex`, `claude`, `copilot`, `cline`, `antigravity`).
   - Checks Linux isolation prerequisites (`dbus-daemon`, `gnome-keyring-daemon`, `gdbus`, `secret-tool`, Secret Service unlock status).
   - Iterates through enrolled profiles and runs read-only token checks, categorizing each profile as `Healthy`, `Expired/Unauthorized (401)`, `Unreachable`, or `Not Verified`.
2. In `src/management/dashboard.tsx` (Tab 3):
   - Replace the static list with two sections:
     - **Tools & Core Capabilities**: Executables, detected versions, isolation readiness.
     - **Profile Health Matrix**: Per-profile credential validity, last verified timestamp, and remediation keys.

---

## 3. P1: Semver Compatibility Ranges Instead of Strict String Equality

### The Problem
In [`src/management/providers.ts`](file:///home/varun/principal/src/management/providers.ts#L140-L144):
```ts
const verifiedVersion =
  version === definition.version ||
  (tool === 'antigravity' && version === '1.3.1') ||
  (tool === 'copilot' && version === '1.0.95') ||
  (tool === 'claude' && version === '2.1.296');
```
And in [`src/management/antigravity-history.ts`](file:///home/varun/principal/src/management/antigravity-history.ts#L119):
```ts
if (installation.tool !== 'antigravity' || installation.version !== '1.3.3')
  throw new Error('Experimental Antigravity history copying is validated structurally only for 1.3.3');
```
A single patch release (e.g. Claude `2.1.297` or Antigravity `1.3.4`) completely disables verified integrations and history copy features.

### Implementation Instructions
1. Replace strict string equality (`version === '2.1.296'`) with a semver-compatible parser or range check (e.g., allow `^2.1.0` for Claude, `^0.162.0` for Codex, `^1.3.0` for Antigravity).
2. For Antigravity history: rather than checking `version === '1.3.3'`, verify the SQLite schema contract directly (inspecting `conversation_summaries` columns and table structure). If the schema matches, permit the copy operation.

---

## 4. P1: Componentize the Monolithic `dashboard.tsx`

### The Problem
[`src/management/dashboard.tsx`](file:///home/varun/principal/src/management/dashboard.tsx) is over 1,700 lines long and handles:
- Terminal dimensions and resize handling
- Slash command completion
- 4 primary tabs (`/sessions`, `/profiles`, `/usage`, `/diagnostics`)
- 25+ modal dialogs and action menus
- Keypress routing for all shortcuts

### Proposed Architecture
Split `src/management/dashboard.tsx` into modular components:
```
src/management/ui/
├── DashboardApp.tsx       # Root container & keyboard router
├── CommandPalette.tsx     # Slash command input & auto-completion
├── tabs/
│   ├── SessionsTab.tsx    # Tree row rendering & folder expansion
│   ├── ProfilesTab.tsx    # Provider tabs, profile rows, and actions
│   ├── UsageTab.tsx       # Quota meters and countdown clocks
│   └── DiagnosticsTab.tsx # Tool capabilities and profile health
└── modals/
    ├── ActionMenu.tsx     # Pop-up selection menu
    ├── FormDialog.tsx     # Input dialogs with arrow choice selectors
    └── TextViewer.tsx     # Scrollable viewer for observer recipes
```

---

## 5. P2: Relational Schema Normalization & WAL Pruning

### The Problem
In [`src/management/store.ts`](file:///home/varun/principal/src/management/store.ts#L51-L89), all data is stored inside:
```sql
CREATE TABLE records(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
```
- `store.list('binding')` runs `SELECT data FROM records WHERE kind='binding'` and runs `JSON.parse` across **all rows**.
- `store.bind()` and `store.finish()` do in-memory filtering over thousands of past bindings.
- `store.resources()` performs heavy SQL window functions over unindexed `json_extract(...)` calls.
- There is no retention policy; the SQLite DB and WAL grow continuously (>7 MB observed).

### Implementation Instructions
1. Add relational tables with foreign keys and indexes:
   - `invocations(id, entry_id, profile_id, lifecycle, activity, pid, started_at, ended_at)`
   - `bindings(id, invocation_id, conversation_id, started_at, ended_at)`
   - `resources(id, profile_id, metric, bucket, value, observed_at, resets_at)`
2. Add a retention/pruning routine in `service.tick()` or daemon startup:
   - Purge `resources` older than 7 days (`DELETE FROM records WHERE kind='resource' AND json_extract(data, '$.observedAt') < datetime('now', '-7 days')`).
   - Clean up exited external process sightings that are not bound to any conversation.
3. Cache prepared statements on `ManagementStore` instances instead of recompiling SQL on every query.

---

## 6. P2: Non-Destructive Session Attachment (PTY Multiplexing Bridge)

### The Problem
"Jump to current run" cannot attach to an already running native CLI because standard Unix PTYs cannot be reparented without a multiplexer. Principal currently stops the owned process (graceful SIGTERM, then wait 30s, or forced SIGKILL via Python pidfd) and relaunches it from persisted history. This drops in-memory work.

### Implementation Instructions
1. In `src/management/launcher.ts`, detect if `tmux` is available on the host.
2. When launching an agent:
   - Spawn the agent inside a dedicated detached tmux session: `tmux new-session -d -s principal-<invocationId> ...`.
   - Provide an attachment command: `tmux attach-session -t principal-<invocationId>`.
3. Update "Jump to current run":
   - If the invocation was launched inside a tmux session, attach directly without stopping the process:
     ```ts
     // Reattach directly without killing
     await runNative({ executable: 'tmux', args: ['attach-session', '-t', `principal-${id}`], env });
     ```
   - Fall back to the existing stop-and-resume workflow if tmux is unavailable.

---

## 7. P3: Desktop Portal Bridge for Antigravity Isolation

### The Problem
In [`src/management/antigravity-isolation.ts`](file:///home/varun/principal/src/management/antigravity-isolation.ts#L151-L160), `DBUS_SESSION_BUS_ADDRESS` points exclusively to a private D-Bus session. The private bus has no connection to `org.freedesktop.portal.Desktop`. When native `agy` initiates Google OAuth and tries to open the default browser via `xdg-open` or the desktop portal, it fails silently, forcing the user to find and copy URLs manually.

### Implementation Instructions
1. In the private runtime directory, create a shim script for `xdg-open` in `PATH` before launching the agent.
2. The shim script writes the requested URL to a FIFO/socket connected back to the host environment, where the host executes `xdg-open "$URL"` in the user's real desktop session.

---

## Verification Criteria for the Next Agent

Before marking any improvements complete, run the following verification steps in `/home/varun/principal`:

1. **Type Checking**:
   ```bash
   node scripts/workflow.mjs check
   ```
   *Must exit with code 0 and no TypeScript errors.*

2. **Full Test Suite**:
   ```bash
   node scripts/workflow.mjs test
   ```
   *All 184 tests must pass.*

3. **Authentication Verification**:
   - Simulate a 401 response from Codex `app-server` (or test with expired tokens).
   - Verify that `/profiles` immediately reflects `auth: 'unauthenticated'`.
   - Verify that `/diagnostics` reports the exact 401 Unauthorized error with remediation options.
