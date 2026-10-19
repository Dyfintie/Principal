# Experimental Antigravity conversation snapshots

Checked 2026-10-11. This feature copies local history records, not account credentials. Native continuation under a different Google account has **not** been verified. No real history or login was changed during implementation checks.

## User flow

1. Sign into isolated Antigravity profiles A and B through `/profiles`. Native authentication owns the Google login flow.
2. Close both native agents, including Antigravity CLIs launched outside Principal.
3. Select A in `/profiles` → Antigravity and press **Shift+I**. Choose **Native Antigravity history**, inspect the count and confirm. Supported local conversations are copied into A.
4. Select B and press **Shift+I**. Choose **A** as the source and confirm to copy its supported history into B. The result shows copied, already loaded and failed counts. Successful copies are retained if another conversation fails.
5. Open `/sessions`. Alternatively, press **h** on A in `/profiles` to register its existing history, then select a conversation in `/sessions` and press **Shift+C** to copy only that conversation into B.
6. **Shift+R** presents an experimental warning before attempting native continuation. Direct command-based resume refuses copied histories until that TUI warning is acknowledged.

There is no live synchronization. Changes to A's local snapshot do not change B's files. Copies retain native conversation IDs and original workspace paths; they do not copy the repository or establish safe concurrent native continuation with the same ID across accounts. Separate files are locally verified; native runtime/backend behavior still requires a live check. Use separate worktrees for concurrent repository edits, but this version cannot remap opaque Antigravity workspace records to a different worktree.

## Storage and boundaries

The source is the native directory `~/.gemini/antigravity-cli`, or a selected profile's directory. Each isolated destination uses its own profile HOME and encrypted private keyring runtime. SQLite online backup includes committed WAL pages; opaque step, generation, executor and trajectory metadata blobs remain unchanged. Principal publishes a new owned database without a hard link to source storage and inserts the selected native summary into the destination index.

Native IDs are preserved **within separate profile directories**. Principal's session registry uses profile identity plus native ID, so A and B appear separately. Existing destination IDs are refused rather than overwritten. Profile credentials, authentication settings and keyrings are never read or copied by this history module. Copying a conversation imports only its selected summary and any required indexed ancestors; it never imports the entire source summary database.

Files must be canonical, owned, regular files without symlinks and no larger than 256 MiB each. Source SQLite schema and integrity are checked. Source database/index fingerprints are checked before publication to reject observed concurrent changes; this is not a global transaction across a running native runtime. Owned active or uncertain source/destination invocations block copying. External Antigravity CLI processes with unknown ownership block copying. Starting a native CLI outside Principal during a copy remains a race, so keep native agents closed until the operation finishes.

## Supported subset

- The baseline inspected format is Antigravity **1.3.3**. Installed versions are eligible only when every source/destination passes the supported SQLite summary/conversation contracts and safety checks. Unknown schemas remain blocked. Matching schemas do not prove compatibility of opaque protobuf payloads or native cross-account continuation; copying stays experimental.
- At most 1,000 indexed conversations per source, each with one local workspace path; deleted workspaces can be retained as history but must be restored before native resume.
- Valid UUID IDs, matching native cascade ID and supported seven-table conversation schema plus the inspected summary schema.
- No active native summaries, opaque parent-reference blobs, subtrajectories or battle metadata. Indexed summary parent links are copied in dependency order when all ancestors are available; cyclic or missing parent chains are refused.
- No remote-only history, desktop history not yet imported by the native CLI, external attachments, implicit-cache protobuf files, artifacts or project files. Opaque records that depend on those omitted resources may fail to continue in the native tool.

Batch loading attempts this supported subset and reports per-conversation failures. Malformed/multi-workspace index records are not offered as supported candidates. Nothing is deleted from the source. Principal makes no automatic model request to validate copied history.

## Difference from Codex

Codex exposes structured thread interfaces. Principal's version-specific Codex copy obtains a **new native fork ID** and preserves rollout content beneath that identity, then checks native destination recognition. Antigravity's published CLI exposes interactive `/fork`, resume selection and `--conversation`, but no verified cross-account history-import interface. Its local records are SQLite with opaque protobuf blobs, so this feature **does not call `/fork`, invent IDs or rewrite protobuf identities**. It preserves IDs and records in independent local storage instead.

Native `/fork` remains the supported mechanism for a new independent Antigravity conversation ID within the native runtime. It does not itself establish a cross-account import contract. Principal cannot promise that a different account accepts these local snapshots or that the backend never scopes history by native ID. Treat continuation as experimental until the test below passes.

## Verification and next gate

Synthetic tests verify opaque record preservation, independent local writes, credentials unchanged, committed WAL data, repeated imports, conflicts, active-profile guards, version rejection, unsupported dependencies, unsafe paths and rollback when summary validation fails. Build, type checking and the full test suite are run separately.

User-controlled next gate: create a disposable native conversation with account A, close A, copy it into B, inspect native resume recognition under B, then check whether a reply in B leaves A's native history and context unchanged. Repeat across restarts and parallel distinct conversations. Do not use valuable original conversations for this first validation. Login, quota use and real native continuation were not performed by the implementation tests.

Official references, checked 2026-10-11: [native conversations and /fork](https://antigravity.google/docs/cli/conversations), [resume and native desktop imports](https://antigravity.google/docs/cli/commands/resume), [public CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md). These document native behavior; they do not endorse this experimental local copy mechanism.

A registry record alone is not treated as already loaded: the destination summary, database schema and native cascade ID are checked. Indexed conversations whose source databases are missing are reported as unavailable local history, not copied as empty placeholders.
