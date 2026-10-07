// The setup screens driven with keys and `setup --non-interactive` with the
// same answers as flags (secrets from the environment) write byte-identical
// telinha.env files.
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { run } from '../src/cli/setup.ts';
import { parseEnvFile } from '../src/envfile.ts';
import { paste, press, typeText, until } from './tui-harness.tsx';
import {
  APP, at, CHANNEL, CHANNEL2, ctxFor, defaultsToReview, discordKeys, DUCK, ENV, GUILD, homeDuckKeys, machine, PUBLIC_IP, ROLE, SECRET, startSetup, TOKEN, TUNNEL,
  type Started,
} from './tui-setup-fixtures.ts';

setDefaultTimeout(20_000);

const QUIET = ['--lang', 'en', '--no-service', '--no-upnp', '--no-doctor'];
const SECRETS = { DISCORD_TOKEN: TOKEN, DISCORD_CLIENT_SECRET: SECRET };
const DISCORD_FLAGS = ['--guild', GUILD, '--role', ROLE, '--channels', CHANNEL, '--command', 'telinha'];
const SSLIP = `https://${PUBLIC_IP.replaceAll('.', '-')}.sslip.io`;

/** The file the screens write after `keys`, and the one --non-interactive writes for `flags`. */
async function both(o: { keys(r: Started): Promise<void>; flags: string[]; env: Record<string, string>; extra?: string[] }) {
  const r = await startSetup([...QUIET, ...(o.extra ?? [])]);
  await o.keys(r);
  await defaultsToReview(r);
  await press(r.s, 'enter');
  await until(r.s, /Telinha is (running|set up)/, 5000);
  await press(r.s, 'enter');
  expect(await r.code).toBe(0);
  const plain = machine();
  const { ctx, err } = ctxFor(['setup', '--non-interactive', ...QUIET, ...(o.extra ?? []), ...o.flags], { tty: false, env: o.env });
  expect(await run({ flags: {}, positionals: [], rest: [] }, ctx, plain.deps), err.join('\n')).toBe(0);
  return { screens: r.files.get(ENV)!, plain: plain.files.get(ENV)! };
}

async function vpsDomain(r: Started): Promise<void> {
  await at(r, 'hosting');
  await press(r.s, '2');
  await at(r, 'vpsAddress');
  await press(r.s, '1');
  await at(r, 'domain');
  await typeText(r.s, 't.example.com');
  await press(r.s, 'enter');
}

describe('setup screens (keys) and --non-interactive write the same telinha.env', () => {
  test('home, no domain: DuckDNS on 8443', async () => {
    const f = await both({
      keys: async (r) => {
        await homeDuckKeys(r);
        await discordKeys(r);
      },
      flags: ['--host', 'home', '--duckdns-domain', 'my-group', ...DISCORD_FLAGS],
      env: { ...SECRETS, DUCKDNS_TOKEN: DUCK },
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars).toMatchObject({ HOSTING: 'home', PUBLIC_URL: 'https://my-group.duckdns.org:8443', ACME_DNS: 'duckdns', UPNP: 'auto' });
  });

  test('home, a domain on Cloudflare: the tunnel from the pasted install command', async () => {
    const f = await both({
      keys: async (r) => {
        await at(r, 'hosting');
        await press(r.s, '1');
        await at(r, 'homeCf');
        await press(r.s, '1');
        await at(r, 'tunnelToken');
        await paste(r.s, `cloudflared service install ${TUNNEL}`);
        await press(r.s, 'enter');
        await at(r, 'tunnelHost');
        await typeText(r.s, 't.example.com');
        await press(r.s, 'enter');
        await discordKeys(r);
      },
      flags: ['--host', 'home', '--ingress', 'tunnel', '--public-url', 'https://t.example.com', ...DISCORD_FLAGS],
      env: { ...SECRETS, TUNNEL_TOKEN: TUNNEL },
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars).toMatchObject({ INGRESS: 'tunnel', TUNNEL_TOKEN: TUNNEL });
  });

  test('VPS, no domain: sslip.io from the public IP', async () => {
    const f = await both({
      keys: async (r) => {
        await at(r, 'hosting');
        await press(r.s, '2');
        await at(r, 'vpsAddress');
        await press(r.s, '3');
        await discordKeys(r);
      },
      flags: ['--host', 'vps', '--public-url', SSLIP, '--node-ip', PUBLIC_IP, ...DISCORD_FLAGS],
      env: SECRETS,
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars).toMatchObject({ HOSTING: 'vps', PUBLIC_URL: SSLIP, LIVEKIT_NODE_IP: PUBLIC_IP, UPNP: 'off' });
  });

  test('VPS, own domain, media ports changed', async () => {
    const f = await both({
      keys: async (r) => {
        await vpsDomain(r);
        await discordKeys(r);
        await at(r, 'media');
        await press(r.s, 'enter');
        await at(r, 'turn');
        await press(r.s, 'enter');
        await at(r, 'mediaPorts');
        await press(r.s, '2');
        await at(r, 'mediaTcp');
        await typeText(r.s, '50000');
        await press(r.s, 'enter');
        await at(r, 'mediaUdp');
        await typeText(r.s, '50001');
        await press(r.s, 'enter');
      },
      flags: ['--host', 'vps', '--public-url', 'https://t.example.com', '--media-tcp', '50000', '--media-udp', '50001', '--turn', 'on', ...DISCORD_FLAGS],
      env: SECRETS,
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars).toMatchObject({ HTTP_PORT: '80', HTTPS_PORT: '443', MEDIA_TCP_PORT: '50000', MEDIA_UDP_PORT: '50001' });
  });

  test('Discord offline: the ids typed', async () => {
    const f = await both({
      extra: ['--no-discord-check'],
      keys: async (r) => {
        await vpsDomain(r);
        await at(r, 'discordToken');
        await paste(r.s, TOKEN);
        await press(r.s, 'enter');
        await at(r, 'clientId');
        await typeText(r.s, APP);
        await press(r.s, 'enter');
        await at(r, 'clientSecret');
        await paste(r.s, SECRET);
        await press(r.s, 'enter');
        await at(r, 'guild');
        await typeText(r.s, GUILD);
        await press(r.s, 'enter');
        await at(r, 'role');
        await typeText(r.s, ROLE);
        await press(r.s, 'enter');
        await at(r, 'channels');
        await typeText(r.s, `${CHANNEL},${CHANNEL2}`);
        await press(r.s, 'enter');
      },
      flags: ['--host', 'vps', '--public-url', 'https://t.example.com', '--client-id', APP, '--turn', 'on', ...DISCORD_FLAGS.map((x) => (x === CHANNEL ? `${CHANNEL},${CHANNEL2}` : x))],
      env: SECRETS,
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars).toMatchObject({ DISCORD_CLIENT_ID: APP, CHANNEL_IDS: `${CHANNEL},${CHANNEL2}` });
  });

  test('online: the client id comes from the token\'s application, as --client-id gives it', async () => {
    const f = await both({
      keys: async (r) => {
        await vpsDomain(r);
        await discordKeys(r);
      },
      flags: ['--host', 'vps', '--public-url', 'https://t.example.com', '--client-id', APP, '--turn', 'on', ...DISCORD_FLAGS],
      env: SECRETS,
    });
    expect(f.screens).toBe(f.plain);
    expect(parseEnvFile(f.screens).vars.DISCORD_CLIENT_ID).toBe(APP);
  });
});
