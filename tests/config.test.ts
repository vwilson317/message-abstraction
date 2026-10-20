import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('never polls WhatsApp faster than 250 ms, whatever WHATSAPP_POLL_MS says', () => {
    const pollMs = (value?: string) =>
      loadConfig(value === undefined ? {} : { WHATSAPP_POLL_MS: value }).whatsappMac.pollMs;
    expect(pollMs()).toBe(1500);
    expect(pollMs('')).toBe(1500);
    expect(pollMs('abc')).toBe(1500);
    expect(pollMs('0')).toBe(1500);
    expect(pollMs('100')).toBe(1500);
    expect(pollMs('3000')).toBe(3000);
  });
});
