<script module lang="ts">
  /** The list's id, for the toggles' aria-controls (the header one and the edge one). */
  export const PEOPLE_ID = 'people-panel';
</script>

<script lang="ts">
  import { avatarUrl } from '../lib/avatar';
  import { t } from '../lib/i18n/i18n.svelte';
  import { type Member, splitMembers, statusKey } from '../lib/members';
  import { prefs } from '../lib/prefs.svelte';
  import type { Participant, RoomSession } from '../lib/room.svelte';
  import { qualityLabel } from '../lib/stats';

  let { rc, members, open, ontoggle }: { rc: RoomSession; members: Member[]; open: boolean; ontoggle: () => void } =
    $props();

  const byId = $derived(new Map(rc.participants.map((p) => [p.identity, p])));
  // Whoever is in the room is listed above, with what they are doing. Never
  // ourselves (the list usually arrives before we are connected), so nothing
  // until the token says who we are.
  const split = $derived(
    rc.user
      ? splitMembers(members, new Set([rc.user.id, ...rc.participants.map((p) => p.id)]))
      : { online: [], offline: [] },
  );

  function status(p: Participant): { text: string; live: boolean } {
    if (p.stream) {
      const q = qualityLabel(rc.stats[p.identity]);
      return { text: `🔴 ${t('people.streaming')}${q ? ` · ${q}` : ''}`, live: true };
    }
    const names = p.watching.map((id) => byId.get(id)?.label).filter(Boolean);
    return { text: names.length ? t('people.watching', { names: names.join(', ') }) : t('people.idle'), live: false };
  }
</script>

