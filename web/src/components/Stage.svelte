<script lang="ts">
  import { t } from '../lib/i18n/i18n.svelte';
  import type { RoomSession } from '../lib/room.svelte';
  import { canShareScreen } from '../lib/share';
  import Tile from './Tile.svelte';
  import mascot from '../assets/telinha.webp';

  let { rc }: { rc: RoomSession } = $props();

  const tiles = $derived(rc.tiles);
  const focusMode = $derived(!!rc.focusId);
  const hint = $derived(t('empty.hint').split('{share}'));
  // Phones get no Share button, so no hint pointing at one either.
  const canShare = canShareScreen();
</script>

<section class="stage">
  {#if rc.connected && tiles.length === 0}
    <div class="empty" data-testid="empty-state">
      <img class="mascot" src={mascot} alt="" width="480" height="490" draggable="false" />
      <p class="title">{t('empty.title')}</p>
      {#if canShare}
        <p class="muted">{hint[0]}<b>{t('share.start')}</b>{hint[1] ?? ''}</p>
      {/if}
    </div>
  {:else if !rc.connected && !rc.fatal}
    <div class="empty muted">{t('app.connecting')}</div>
  {/if}

  <!-- One keyed list in a single container: tiles never move in the DOM
       (moving a <video> pauses it), focus only changes the CSS layout. -->
  {#if tiles.length}
    <div class="tiles" class:focus-mode={focusMode} class:single={!focusMode && tiles.length === 1}>
      {#each tiles as p (p.identity)}
        <Tile
          participant={p}
          watchers={rc.participants.filter((v) => v.identity !== p.identity && v.watching.includes(p.identity))}
          focused={rc.focusId === p.identity}
          strip={focusMode && rc.focusId !== p.identity}
          stats={rc.stats[p.identity]}
          onfocus={() => rc.toggleFocus(p.identity)}
          onstop={() => void rc.stopShare()}
        />
      {/each}
    </div>
  {/if}
</section>

<style>
  .stage {
    position: relative;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 16px;
    /* Keeps the bottom free for the share dock at home (App sets it). */
    padding-bottom: max(16px, var(--dock-clear, 0px));
    overflow: auto;
    background: var(--bg-0);
  }

  .empty {
    margin: auto;
    text-align: center;
    padding: 24px;
    /* Centred on the window, not the stage, while the people list is open
       (App sets the shift); as far as the stage leaves room on the right. */
    translate: clamp(0px, var(--stage-shift, 0px), (100cqw - 100%) / 2 - 16px) 0;
  }
  /* Shrinks on short windows so the text below stays in view. */
  .mascot {
    display: block;
    width: auto;
    height: clamp(96px, 30dvh, 240px);
    margin: 0 auto 12px;
    user-select: none;
  }
  .empty .title {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  .empty p {
    margin: 0;
  }

  .tiles {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
    align-content: center;
    flex: 1;
    min-height: 0;
  }

  /* A lone stream fills the stage instead of a 16:9 box that may overflow. */
  .tiles.single {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
  }
  .tiles.single :global(.tile) {
    aspect-ratio: auto;
  }

  /* Focused tile on top, the others as a strip below it. */
  .tiles.focus-mode {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    grid-template-rows: minmax(0, 1fr);
    grid-auto-rows: auto;
    align-content: stretch;
  }
  .tiles.focus-mode :global(.tile.focused) {
    grid-column: 1 / -1;
    grid-row: 1;
    aspect-ratio: auto;
  }
  .tiles.focus-mode :global(.tile.strip) {
    max-width: 260px;
  }

  @media (max-width: 720px) {
    .stage {
      padding: 8px;
      /* The people list's tab pokes 20px up into the stage's bottom edge. */
      padding-bottom: max(28px, var(--dock-clear, 0px));
    }
    .tiles {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
