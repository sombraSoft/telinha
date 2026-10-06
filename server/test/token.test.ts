import { expect, test } from 'bun:test';
import { createToken } from '../src/livekit.ts';

const payload = (jwt: string): Record<string, any> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());

test('token: 10 min, screen share only, identity and metadata', async () => {
  const p = payload(await createToken({
    key: 'devkey', secret: 'a-secret-of-at-least-32-characters!!', room: 'lamo-futi',
    identity: '1:abcdef', name: 'Zé', id: '1', avatar: null,
  }));
  // A leaked link dies quickly; LiveKit refreshes the token of whoever is connected.
  expect(p.exp - p.nbf).toBe(600);
  expect(p.sub).toBe('1:abcdef');
  expect(p.name).toBe('Zé');
  expect(JSON.parse(p.metadata)).toEqual({ id: '1', avatar: null });
  expect(p.video).toEqual({
    room: 'lamo-futi', roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true,
    canUpdateOwnMetadata: true, canPublishSources: ['screen_share', 'screen_share_audio'],
  });
});