{#snippet member(
  m: Member,
)}
  {@const label = t(statusKey(m.status))}
  <li class="member" data-testid="member-item" data-status={m.status}>
    <span class="av">
      <img class="avatar lg" src={avatarUrl(m.id, m.avatar)} alt="" loading="lazy" />
      <!-- Colour and shape (Discord's dot, moon, bar, ring); the text is for screen readers. -->
      <span class="dot {m.status}" title={label} aria-hidden="true"></span>
    </span>
    <span class="name">{m.name}<span class="sr-only">, {label}</span></span>
  </li>
{/snippet}

<!-- The column's width comes from App (--side-w); the list keeps its full width
     inside a clipping box, so it slides out instead of squeezing its rows. -->
<div class="people" class:open data-testid="people">
  <!-- On the list's edge, so it stays reachable as a tab on the stage edge when collapsed. -->
  <button
    type="button"
    class="handle"
    data-testid="people-handle"
    aria-label={t('people.toggle')}
    title={t('people.toggle')}
    aria-expanded={open}
    aria-controls={PEOPLE_ID}
    onclick={ontoggle}
  >
    <span aria-hidden="true">{open ? '›' : '‹'}</span>
  </button>
  <div class="clip">
    <aside class="side" id={PEOPLE_ID} inert={!open}>
      <h2>{t('people.title')} <span class="muted">— {rc.participants.length}</span></h2>
      <ul data-testid="people-list">
        {#each rc.participants as p (p.identity)}
          {@const s = status(p)}
          <li data-testid="people-item">
            <img class="avatar lg" src={p.avatar} alt="" />
            <div class="who">
              <div class="name">{p.label}{p.local ? ` ${t('you')}` : ''}</div>
              <div class="sub" class:live={s.live}>{s.text}</div>
            </div>
          </li>
        {/each}
      </ul>

      {#if split.online.length}
        <h2 class="sec">{t('people.online')} <span class="muted">— {split.online.length}</span></h2>
        <ul data-testid="online-list">
          {#each split.online as m (m.id)}
            {@render member(m)}
          {/each}
        </ul>
      {/if}

      {#if split.offline.length}
        <h2 class="sec">
          <button
            type="button"
            class="sec-toggle"
            data-testid="offline-toggle"
            aria-expanded={prefs.offline}
            aria-controls="offline-list"
            onclick={() => prefs.setOffline(!prefs.offline)}
          >
            <span class="chev" aria-hidden="true">›</span>
            {t('people.offline')} <span class="muted">— {split.offline.length}</span>
          </button>
        </h2>
        <ul class="offline" id="offline-list" data-testid="offline-list" hidden={!prefs.offline}>
          {#each split.offline as m (m.id)}
            {@render member(m)}
          {/each}
        </ul>
      {/if}
    </aside>
  </div>
</div>

<style>
  .people {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 0;
  }
  .clip {
    display: flex;
    min-height: 0;
    overflow: hidden;
  }
  .side {
    flex: none;
    width: var(--people-w);
    min-height: 0;
    overflow: auto;
    padding: 12px 8px;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
  }
  /* Hidden once the slide is over (and shown at once on open), so a collapsed
     list is out of the tab order and the accessibility tree. */
  .people:not(.open) .side {
    visibility: hidden;
    transition: visibility 0s 0.2s;
  }

  /* A tab on the stage's right edge, above the share dock. Only as deep as
     the dock's edge margin (DOCK_MARGIN in dock.ts), so the two never overlap. */
  .handle {
    position: absolute;
    top: 50%;
    right: 100%;
    z-index: 6;
    display: grid;
    place-items: center;
    width: 16px;
    height: 48px;
    padding: 0;
    translate: 0 -50%;
    border: 1px solid var(--border);
    border-right: 0;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    background: var(--bg-1);
    color: var(--text-muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    transition:
      color 0.12s,
      background-color 0.12s;
  }
  .handle:hover {
    background: var(--bg-2);
    color: var(--text);
  }
  .handle span {
    /* The glyphs sit low in most fonts. */
    margin-top: -2px;
  }
  h2 {
    margin: 4px 8px 8px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
  }
  li:hover {
    background: var(--hover);
  }
  .who {
    min-width: 0;
  }
  .name,
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name {
    font-weight: 500;
  }
  .sub {
    font-size: 12px;
    color: var(--text-muted);
  }
  /* The Online / Offline sections, under the room. */
  .sec {
    margin-top: 16px;
  }
  .sec-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin: -2px -4px;
    padding: 2px 4px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    text-align: left;
    cursor: pointer;
  }
  .sec-toggle:hover {
    color: var(--text);
  }
  .chev {
    display: inline-block;
    width: 10px;
    font-size: 14px;
    line-height: 1;
    transition: rotate 0.15s;
  }
  .sec-toggle[aria-expanded='true'] .chev {
    rotate: 90deg;
  }
  li.member {
    /* Holds the absolutely placed status text: otherwise it escapes the
       folded list's clip and makes the page scroll. */
    position: relative;
    padding: 4px 8px;
  }
  li.member .name {
    /* Also holds the status text inside the clipped name: placed after the
       full name it would make the sidebar scroll sideways. */
    position: relative;
    min-width: 0;
  }
  /* Greyed like Discord's, but the name only goes muted so it keeps its
     contrast, and the dot keeps its own (only the picture fades). */
  .offline .av .avatar {
    opacity: 0.5;
  }
  .offline .name {
    color: var(--text-muted);
  }
  .offline li:hover .av .avatar {
    opacity: 1;
  }
  .offline li:hover .name {
    color: var(--text);
  }
  .av {
    position: relative;
    flex: none;
    display: block;
    /* The ring around the dot is the row's colour (the sidebar, plus the hover
       tint on hover), cut into the avatar like Discord's. */
    --ring: var(--bg-1);
    --ring-tint: transparent;
  }
  li:hover .av {
    --ring-tint: var(--hover);
  }
  .av .avatar {
    display: block;
  }
  .dot {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 16px;
    height: 16px;
    border: 3px solid transparent;
    border-radius: 50%;
    overflow: hidden;
    background:
      linear-gradient(var(--dot), var(--dot)) padding-box,
      linear-gradient(var(--ring-tint), var(--ring-tint)) border-box,
      linear-gradient(var(--ring), var(--ring)) border-box;
  }
  .dot::after {
    content: '';
    position: absolute;
    background: linear-gradient(var(--ring-tint), var(--ring-tint)), var(--ring);
  }
  .dot.online {
    --dot: #23a55a;
  }
  /* Moon: a ring-coloured bite out of the top left. */
  .dot.idle {
    --dot: #f0b232;
  }
  .dot.idle::after {
    top: -2px;
    left: -2px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  /* A bar across the middle. */
  .dot.dnd {
    --dot: #f23f43;
  }
  .dot.dnd::after {
    top: 4px;
    left: 2px;
    width: 6px;
    height: 2px;
    border-radius: 1px;
  }
  /* Hollow ring. */
  .dot.offline {
    --dot: #80848e;
  }
  .dot.offline::after {
    top: 2.5px;
    left: 2.5px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }

  /* The 🔴 carries the colour: red 12px text is under 4.5:1 on Ash and Light. */
  .sub.live {
    color: var(--text);
    font-weight: 600;
  }

  /* Under the stage: the list folds down, the tab sits on the stage's bottom edge. */
  @media (max-width: 720px) {
    .clip {
      display: block;
      max-height: 30vh;
      transition: max-height 0.2s ease;
    }
    .people:not(.open) .clip {
      max-height: 0;
    }
    .side {
      width: auto;
      border-left: 0;
      border-top: 1px solid var(--border);
      max-height: 30vh;
    }
    .handle {
      top: auto;
      right: 12px;
      bottom: 100%;
      width: 48px;
      height: 16px;
      translate: none;
      border: 1px solid var(--border);
      border-bottom: 0;
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    /* › and ‹ turned to point down (fold) and up (unfold). */
    .handle span {
      margin-top: 0;
      rotate: 90deg;
    }
  }
</style>
