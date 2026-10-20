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
 * withdrawn) and a from-me flag (6). Layout per the elt and arraypress readers.
 */
export function decodeReactions(blob: Uint8Array): StoredReaction[] {
  try {
    const reactions = new ProtoMessage(blob).message(7)?.messages(1) ?? [];
    return reactions
      .map((r) => ({ senderJid: r.uint(6) === 1 ? null : (r.string(2) ?? null), emoji: r.string(3) ?? '' }))
      .filter((r) => r.emoji);
  } catch {
    return [];
  }
}
