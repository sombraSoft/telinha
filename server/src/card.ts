// The command's message as a live status card. Pure: the lifecycle compares the
// rendered payloads and only edits Discord when they differ.
import {
  type APIActionRowComponent,
  type APIButtonComponentWithURL,
  ButtonStyle,
  ComponentType,
  escapeMarkdown,
} from 'discord.js';
import { type Key, type Locale, t } from './i18n.ts';
import type { RoomRecord } from './rooms.ts';

/** Who is in the room, one entry per person (Discord user). */
export interface Live {
  /** People sharing a screen. quality: e.g. "1080p60 · H265", as the page reports it */
  streamers: { id: string; quality?: string }[];
  /** People present and not streaming. */
  viewers: string[];
}

export interface Card {
  content: string;
  components: APIActionRowComponent<APIButtonComponentWithURL>[];
  allowedMentions: { parse: [] };
}

export interface CardOptions {
  publicUrl: string;
  /** Group name in the card's locale (for the tip line). */
  group: string;
}

/** Discord's message limit. */
export const MAX_CONTENT = 2000;

export function formatDuration(l: Locale, ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return t(l, 'durLessMin');
  if (min < 60) return t(l, 'durMin', { m: String(min) });
  const h = String(Math.floor(min / 60));
  return min % 60 ? t(l, 'durHours', { h, m: String(min % 60) }) : t(l, 'durHoursOnly', { h });
}

type List = { key: Key; items: string[] };

function listText(items: string[], shown: number): string {
  const head = items.slice(0, shown).join(', ');
  const rest = items.length - shown;
  return rest ? `${head} +${rest}`.trim() : head;
}

/**
 * Joins the lines, cutting the longest mention list one entry at a time
 * (shown as "+N") until the message fits.
 */
function fit(l: Locale, parts: (string | List)[]): string {
  const lists = parts.filter((p): p is List => typeof p !== 'string' && p.items.length > 0);
  const shown = lists.map((p) => p.items.length);
  const build = () =>
    parts
      .map((p) =>
        typeof p === 'string'
          ? p
          : p.items.length
            ? t(l, p.key, { list: listText(p.items, shown[lists.indexOf(p)]!) })
            : null,
      )
      .filter((s): s is string => s !== null)
      .join('\n');
  let out = build();
  while (out.length > MAX_CONTENT) {
    const i = shown.indexOf(Math.max(0, ...shown));
    if (i < 0 || !shown[i]) break;
    shown[i]!--;
    out = build();
  }
  return out;
}

const mention = (id: string) => `<@${id}>`;

/**
 * Member-typed text (display name, the command's "what") as plain text: no
 * markdown, masked links or mention/channel/timestamp tags in a message the
 * bot authored (allowedMentions only stops the pings, not the rendering).
 */
export const plain = (s: string) => escapeMarkdown(s, { maskedLink: true }).replace(/</g, '\\<');

export function renderCard(rec: RoomRecord, live: Live, o: CardOptions): Card {
  const l = rec.locale;
  const what = rec.what ? `: ${plain(rec.what)}` : '';
  const who = plain(rec.openerName);
  const allowedMentions = { parse: [] as [] };

  if (rec.closedAt !== null) {
    const lasted =
      rec.firstJoinAt === null
        ? t(l, 'cardNobody')
        : t(l, 'cardLasted', { duration: formatDuration(l, (rec.lastSeenAt ?? rec.firstJoinAt) - rec.firstJoinAt) });
    const content = fit(l, [
      t(l, 'cardClosed', { who, what }),
      lasted,
      { key: 'cardSeen', items: rec.seen.map(mention) },
    ]);
    return { content, components: [], allowedMentions };
  }

  const content = fit(l, [
    t(l, 'opened', { who, what }),
    {
      key: 'cardStreaming',
      items: live.streamers.map((s) => (s.quality ? `${mention(s.id)} (${s.quality})` : mention(s.id))),
    },
    // Only while someone streams: with nothing on, arrivals are not worth an edit.
    { key: 'cardInRoom', items: live.streamers.length ? live.viewers.map(mention) : [] },
    // Discord renders the relative time itself, so the clock needs no edits.
    t(l, 'cardOpenedAt', { when: `<t:${Math.floor(rec.createdAt / 1000)}:R>` }),
    t(l, 'tip', { group: o.group }),
  ]);
  return {
    content,
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            style: ButtonStyle.Link,
            label: t(l, 'open'),
            emoji: { name: '📺' },
            url: `${o.publicUrl}/r/${rec.room}`,
          },
        ],
      },
    ],
    allowedMentions,
  };
}
