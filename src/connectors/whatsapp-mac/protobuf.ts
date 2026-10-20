/**
 * Just enough protobuf to read the few undocumented blobs WhatsApp keeps in its
 * Mac database. Fields are read by number; unknown wire types stop the parse.
 */
export class ProtoMessage {
  private readonly fields = new Map<number, (number | Uint8Array)[]>();

  constructor(bytes: Uint8Array) {
    let pos = 0;
    const varint = (): number => {
      let result = 0;
      let shift = 0;
      for (;;) {
        if (pos >= bytes.length) throw new RangeError('Truncated varint');
        const byte = bytes[pos++]!;
        // Multiplication instead of << keeps values above 2^31 (millisecond timestamps) exact.
        result += (byte & 0x7f) * 2 ** shift;
        if (!(byte & 0x80)) return result;
        shift += 7;
        if (shift > 63) throw new RangeError('Varint too long');
      }
    };
    while (pos < bytes.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      let value: number | Uint8Array;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const len = varint();
        if (pos + len > bytes.length) throw new RangeError('Truncated field');
        value = bytes.subarray(pos, pos + len);
        pos += len;
      } else if (wire === 1) {
        pos += 8;
        continue;
      } else if (wire === 5) {
        pos += 4;
        continue;
      } else throw new RangeError(`Unsupported wire type ${wire}`);
      const list = this.fields.get(field);
      if (list) list.push(value);
      else this.fields.set(field, [value]);
    }
  }

  uint(field: number): number | undefined {
    const v = this.fields.get(field)?.[0];
    return typeof v === 'number' ? v : undefined;
  }

  string(field: number): string | undefined {
    const v = this.fields.get(field)?.[0];
    return v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined;
  }

  message(field: number): ProtoMessage | undefined {
    const v = this.fields.get(field)?.[0];
    return v instanceof Uint8Array ? new ProtoMessage(v) : undefined;
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? []).filter((v) => v instanceof Uint8Array).map((v) => new ProtoMessage(v));
  }
}

export interface StoredReaction {
  /** Null for the account owner's own reaction. */
  senderJid: string | null;
  emoji: string;
}

/**
 * Reactions live in ZWAMESSAGEINFO.ZRECEIPTINFO: field 7 holds repeated field 1,
 * each with the sender (2, absent for your own), emoji (3, absent once
 * withdrawn), a time in ms (4) and a from-me flag (6). A changed reaction can
 * leave an older entry behind, so only each sender's latest counts. Layout per
 * the elt and arraypress readers.
 */
export function decodeReactions(blob: Uint8Array): StoredReaction[] {
  try {
    // Keyed by sender ('' for you); a Map keeps each sender where they first reacted.
    const latest = new Map<string, { emoji: string; at: number }>();
    for (const r of new ProtoMessage(blob).message(7)?.messages(1) ?? []) {
      const sender = r.uint(6) === 1 ? '' : (r.string(2) ?? '');
      const at = r.uint(4) ?? 0;
      if (at >= (latest.get(sender)?.at ?? -1)) latest.set(sender, { emoji: r.string(3) ?? '', at });
    }
    return [...latest].filter(([, r]) => r.emoji).map(([sender, r]) => ({ senderJid: sender || null, emoji: r.emoji }));
  } catch {
    return [];
  }
}

export interface Quote {
  /** Stanza id of the quoted message, in the same chat. */
  stanza: string;
  /** Who sent it, as the reply names them (often a LID); absent for your own. */
  senderJid: string | null;
}

/**
 * A reply's context lives in its media item's ZMETADATA, even for plain text:
 * field 5 is the quoted message's stanza id and field 6 its sender. Layout per
 * the elt, arraypress and IPED readers.
 */
export function decodeQuote(blob: Uint8Array): Quote | null {
  try {
    const metadata = new ProtoMessage(blob);
    const stanza = metadata.string(5);
    return stanza ? { stanza, senderJid: metadata.string(6) ?? null } : null;
  } catch {
    return null;
  }
}
