export type ParticipantMeta = { id?: string; avatar?: string | null };

export function parseMeta(metadata: string | undefined): ParticipantMeta {
  try {
    const v: unknown = JSON.parse(metadata || '{}');
    return v && typeof v === 'object' ? (v as ParticipantMeta) : {};
  } catch {
    return {};
  }
}

/** Discord CDN avatar, or the default embed avatar Discord derives from the id. */
export function avatarUrl(id: string, hash: string | null | undefined, size = 64): string {
  if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=${size}`;
  let n = 0;
  try {
    n = Number((BigInt(id) >> 22n) % 6n);
  } catch {}
  return `https://cdn.discordapp.com/embed/avatars/${n}.png`;
}

/** LiveKit identity is "<discord id>:<tab>". */
export const discordIdOf = (identity: string): string => identity.split(':')[0] ?? identity;
