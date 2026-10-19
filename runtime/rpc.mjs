import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
export class Codex extends EventEmitter {
  pending = new Map();
  sequence = 0;
  closed = false;
  constructor({ command = 'codex', cwd = '/workspace' } = {}) {
    super();
    this.process = spawn(command, ['app-server', '--disable', 'multi_agent'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.on('data', () => {});
    this.process.stdin.on('error', (e) => this.fail(e));
    this.process.on('error', (e) => this.fail(e));
    this.process.on('close', () => this.fail(new Error('Codex app-server closed')));
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        m.error
          ? p.reject(Object.assign(new Error(JSON.stringify(m.error)), { providerError: m.error }))
          : p.resolve(m.result);
      } else if (m.id !== undefined && this.listenerCount('server_request')) {
        this.emit('server_request', m);
      } else if (m.id !== undefined) {
        this.send({
          id: m.id,
          error: { code: -32601, message: 'Principal does not grant interactive approvals' },
        });
        this.emit('denied', m.method);
      } else if (m.method) this.emit(m.method, m.params);
    });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
  send(m) {
    if (!this.closed) this.process.stdin.write(JSON.stringify(m) + '\n');
  }
  request(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Codex app-server is closed'));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  wait(event, timeout = 1800000) {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    return new Promise((resolve, reject) => {
      const done = (x) => {
          cleanup();
          resolve(x);
        },
        closed = (e) => {
          cleanup();
          reject(e);
        },
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`${event} timed out`));
        }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, done);
        this.off('closed', closed);
      };
      this.once(event, done);
      this.once('closed', closed);
    });
  }
  async init() {
    await this.request('initialize', {
      clientInfo: { name: 'principal', title: 'Principal', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized' });
  }
  async stop() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => this.process.kill('SIGKILL'), 2000);
      this.process.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.process.kill('SIGTERM');
    });
  }
}
