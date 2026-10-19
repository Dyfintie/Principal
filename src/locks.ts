export class Locks {
  private pending = new Map<string, Promise<void>>();
  async with<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = previous.then(() => next);
    this.pending.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.pending.get(key) === tail) this.pending.delete(key);
    }
  }
}
