import { spawn } from 'node:child_process';
import { rpc } from './client.js';
import { Runtime } from './runtime.js';
import { sleep } from './util.js';
import type { Account, Config, Provider } from './schema.js';
export function nextAccountLabel(provider: Provider, accounts: Pick<Account, 'label'>[]) {
  const labels = new Set(accounts.map((a) => a.label));
  let number = 1;
  while (labels.has(`${provider}-${number}`)) number++;
  return `${provider}-${number}`;
}
type EnrollmentDeps = {
  request: typeof rpc;
  antigravity: (container: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  openBrowser: (url: string) => void;
};
const defaults: EnrollmentDeps = {
  request: rpc,
  antigravity: (container) => new Runtime().loginAntigravity(container),
  wait: sleep,
  openBrowser: (url) => {
    // The code and link are always printed, including when no desktop browser exists.
    if (!/^https:\/\//.test(url)) return;
    const child = spawn('xdg-open', [url], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  },
};
export async function enrollAccount(
  provider: Provider,
  options: { label?: string; reauth?: boolean; config: Config; progress?: (text: string) => void },
  deps = defaults,
): Promise<Account> {
  const accounts: Account[] = await deps.request('accounts.list');
  const pending = accounts.find(
    (a) => a.provider === provider && a.status === 'auth_required' && !a.identity,
  );
  const label = options.label ?? pending?.label ?? nextAccountLabel(provider, accounts);
  const existing = accounts.find((a) => a.label === label);
  const reauth =
    options.reauth ?? (existing?.provider === provider && existing.status === 'auth_required');
  if (existing && !reauth)
    throw new Error(
      `Account label ${label} is already registered. Choose another label or inspect /accounts.`,
    );
  const progress = options.progress ?? ((text) => console.error(text));
  progress(`Add ${provider === 'codex' ? 'Codex' : 'Antigravity'} account · ${label}`);
  progress('Sign in with the account you want to add. Ctrl+C cancels.');
  let session: any;
  let finished = false;
  let cancelled = false;
  const abort = () => {
    cancelled = true;
  };
  process.once('SIGINT', abort);
  try {
    session = await deps.request('accounts.begin', {
      provider,
      label,
      reauth,
      config: options.config,
    });
    if (cancelled) throw new Error(`Sign-in cancelled. Retry /${provider} ${label}`);
    if (provider === 'codex') {
      progress(
        `Open ${session.login.verificationUrl}\nEnter code: ${session.login.userCode}\nWaiting for browser sign-in…`,
      );
      deps.openBrowser(session.login.verificationUrl);
      let loggedIn = false;
      for (let attempt = 0; attempt < 400; attempt++) {
        await deps.wait(1500);
        if (cancelled) throw new Error(`Sign-in cancelled. Retry /${provider} ${label}`);
        const status = await deps.request('accounts.loginStatus', { container: session.container });
        if (status?.state === 'failed') throw new Error(status.error ?? 'Login failed');
        if (status?.state === 'completed') {
          loggedIn = true;
          break;
        }
      }
      if (!loggedIn) throw new Error(`Sign-in timed out. Retry /codex ${label}`);
    } else {
      progress(
        'Follow the Google sign-in steps below. Principal will return to chat when sign-in completes.',
      );
      await deps.antigravity(session.container);
    }
    if (cancelled) throw new Error(`Sign-in cancelled. Retry /${provider} ${label}`);
    progress('Verifying account and securely saving credentials…');
    const account: Account = await deps.request('accounts.finish', {
      accountId: session.account.id,
      owner: session.owner,
    });
    finished = true;
    return account;
  } catch (error) {
    if (cancelled) throw new Error(`Sign-in cancelled. Retry /${provider} ${label}`);
    throw error;
  } finally {
    process.removeListener('SIGINT', abort);
    if (!finished && session)
      await deps
        .request('accounts.finish', {
          accountId: session.account.id,
          owner: session.owner,
          abort: true,
        })
        .catch(() => {});
  }
}
