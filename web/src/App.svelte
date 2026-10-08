<script lang="ts">
  import { onMount } from 'svelte';
  import PeopleList, { PEOPLE_ID } from './components/PeopleList.svelte';
  import ShareDock from './components/ShareDock.svelte';
  import Stage from './components/Stage.svelte';
  import TopBar from './components/TopBar.svelte';
  import { tileElement, toggleFullscreen } from './lib/fullscreen';
  import { currentLocale, t } from './lib/i18n/i18n.svelte';
  import { MembersFeed } from './lib/members.svelte';
  import { prefs } from './lib/prefs.svelte';
  import { browserClock, livekitRoom, noticeText, pageTitle, RoomSession, serverTokens } from './lib/room.svelte';
  import { resolveTheme } from './lib/theme';

  const rc = new RoomSession({ room: livekitRoom, tokens: serverTokens(), clock: browserClock, prefs });
  const members = new MembersFeed();
  /** Space the share dock needs at the stage bottom while it sits at home. */
  let dockClear = $state(0);
  /** The same space wherever the dock is: the empty stage keeps it so it never jumps. */
  let dockReserve = $state(0);

  const lightQuery = matchMedia('(prefers-color-scheme: light)');
  let prefersLight = $state(lightQuery.matches);
  // Same breakpoint as the CSS below, where the people list moves under the stage.
  const narrowQuery = matchMedia('(max-width: 720px)');
  let narrow = $state(narrowQuery.matches);
  // Open beside the stage, collapsed under it on phones, until the user picks.
  const peopleOpen = $derived(prefs.people ?? !narrow);
  function togglePeople() {
    // A collapsing list turns inert: focus inside it would drop to <body>, so
    // it moves to the edge handle, which stays put.
    if (peopleOpen && document.getElementById(PEOPLE_ID)?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('[data-testid="people-handle"]')?.focus();
    }
    prefs.setPeople(!peopleOpen);
  }

  $effect(() => {
    document.documentElement.dataset.theme = resolveTheme(prefs.theme, prefersLight);
  });
  $effect(() => {
    document.documentElement.lang = currentLocale();
  });
  $effect(() => {
    document.title = pageTitle(rc.label);
  });

  onMount(() => {
    const onScheme = () => (prefersLight = lightQuery.matches);
    const onNarrow = () => (narrow = narrowQuery.matches);
    lightQuery.addEventListener('change', onScheme);
    narrowQuery.addEventListener('change', onNarrow);
    void rc.start();
    const stopMembers = members.start();
    return () => {
      stopMembers();
      lightQuery.removeEventListener('change', onScheme);
      narrowQuery.removeEventListener('change', onNarrow);
    };
  });

  // Move focus into the fatal card: its button if there is one, else the card.
  function focusFirst(card: HTMLElement) {
    (card.querySelector<HTMLElement>('button') ?? card).focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (rc.fatal) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable], dialog')) return;
    // A modal owns the keyboard, even when a click left focus on the body.
    if (document.querySelector('dialog[open]')) return;
    switch (e.key) {
      case 'Escape':
        if (rc.focusId && !document.fullscreenElement) rc.setFocus(null);
        break;
      case 'f':
      case 'F': {
        const p = rc.target(false);
        if (p) toggleFullscreen(tileElement(p.identity));
        break;
      }
      case 'm':
      case 'M': {
        const p = rc.target(true);
        if (p) prefs.toggleMute(p.identity, p.mine);
        break;
      }
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Behind the fatal overlay nothing may be focused or operated. -->
<div class="app" inert={!!rc.fatal}>
  <TopBar {rc} {peopleOpen} ontogglepeople={togglePeople} />
  <main class="body" class:people-open={peopleOpen}>
    <!-- The dock floats over the stage only, never over the people list; toasts
         sit just above the dock's home spot there. -->
    <div class="stage-col" style:--dock-clear="{dockClear}px" style:--dock-reserve="{dockReserve}px">
      <Stage {rc} />
      <ShareDock {rc} bind:clearance={dockClear} bind:reserve={dockReserve} />
      <!-- The live region exists from the start; screen readers often skip a
           role=status element that is inserted together with its text. -->
      <div class="toast-region" role="status" aria-live="polite">
        {#if rc.toast}
          {#key rc.toast.id}
            <div class="toast" data-testid="toast">{noticeText(rc.toast)}</div>
          {/key}
        {/if}
      </div>
    </div>
    <PeopleList {rc} members={members.list} open={peopleOpen} ontoggle={togglePeople} />
    <!-- In the body, not the viewport, so it sits below the top bar whatever its height. -->
    {#if rc.connected && !rc.canPlaybackAudio}
      <button type="button" class="btn primary unlock" data-testid="audio-unlock" onclick={() => rc.startAudio()}>
        <span aria-hidden="true">🔊</span>
        {t('audio.unlock')}
      </button>
    {/if}
  </main>
</div>

{#if rc.fatal}
  <div class="fatal" data-testid="fatal" role="alert">
    <div class="card" tabindex="-1" {@attach focusFirst}>
      <p data-testid="notice">{noticeText(rc.fatal.notice)}</p>
      {#if rc.fatal.reload}
        <button type="button" class="btn primary" onclick={() => location.reload()}>{t('fatal.reload')}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100vh;
    /* biome-ignore lint/suspicious/noDuplicateProperties: 100vh is the fallback where dvh is unsupported */
    height: 100dvh;
  }
  /* --side-w is a registered <length> (base.css), so it animates: it drives
     the people column and, halved, how far the stage's centred things move
     right to sit on the window centre instead of the stage centre. */
  .body {
    --side-w: 0px;
    --stage-shift: calc(var(--side-w) / 2);
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--side-w);
    min-height: 0;
    transition: --side-w 0.2s ease;
  }
  .body.people-open {
    --side-w: var(--people-w);
  }
  .stage-col {
    position: relative;
    display: grid;
    min-width: 0;
    min-height: 0;
    /* For cqw: centred things clamp their shift to the stage width. */
    container-type: inline-size;
  }

  .unlock {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    z-index: 10;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  /* Zero-height strip on the stage bottom: out of the grid, the toast's anchor. */
  .toast-region {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
  }
  .toast {
    position: absolute;
    left: 50%;
    /* Just above the share dock in its home spot (bottom-centre of the stage). */
    bottom: max(16px, var(--dock-clear, 0px));
    transform: translateX(-50%);
    /* On the window centre like the dock, as far as the stage allows. */
    translate: clamp(0px, var(--stage-shift), (100cqw - 100%) / 2 - 16px) 0;
    z-index: 10;
    width: max-content;
    max-width: calc(100% - 32px);
    padding: 10px 14px;
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    overflow-wrap: anywhere;
    animation: toast-in 0.15s ease-out;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
  }

  .fatal {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--bg-0);
  }
  .fatal .card {
    max-width: 420px;
    padding: 24px;
    border-radius: var(--radius-lg);
    background: var(--bg-1);
    border: 1px solid var(--border);
    text-align: center;
    font-size: 16px;
  }
  .fatal .card:focus {
    outline: none;
  }
  .fatal p {
    margin: 0 0 16px;
  }
  .fatal p:last-child {
    margin: 0;
  }

  @media (max-width: 720px) {
    /* The list sits under the stage: the stage centre is the window centre. */
    .body {
      --stage-shift: 0px;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
    }
  }
</style>
