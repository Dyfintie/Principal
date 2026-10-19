import { realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { Coordinator } from './coordinator.js';
import { ConfigSchema, type Provider } from './schema.js';
import { nativeWorkingDirectory } from './runtime.js';
import { uid } from './util.js';
export interface NativeSession {
  owner: string;
  accountId: string;
  label: string;
  pool: string;
  provider: Provider;
  model: string | null;
  container: string;
  directory: string;
  workingDirectory: string;
  heartbeatAt: number;
  opening?: boolean;
}
const prefix = 'native_session:';
export class NativeSessions {
  constructor(private coordinator: Coordinator) {}
  list(): NativeSession[] {
    return this.coordinator.store.db.prepare('SELECT value FROM meta WHERE key GLOB ?').all(prefix + '*').map((row: any) => JSON.parse(row.value));
  }
  save(session: NativeSession) {
    this.coordinator.store.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(prefix + session.owner, JSON.stringify(session));
  }
  get(owner: string) {
    const session = this.list().find((item) => item.owner === owner);
    if (!session) throw new Error('Native interface is no longer attached');
    return session;
  }
  async open(args: any) {
    const c = this.coordinator;
    const session = args.sessionId ? c.store.session(z.string().parse(args.sessionId)) : undefined;
    if (session) {
      if (!['idle', 'stopped'].includes(session.status)) throw new Error('Wait for Principal work to settle, or use /stop before switching modes');
      await c.sessions.park(session.id);
    }
    const config = ConfigSchema.parse(session?.config ?? args.config ?? {});
    const directory = await realpath(z.string().parse(session?.repo ?? args.repo));
    if (!(await stat(directory)).isDirectory()) throw new Error('Native mode requires a directory');
    const pool = session?.pool ?? args.pool ?? config.pool;
    const ids = session?.accountIds ?? c.store.pool(pool);
    const accounts = c.store.accounts().filter((account) => ids.includes(account.id) && account.status === 'ready');
    const pin = args.account ?? session?.leadAccountId;
    const account = pin ? accounts.find((item) => item.id === pin || item.label === pin) : accounts.find((item) => !c.store.leases().some((lease) => lease.accountId === item.id)) ?? accounts[0];
    if (!account) throw new Error(pin ? 'Choose a ready account from the selected pool' : 'No available account in this pool; connect an account or wait for active work');
    const model = z.string().min(1).max(200).nullable().parse(args.model ?? session?.model ?? null);
    // Background quota checks and idle warm conversations should not block an explicit native launch.
    const probe = c.probeJobs.get(account.id);
    if (probe) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([probe.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, 45000); })]); }
      finally { clearTimeout(timer); }
    }
    for (const idle of c.store.sessions().filter((item) => item.id !== session?.id && item.status === 'idle' && item.leadAccountId === account.id))
      await c.locks.with(`session:${idle.id}`, () => c.sessions.park(idle.id));
    const owner = `native-${uid()}`;
    if (c.store.leases().length >= config.routing.workers) throw new Error('All inference slots are occupied; wait for active work');
    if (!c.store.lease(account.id, owner)) throw new Error(`Account ${account.label} is busy; wait for it to finish`);
    const native: NativeSession = { owner, accountId: account.id, label: account.label, pool, provider: account.provider, model, container: `principal-${uid()}`, directory, workingDirectory: nativeWorkingDirectory(directory), heartbeatAt: Date.now(), opening: true };
    this.save(native);
    c.store.setContainer(account.id, native.container);
    try {
      await c.runtime.create(account, config, { name: native.container, workspace: directory, native: true, attemptId: owner });
      native.heartbeatAt = Date.now();
      native.opening = false;
      this.save(native);
      return native;
    } catch (error) {
      await this.close(owner, false);
      throw error;
    }
  }
  heartbeat(owner: string) {
    const session = this.get(owner);
    session.heartbeatAt = Date.now();
    this.save(session);
    return { attached: true };
  }
  async close(owner: string, snapshot = true) {
    const native = this.list().find((session) => session.owner === owner);
    if (!native) return { closed: true };
    const c = this.coordinator;
    let snapshotError: unknown;
    if (snapshot && await c.runtime.exists(native.container)) {
      await c.runtime.interruptNative(native.container);
      try { await c.runtime.preserveNativeSettings(native.container); await c.runtime.snapshot(c.store.account(native.accountId), native.container); }
      catch (error) { snapshotError = error; }
    }
    await c.safeStopAndRelease(native.accountId, owner, native.container);
    c.store.db.prepare('DELETE FROM meta WHERE key=?').run(prefix + owner);
    if (snapshotError) throw new Error(`Native interface closed, but its latest history could not be saved: ${(snapshotError as Error).message}`);
    return { closed: true };
  }
  async tick() {
    for (const native of this.list()) {
      if (Date.now() - native.heartbeatAt > (native.opening ? 300000 : 60000))
        await this.coordinator.locks.with(native.owner, () => this.close(native.owner));
    }
  }
}
