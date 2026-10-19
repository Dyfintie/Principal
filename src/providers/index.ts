import { Runtime } from '../runtime.js';
import type { Account, QuotaSnapshot } from '../schema.js';
import { codexQuota, agyQuota } from './quota.js';
export interface ProviderAdapter {
  inspectAccount(container: string): Promise<{ identity: string | null; plan: string | null }>;
  listModels(container: string): Promise<unknown>;
  readQuota(account: Account, container: string): Promise<QuotaSnapshot>;
  logout(container: string): Promise<boolean>;
}
export class CodexAdapter implements ProviderAdapter {
  constructor(private runtime: Runtime) {}
  async inspectAccount(container: string) {
    const r = await this.runtime.call(container, {
      op: 'inspect',
      provider: 'codex',
      method: 'account/read',
      params: { refreshToken: false },
    });
    if (r.account?.type !== 'chatgpt')
      throw new Error('ChatGPT account login required; API billing is not enabled');
    return { identity: r.account.email ?? null, plan: r.account.planType ?? null };
  }
  async listModels(container: string) {
    return this.runtime.call(container, {
      op: 'inspect',
      provider: 'codex',
      method: 'model/list',
      params: { limit: 100 },
    });
  }
  async readQuota(account: Account, container: string) {
    return codexQuota(
      account.id,
      await this.runtime.call(container, {
        op: 'inspect',
        provider: 'codex',
        method: 'account/rateLimits/read',
      }),
    );
  }
  async logout(container: string) {
    await this.runtime.call(container, {
      op: 'inspect',
      provider: 'codex',
      method: 'account/logout',
    });
    return false; // Native logout does not attest remote OAuth revocation.
  }
}
export class AntigravityAdapter implements ProviderAdapter {
  constructor(private runtime: Runtime) {}
  async inspectAccount(container: string) {
    return this.runtime.call(container, { op: 'identity', provider: 'antigravity' });
  }
  async listModels(container: string) {
    return this.runtime.call(container, {
      op: 'inspect',
      provider: 'antigravity',
      method: 'models',
    });
  }
  async readQuota(account: Account, container: string) {
    return agyQuota(
      account.id,
      await this.runtime.call(container, {
        op: 'inspect',
        provider: 'antigravity',
        method: 'usage',
      }),
    );
  }
  async logout(_container: string) {
    return false; /* No documented headless remote revocation endpoint. */
  }
}
export function adapter(account: Account, runtime: Runtime): ProviderAdapter {
  return account.provider === 'codex' ? new CodexAdapter(runtime) : new AntigravityAdapter(runtime);
}
