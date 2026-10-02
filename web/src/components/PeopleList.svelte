<script lang="ts">
  import { t } from '../lib/i18n/i18n.svelte';
  import type { Peer, RoomController } from '../lib/room.svelte';
  import { qualityLabel } from '../lib/stats';

  let { rc }: { rc: RoomController } = $props();

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

<aside class="side">
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

<style>
  .side {
    min-height: 0;
    overflow: auto;
    padding: 12px 8px;
    background: var(--bg-1);
    border-left: 1px solid var(--border);
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

  @media (max-width: 720px) {
    .side {
      border-left: 0;
      border-top: 1px solid var(--border);
      max-height: 30vh;
    }
  }
</style>
