import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

/**
 * Who has been written to, and who has asked not to be.
 *
 * Both lists hold a hash of the address rather than the address, which is
 * enough to answer "have we written to this person" and "have they opted out"
 * without keeping a mailing list of academics on disk.
 *
 * The whole legal argument for this being a one-off relevant message rather
 * than a campaign rests on nobody being written to twice, so the sent log is
 * checked before every send and written after.
 */

export const normalise = (address) => String(address).trim().toLowerCase();
const digest = (address) => createHash('sha256').update(normalise(address)).digest('hex');

/** A tamper-proof opt-out link that needs no lookup table. */
export function unsubscribeLink(siteUrl, address, secret) {
  const encoded = Buffer.from(normalise(address), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(normalise(address)).digest('base64url').slice(0, 22);
  return `${siteUrl.replace(/\/$/, '')}/unsubscribe?a=${encoded}&t=${signature}`;
}

/** Reads back an opt-out link. Returns the address, or null if it was forged. */
export function readUnsubscribe({ a, t }, secret) {
  if (typeof a !== 'string' || typeof t !== 'string') return null;
  let address;
  try {
    address = normalise(Buffer.from(a, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;

  const expected = createHmac('sha256', secret).update(address).digest('base64url').slice(0, 22);
  const given = Buffer.from(t);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return address;
}

export class MailLog {
  constructor(dir) {
    this.dir = dir;
    this.files = {
      sent: path.join(dir, 'sent.json'),
      suppressed: path.join(dir, 'suppressed.json'),
    };
    this.cache = {};
  }

  async #read(which) {
    if (this.cache[which]) return this.cache[which];
    try {
      const parsed = JSON.parse(await readFile(this.files[which], 'utf8'));
      this.cache[which] = new Set(Array.isArray(parsed?.hashes) ? parsed.hashes : []);
    } catch {
      this.cache[which] = new Set();
    }
    return this.cache[which];
  }

  async #write(which) {
    await mkdir(this.dir, { recursive: true });
    const target = this.files[which];
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({
      updated: new Date().toISOString(),
      hashes: [...this.cache[which]],
    }));
    await rename(temp, target);
  }

  /** Has this address already been written to? */
  async alreadySent(address) {
    return (await this.#read('sent')).has(digest(address));
  }

  async isSuppressed(address) {
    return (await this.#read('suppressed')).has(digest(address));
  }

  /** May we write to this address at all? */
  async mayContact(address) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalise(address))) return { ok: false, reason: 'invalid' };
    if (await this.isSuppressed(address)) return { ok: false, reason: 'opted out' };
    if (await this.alreadySent(address)) return { ok: false, reason: 'already written to' };
    return { ok: true };
  }

  async markSent(address) {
    (await this.#read('sent')).add(digest(address));
    await this.#write('sent');
  }

  async suppress(address) {
    (await this.#read('suppressed')).add(digest(address));
    await this.#write('suppressed');
  }

  async counts() {
    return {
      sent: (await this.#read('sent')).size,
      suppressed: (await this.#read('suppressed')).size,
    };
  }
}
