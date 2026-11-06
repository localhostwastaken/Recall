import { gzipSync } from 'fflate';

/** One tar entry for hand-made test archives. `type` is the typeflag character ('0' file, '5' dir, ...). */
export type TarEntry = {
  name: string;
  type?: string;
  mode?: number;
  data?: Uint8Array | string;
  linkname?: string;
  /** ustar prefix field (bytes 345..499), joined to the name with "/". */
  prefix?: string;
  /** ustar (default), GNU magic (whose prefix field is not a path prefix), or none (old v7 tar). */
  magic?: 'ustar' | 'gnu' | 'none';
  /** Overrides the stored checksum (to test a corrupt header). */
  badChecksum?: boolean;
};

const enc = new TextEncoder();

function put(h: Uint8Array, at: number, len: number, s: string | Uint8Array): void {
  const b = typeof s === 'string' ? enc.encode(s) : s;
  if (b.length > len) throw new Error(`field too long: ${String(s)}`);
  h.set(b, at);
}

function octal(h: Uint8Array, at: number, len: number, n: number): void {
  put(h, at, len, n.toString(8).padStart(len - 1, '0') + '\0');
}

export function header(e: TarEntry, size: number): Uint8Array {
  const h = new Uint8Array(512);
  put(h, 0, 100, e.name);
  octal(h, 100, 8, e.mode ?? (e.type === '5' ? 0o775 : 0o664));
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h[156] = (e.type ?? '0').charCodeAt(0);
  if (e.linkname) put(h, 157, 100, e.linkname);
  if (e.prefix) put(h, 345, 155, e.prefix);
  if (e.magic === 'gnu') put(h, 257, 8, 'ustar  \0');
  else if (e.magic !== 'none') put(h, 257, 8, 'ustar\x0000');
  let sum = 0;
  for (const b of h) sum += b;
  if (e.badChecksum) sum += 1;
  put(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

/** A pax extended header body: "<len> key=value\n" records, where len counts the whole record. */
export function paxData(records: Record<string, string>): string {
  let out = '';
  for (const [k, v] of Object.entries(records)) {
    const tail = ` ${k}=${v}\n`;
    const tailLen = enc.encode(tail).length;
    let len = tailLen + 1;
    while (String(len).length + tailLen !== len) len = String(len).length + tailLen;
    out += `${len}${tail}`;
  }
  return out;
}

/** A tar archive; `end` replaces the two zero blocks that close it. */
export function tar(entries: TarEntry[], end: Uint8Array = new Uint8Array(1024)): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : (e.data ?? new Uint8Array(0));
    parts.push(header(e, data.length));
    if (data.length) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      parts.push(padded);
    }
  }
  parts.push(end);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const tgz = (entries: TarEntry[], end?: Uint8Array): Uint8Array => gzipSync(tar(entries, end));
