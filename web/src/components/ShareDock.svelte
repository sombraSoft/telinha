<script lang="ts">
  import { tick, untrack } from 'svelte';
  import {
    clampTo,
    DOCK_MARGIN,
    homeOf,
    nearHome,
    type Point,
    parseDockPos,
    placeDock,
    type Screen,
    toFraction,
  } from '../lib/dock';
  import { t } from '../lib/i18n/i18n.svelte';
  import type { RoomSession } from '../lib/room.svelte';
  import { canShareScreen } from '../lib/share';
  import { load, save } from '../lib/store';
  import ShareModal from './ShareModal.svelte';

  let {
    rc,
    clearance = $bindable(0),
  }: {
    rc: RoomSession;
    /** Room the stage keeps free at its bottom (px), so the dock at home hides no tile controls. */
    clearance?: number;
  } = $props();

  // Phones can't capture the screen: no dock at all there.
  const canShare = canShareScreen();

  let stageW = $state(0);
  let stageH = $state(0);
  let dockW = $state(0);
  let dockH = $state(0);
  let area = $state<HTMLDivElement>();
  let windowW = $state(window.innerWidth);
  let stageLeft = $state(0);
  /** Stored centre as a fraction of the stage; null = home (bottom-centre). */
  let frac = $state.raw<Point | null>(parseDockPos(load('dock', null)));
  let drag = $state.raw<{ dx: number; dy: number; at: Point } | null>(null);
  let snapping = $state(false);
  let snapTimer: ReturnType<typeof setTimeout> | undefined;
  let modalOpen = $state(false);
  let shareBtn = $state<HTMLButtonElement>();
  let qualityBtn = $state<HTMLButtonElement>();

  const stage = $derived({ width: stageW, height: stageH });
  const dock = $derived({ width: dockW, height: dockH });
  // Home is centred on the window, so it stays put while the people list opens or closes.
  const screen = $derived<Screen>({ stageLeft, width: windowW });
  // Derived from the sizes, so it re-clamps whenever the stage or dock resizes.
  const pos = $derived(drag?.at ?? placeDock(frac, dock, stage, screen));

  // The stage's left edge only moves when the layout does, which resizes it or the window.
  $effect(() => {
    void stageW;
    void windowW;
    stageLeft = area?.getBoundingClientRect().left ?? 0;
  });

  const codecInfo = $derived(
    rc.share ? `${rc.share.codec.toUpperCase()} · ${rc.share.audio ? t('share.withSound') : t('share.noSound')}` : '',
  );

  $effect(() => {
    if (rc.fatal) modalOpen = false;
  });

  // Only at home: dragged elsewhere, the user already moved it off what it covered.
  $effect(() => {
    clearance = canShare && !frac && dockH ? dockH + 2 * DOCK_MARGIN : 0;
  });

  // Share turns into Stop when the share starts: focus left there (the modal
  // hands it back) would end the stream on one stray Enter. Quality is safe.
  $effect(() => {
    if (!rc.share) return;
    untrack(() => {
      void tick().then(() => {
        const at = document.activeElement;
        if (at === shareBtn || at === document.body) qualityBtn?.focus();
      });
    });
  });

  function place(next: Point | null) {
    frac = next;
    save('dock', next);
  }

  // Animated only when it jumps home, never while dragging or resizing.
  function goHome() {
    snapping = true;
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => (snapping = false), 250);
    place(null);
  }

  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, at: pos };
  }
  function onMove(e: PointerEvent) {
    if (!drag) return;
    drag = { ...drag, at: clampTo({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, dock, stage) };
  }
  function onUp() {
    if (!drag) return;
    const at = drag.at;
    drag = null;
    if (nearHome(at, homeOf(dock, stage, screen))) goHome();
    else place(toFraction(at, stage));
  }

  // The grip is a button so keyboards can move the dock too.
  function onGripKey(e: KeyboardEvent) {
    const step = e.shiftKey ? DOCK_MARGIN * 4 : DOCK_MARGIN;
    const moves: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    if (e.key === 'Home') {
      e.preventDefault();
      goHome();
      return;
    }
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    place(toFraction(clampTo({ x: pos.x + m.x, y: pos.y + m.y }, dock, stage), stage));
  }

  function onDblclick(e: MouseEvent) {
    // On the grip or the pill itself; a double click on a button is two clicks.
    if (e.target instanceof Element && e.target.closest('button:not(.grip)')) return;
    goHome();
  }

  function onShare() {
    if (rc.share) void rc.stopShare();
    else modalOpen = true;
  }
</script>

<svelte:window bind:innerWidth={windowW} />

{#if canShare}
  <!-- Spans the stage only, so the dock can't be dragged over the people list. -->
  <div class="area" bind:this={area} bind:clientWidth={stageW} bind:clientHeight={stageH}>
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions (double click = the grip's Home key) -->
    <!-- biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend layout -->
    <div
      class="dock"
      class:ready={stageW > 0 && dockW > 0}
      class:dragging={!!drag}
      class:snapping
      role="group"
      aria-label={t('share.dock')}
      data-testid="share-dock"
      style:transform="translate({pos.x - dockW / 2}px, {pos.y - dockH / 2}px)"
      bind:offsetWidth={dockW}
      bind:offsetHeight={dockH}
      ondblclick={onDblclick}
    >
      <button
        type="button"
        class="grip"
        data-testid="dock-grip"
        aria-label={t('dock.grip')}
        aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home"
        title={t('dock.grip')}
        onpointerdown={onDown}
        onpointermove={onMove}
        onpointerup={onUp}
        onpointercancel={onUp}
        onkeydown={onGripKey}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>

      <!-- One button for both states: Share opens the modal, Stop ends the share at once. -->
      <button
        type="button"
        bind:this={shareBtn}
        class="btn share"
        class:primary={!rc.share}
        class:danger={!!rc.share}
        data-testid="share-button"
        title={rc.share ? t('share.stop') : undefined}
        aria-haspopup={rc.share ? undefined : 'dialog'}
        disabled={!rc.connected || rc.busy}
        onclick={onShare}
      >
        <span aria-hidden="true">{rc.share ? '⏹' : '🖥️'}</span>
        {rc.share ? t('tile.stop') : t('share.start')}
      </button>

      {#if rc.share}
        <button
          type="button"
          bind:this={qualityBtn}
          class="btn share"
          data-testid="share-quality"
          aria-haspopup="dialog"
          disabled={!rc.connected}
          onclick={() => (modalOpen = true)}
        >
          <span aria-hidden="true">⚙</span>
          {t('share.quality')}
        </button>
        <span class="info" data-testid="share-info">{codecInfo}</span>
      {/if}
    </div>
  </div>

  <ShareModal {rc} bind:open={modalOpen} fallback={shareBtn} />
{/if}

<style>
  .area {
    position: absolute;
    inset: 0;
    z-index: 5;
    overflow: hidden;
    pointer-events: none;
  }
  .dock {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 4px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-2);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
    user-select: none;
    pointer-events: auto;
    /* Hidden until measured, so it never flashes at the top-left corner. */
    visibility: hidden;
  }
  .dock.ready {
    visibility: visible;
  }
  .dock.snapping {
    transition: transform 0.2s ease-out;
  }

  .grip {
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    /* WCAG 2.2 target size: at least 24px wide. */
    min-width: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    font-size: 16px;
    line-height: 1;
    letter-spacing: -0.1em;
    cursor: grab;
    touch-action: none;
  }
  .grip:hover {
    color: var(--text);
  }
  .dragging,
  .dragging .grip {
    cursor: grabbing;
  }

  .share {
    min-height: 40px;
    padding: 8px 18px;
    border-radius: 999px;
    font-size: 15px;
  }
  /* Quality: outlined, so it reads as a button on the light theme's white pill too. */
  .share:not(.primary, .danger) {
    border-color: var(--border);
  }
  .info {
    padding-right: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  @media (max-width: 480px) {
    .info {
      display: none;
    }
    .share {
      padding: 8px 14px;
    }
  }
</style>
