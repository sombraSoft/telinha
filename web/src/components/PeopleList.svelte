<script module lang="ts">
  /** The list's id, for the toggles' aria-controls (the header one and the edge one). */
  export const PEOPLE_ID = 'people-panel';
</script>

<script lang="ts">
  import { t } from '../lib/i18n/i18n.svelte';
  import type { Peer, RoomController } from '../lib/room.svelte';
  import { qualityLabel } from '../lib/stats';

  let { rc, open, ontoggle }: { rc: RoomController; open: boolean; ontoggle: () => void } = $props();

  const byId = $derived(new Map(rc.peers.map((p) => [p.identity, p])));

  function status(p: Peer): { text: string; live: boolean } {
    if (p.stream) {
      const q = qualityLabel(rc.stats[p.identity]);
      return { text: `🔴 ${t('people.streaming')}${q ? ` · ${q}` : ''}`, live: true };
    }
    const names = p.watching.map((id) => byId.get(id)?.name).filter(Boolean);
    return { text: names.length ? t('people.watching', { names: names.join(', ') }) : t('people.idle'), live: false };
  }
</script>

<!-- The column's width comes from App (--side-w); the list keeps its full width
     inside a clipping box, so it slides out instead of squeezing its rows. -->
<div class="people" class:open data-testid="people">
  <!-- On the list's edge, so it stays reachable as a tab on the stage edge when collapsed. -->
  <button
    class="handle"
    data-testid="people-handle"
    aria-label={t('people.toggle')}
    title={t('people.toggle')}
    aria-expanded={open}
    aria-controls={PEOPLE_ID}
    onclick={ontoggle}><span aria-hidden="true">{open ? '›' : '‹'}</span></button
  >
  <div class="clip">
    <aside class="side" id={PEOPLE_ID} inert={!open}>
      <h2>{t('people.title')} <span class="muted">— {rc.peers.length}</span></h2>
      <ul data-testid="people-list">
        {#each rc.peers as p (p.identity)}
          {@const s = status(p)}
          <li data-testid="people-item">
            <img class="avatar lg" src={p.avatar} alt="" />
            <div class="who">
              <div class="name">{p.name}{p.local ? ` ${t('you')}` : ''}</div>
              <div class="sub" class:live={s.live}>{s.text}</div>
            </div>
          </li>
        {/each}
      </ul>
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
    transition: color 0.12s, background-color 0.12s;
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
