// LiveKit access tokens (members may join, watch and only publish screen
// share) and the RoomService calls the room lifecycle needs.
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

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

/** What the lifecycle reads from a participant (a subset of ParticipantInfo). */
export interface LiveParticipant {
  identity: string;
  metadata: string;
  attributes: Record<string, string>;
  tracks: { source: TrackSource }[];
}

export interface RoomService {
  /** Idempotent: LiveKit returns the existing room when it is still there. */
  ensureRoom(room: string): Promise<void>;
  /** [] when LiveKit has no such room (never created, or dropped when idle). */
  listParticipants(room: string): Promise<LiveParticipant[]>;
  /** No-op when the room is already gone. */
  deleteRoom(room: string): Promise<void>;
}

export const isNotFound = (e: unknown) => {
  const err = e as { status?: unknown; code?: unknown } | null;
  return err?.status === 404 || err?.code === 'not_found';
};

export function roomService(o: {
  url: string; key: string; secret: string; closeEmptySeconds: number;
}): RoomService {
  const client = new RoomServiceClient(o.url, o.key, o.secret);
  return {
    async ensureRoom(room) {
      // auto_create is off, so this is the only way a room comes to exist.
      // emptyTimeout outlives our own close so LiveKit never drops a room
      // before anyone had the chance to open the link.
      await client.createRoom({ name: room, emptyTimeout: o.closeEmptySeconds + 120, departureTimeout: 20 });
    },
    async listParticipants(room) {
      try {
        return await client.listParticipants(room);
      } catch (e) {
        if (isNotFound(e)) return [];
        throw e;
      }
    },
    async deleteRoom(room) {
      try {
        await client.deleteRoom(room);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
  };
}
