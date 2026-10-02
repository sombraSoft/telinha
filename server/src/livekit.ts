// LiveKit access tokens: members may join, watch and only publish screen share.
import { AccessToken, TrackSource } from 'livekit-server-sdk';

export const ROOM_RE = /^[A-Za-z0-9_-]{4,40}$/;

// One identity per tab: LiveKit kicks the older connection on a duplicate
// identity, and people do open the room twice (stream in one, watch in another).
export const newIdentity = (userId: string, random: (n: number) => Uint8Array) =>
  `${userId}:${Buffer.from(random(3)).toString('hex')}`;

export async function createToken(o: {
  key: string; secret: string; room: string; identity: string; name: string; id: string; avatar: string | null;
}): Promise<string> {
  const at = new AccessToken(o.key, o.secret, {
    identity: o.identity, name: o.name, ttl: '6h', metadata: JSON.stringify({ id: o.id, avatar: o.avatar || null }),
  });
  at.addGrant({
    room: o.room, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true, canUpdateOwnMetadata: true,
    canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
  });
  return at.toJwt();
}
