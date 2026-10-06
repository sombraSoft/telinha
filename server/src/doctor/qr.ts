// The doctor link as a terminal QR code. Half-block characters keep it small
// enough for an 80x24 window; the old Windows console (conhost, no WT_SESSION)
// and the Linux text console draw those blocks badly, so they get ANSI
// background colours instead.
import { renderANSI, renderUnicodeCompact } from 'uqr';

export function canDrawBlocks(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  if (env.TERM === 'linux') return false;
  if (platform === 'win32') return !!(env.WT_SESSION || env.TERM_PROGRAM);
  return true;
}

export function renderQr(text: string, o: { env?: Record<string, string | undefined>; platform?: NodeJS.Platform } = {}): string {
  const env = o.env ?? process.env;
  // M: still scans with a smudged or glare-y screen, and a ~100-char URL stays small.
  return canDrawBlocks(env, o.platform) ? renderUnicodeCompact(text, { ecc: 'M' }) : renderANSI(text, { ecc: 'M' });
}
