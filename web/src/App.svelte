<script lang="ts">
  import { onMount } from 'svelte';
  import PeopleList from './components/PeopleList.svelte';
  import ShareBar from './components/ShareBar.svelte';
  import Stage from './components/Stage.svelte';
  import TopBar from './components/TopBar.svelte';
  import { tileElement, toggleFullscreen } from './lib/fullscreen';
  import { currentLocale, t } from './lib/i18n/i18n.svelte';
  import { prefs } from './lib/prefs.svelte';
  import { RoomController, noticeText } from './lib/room.svelte';
  import { resolveTheme } from './lib/theme';

  const rc = new RoomController();

  const lightQuery = matchMedia('(prefers-color-scheme: light)');
  let prefersLight = $state(lightQuery.matches);

  $effect(() => {
    document.documentElement.dataset.theme = resolveTheme(prefs.theme, prefersLight);
  });
  $effect(() => {
    document.documentElement.lang = currentLocale();
  });

  onMount(() => {
    const onScheme = () => (prefersLight = lightQuery.matches);
    lightQuery.addEventListener('change', onScheme);
    void rc.start();
    return () => lightQuery.removeEventListener('change', onScheme);
  });

  // Move focus into the fatal card: its button if there is one, else the card.
  function focusFirst(card: HTMLElement) {
    (card.querySelector<HTMLElement>('button') ?? card).focus();
  }

  function onKeydown(e: KeyboardEvent) {
    if (rc.fatal) return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable]')) return;
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
        if (p) prefs.toggleMute(p.identity);
        break;
      }
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Behind the fatal overlay nothing may be focused or operated. -->
<div class="app" inert={!!rc.fatal}>
  <TopBar {rc} />
  <main class="body">
    <Stage {rc} />
    <PeopleList {rc} />
    <!-- In the body, not the viewport, so it sits below the top bar whatever its height. -->
    {#if rc.connected && !rc.canPlaybackAudio}
      <button class="btn primary unlock" data-testid="audio-unlock" onclick={() => rc.startAudio()}>
        <span aria-hidden="true">🔊</span>
        {t('audio.unlock')}
      </button>
    {/if}
  </main>
  <ShareBar {rc} />
</div>

<!-- The live region exists from the start; screen readers often skip a
     role=status element that is inserted together with its text. -->
<div class="toast-region" role="status" aria-live="polite">
  {#if rc.toast}
    {#key rc.toast.id}
      <div class="toast" data-testid="toast">{noticeText(rc.toast)}</div>
    {/key}
  {/if}
</div>

{#if rc.fatal}
  <div class="fatal" data-testid="fatal" role="alert">
    <div class="card" tabindex="-1" {@attach focusFirst}>
      <p data-testid="notice">{noticeText(rc.fatal.notice)}</p>
      {#if rc.fatal.reload}
        <button class="btn primary" onclick={() => location.reload()}>{t('fatal.reload')}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100vh;
    height: 100dvh;
  }
  .body {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    min-height: 0;
  }

  .unlock {
    position: absolute;
    left: 50%;
    top: 12px;
    transform: translateX(-50%);
    z-index: 10;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 84px;
    transform: translateX(-50%);
    z-index: 10;
    max-width: calc(100vw - 32px);
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
    .body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) auto;
    }
  }
</style>
