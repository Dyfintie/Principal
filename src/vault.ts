import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, rm, readdir, open, rename, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { paths, exec, atomicWrite } from './util.js';
export class Vault {
  private file(id: string, generation = 0) {
    return path.join(paths.vault, generation === 0 ? `${id}.enc` : `${id}.${generation}.enc`);
  }
  async key(id: string, create = false): Promise<Buffer> {
    const r = await exec('secret-tool', ['lookup', 'application', 'principal', 'account', id], {
      allowFailure: true,
    });
    const value = r.stdout.toString().trim();
    if (value) {
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32) {
        key.fill(0);
        throw new Error('Invalid key in Secret Service');
      }
      return key;
    }
    if (!create) throw new Error('Account key unavailable: unlock the Linux Secret Service');
    const key = randomBytes(32);
    try {
      await exec(
        'secret-tool',
        ['store', '--label', `Principal account ${id}`, 'application', 'principal', 'account', id],
        { input: key.toString('base64') },
      );
    } catch (error) {
      key.fill(0);
      throw error;
    }
    return key;
  }
  async save(id: string, provider: string, generation: number, plaintext: Buffer) {
    const key = await this.key(id);
    try {
      const nonce = randomBytes(12),
        header = { version: 1, id, provider, generation };
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(header)));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      await atomicWrite(
        this.file(id, generation),
        JSON.stringify({
          ...header,
          nonce: nonce.toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          data: encrypted.toString('base64'),
        }),
      );
    } finally {
      key.fill(0);
    }
  }

  async load(id: string, provider: string, generation: number): Promise<Buffer | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(id, generation), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && generation === 0) return null;
      throw e;
    }
    if (raw.startsWith('PV2!'))
      return this.withSnapshot(id, provider, generation, async (file) =>
        file ? readFile(file) : null,
      );
    const data = JSON.parse(raw);
    if (
      data.version !== 1 ||
      data.id !== id ||
      data.provider !== provider ||
      data.generation !== generation
    )
      throw new Error('Credential snapshot metadata mismatch');
    const key = await this.key(id);
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(data.nonce, 'base64'));
      cipher.setAAD(Buffer.from(JSON.stringify({ version: 1, id, provider, generation })));
      cipher.setAuthTag(Buffer.from(data.tag, 'base64'));
      return Buffer.concat([cipher.update(Buffer.from(data.data, 'base64')), cipher.final()]);
    } finally {
      key.fill(0);
    }
  }

  // Version 2 stores a bounded authenticated header followed by streamed ciphertext
  // and its GCM tag. Version 1 JSON snapshots remain readable.
  async saveStream(id: string, provider: string, generation: number, source: Readable) {
    const key = await this.key(id),
      nonce = randomBytes(12);
    const header = { version: 2, id, provider, generation, nonce: nonce.toString('base64') };
    const aad = Buffer.from(JSON.stringify(header)),
      length = Buffer.alloc(4);
    length.writeUInt32BE(aad.length);
    const temp = `${this.file(id, generation)}.${randomUUID()}.tmp`;
    let size = 0;
    try {
      await atomicWrite(temp, Buffer.concat([Buffer.from('PV2!'), length, aad]));
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad);
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          callback(
            size > 256 * 1024 * 1024 ? new Error('Native home archive exceeds 256 MiB') : null,
            chunk,
          );
        },
      });
      await pipeline(
        source,
        limit,
        cipher,
        createWriteStream(temp, { flags: 'r+', start: 8 + aad.length, mode: 0o600 }),
      );
      const handle = await open(temp, 'a');
      try {
        await handle.write(cipher.getAuthTag());
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, this.file(id, generation));
      const dir = await open(paths.vault, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      key.fill(0);
      await rm(temp, { force: true });
    }
  }
  async withSnapshot<T>(
    id: string,
    provider: string,
    generation: number,
    fn: (file: string | null) => Promise<T>,
  ): Promise<T> {
    const file = this.file(id, generation);
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && generation === 0) return fn(null);
      throw e;
    }
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, 8, 0);
    const dir = await mkdtemp(path.join(tmpdir(), 'principal-native-home-')),
      plain = path.join(dir, 'archive.tar');
    try {
      if (prefix.subarray(0, 4).toString() !== 'PV2!') {
        await handle.close();
        handle = undefined;
        const legacy = await this.load(id, provider, generation);
        try {
          if (legacy) await atomicWrite(plain, legacy);
        } finally {
          legacy?.fill(0);
        }
      } else {
        const n = prefix.readUInt32BE(4);
        if (n > 8192 || n < 1) throw new Error('Invalid native home header');
        const aad = Buffer.alloc(n);
        await handle.read(aad, 0, n, 8);
        const header = JSON.parse(aad.toString());
        if (
          header.version !== 2 ||
          header.id !== id ||
          header.provider !== provider ||
          header.generation !== generation
        )
          throw new Error('Credential snapshot metadata mismatch');
        const st = await handle.stat();
        if (st.size > 256 * 1024 * 1024 + 8216 || st.size < 8 + n + 16)
          throw new Error('Native home archive size is invalid');
        const tag = Buffer.alloc(16);
        await handle.read(tag, 0, 16, st.size - 16);
        const key = await this.key(id);
        try {
          const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.nonce, 'base64'));
          cipher.setAAD(aad);
          cipher.setAuthTag(tag);
          await pipeline(
            createReadStream(file, { start: 8 + n, end: st.size - 17 }),
            cipher,
            createWriteStream(plain, { flags: 'wx', mode: 0o600 }),
          );
        } finally {
          key.fill(0);
        }
      }
      // Authentication has completed before a native runtime sees any plaintext.
      return await fn(plain);
    } finally {
      await handle?.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
  async discardGeneration(id: string, generation: number) {
    await rm(this.file(id, generation), { force: true });
  }
  async remove(id: string) {
    for (const file of await readdir(paths.vault)) {
      if (
        file === `${id}.enc` ||
        (file.startsWith(`${id}.`) && /^\d+\.enc$/.test(file.slice(id.length + 1)))
      )
        await rm(path.join(paths.vault, file), { force: true });
    }
    await exec('secret-tool', ['clear', 'application', 'principal', 'account', id]);
  }
}
