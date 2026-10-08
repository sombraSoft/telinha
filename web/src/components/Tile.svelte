<script lang="ts">
  import { toggleFullscreen } from '../lib/fullscreen';
  import { t } from '../lib/i18n/i18n.svelte';
  import { prefs } from '../lib/prefs.svelte';
  import type { Participant } from '../lib/room.svelte';
  import { parseQuality, QUALITY, QUALITY_CHOICES } from '../lib/share';
  import { qualityLabel, type VideoStats } from '../lib/stats';

  type Props = {
    participant: Participant;
    /** the participants that have this tile on screen */
    watchers: Participant[];
    focused: boolean;
    /** small tile under a focused one: compact controls */
    strip: boolean;
    stats: VideoStats | undefined;
    onfocus: () => void;
    onstop: () => void;
    /** remote only: open the stream / close it back to its Watch card */
    onwatch: () => void;
    onunwatch: () => void;
  };
  let { participant, watchers, focused, strip, stats, onfocus, onstop, onwatch, onunwatch }: Props = $props();

  // Deriveds keep the same track/publication object across snapshots, so the
  // effects below only re-run when the track itself changes.
  const video = $derived(participant.stream?.video);
  const audio = $derived(participant.stream?.audio ?? null);
  const pub = $derived(participant.stream?.pub ?? null);
  const volume = $derived(prefs.volume(participant.identity));
  const muted = $derived(prefs.muted(participant.identity, participant.mine));
  const badge = $derived(qualityLabel(stats));

  let tileEl = $state<HTMLElement>();
  let videoEl = $state<HTMLVideoElement>();
  let audioEl = $state<HTMLAudioElement>();
  let quality = $state(prefs.quality());
  let fullscreen = $state(false);
  let pip = $state(false);
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled === true;
  let windowFocused = $state(typeof document === 'undefined' || document.hasFocus());

  // A remote stream not watched is a card: nothing of it is downloaded.
  const card = $derived(!participant.local && !participant.watched);
  // This page's own preview costs drawing only: hidden on request, and while
  // the window is in the background (the streamer is in their game).
  const previewOff = $derived(participant.local && (!prefs.preview || !windowFocused));

  $effect(() => {
    const track = video;
    const el = videoEl;
    if (!track || !el || previewOff) return;
    track.attach(el);
    el.muted = true; // sound plays through its own <audio>
    return () => void track.detach(el);
  });

  $effect(() => {
    const el = videoEl;
    if (!el) return;
    const on = () => (pip = true);
    const off = () => (pip = false);
    el.addEventListener('enterpictureinpicture', on);
    el.addEventListener('leavepictureinpicture', off);
    return () => {
      el.removeEventListener('enterpictureinpicture', on);
      el.removeEventListener('leavepictureinpicture', off);
    };
  });

  $effect(() => {
    const track = audio;
    const el = audioEl;
    if (!track || !el) return;
    track.attach(el);
    return () => void track.detach(el);
  });

  $effect(() => {
    audio?.setVolume(muted ? 0 : volume / 100);
  });

  $effect(() => {
    pub?.setVideoQuality(QUALITY[quality]);
  });

  function pickQuality(e: Event) {
    quality = parseQuality((e.currentTarget as HTMLSelectElement).value);
    prefs.setQuality(quality);
  }

  async function togglePip() {
    if (!videoEl) return;
    try {
      if (document.pictureInPictureElement === videoEl) await document.exitPictureInPicture();
      else await videoEl.requestPictureInPicture();
    } catch {}
  }

  const statLines = $derived.by(() => {
    if (!prefs.stats || !stats) return '';
    const path =
      stats.relay === null
        ? t('stats.pathUnknown')
        : t(stats.relay ? 'stats.viaTurn' : 'stats.toLivekit', { ms: stats.rttMs ?? '?' });
    return [
      `${stats.out ? t('stats.sending') : t('stats.receiving')} ${stats.width}×${stats.height} @ ${stats.fps} fps`,
      `${stats.mbps.toFixed(1)} Mbps · ${stats.codec}${stats.impl ? ` · ${stats.impl}` : ''}`,
      stats.out ? t('stats.limit', { reason: stats.limitation }) : t('stats.lost', { count: stats.lost }),
      path,
    ].join('\n');
  });
</script>

<svelte:document onfullscreenchange={() => (fullscreen = !!tileEl && document.fullscreenElement === tileEl)} />
<svelte:window onfocus={() => (windowFocused = true)} onblur={() => (windowFocused = false)} />

<div
  bind:this={tileEl}
  class="tile"
  class:focused
  class:strip
  class:local={participant.local}
  class:card
  data-testid="tile"
  data-identity={participant.identity}
  data-local={participant.local ? 'true' : 'false'}
>
  <video
    bind:this={videoEl}
    data-testid="tile-video"
    autoplay
    playsinline
    muted
    disablepictureinpicture={!pipSupported}
  ></video>
  {#if audio}
    <!-- biome-ignore lint/a11y/useMediaCaption: live call audio has no caption track -->
    <audio bind:this={audioEl} autoplay></audio>
  {/if}

  {#if card}
    <!-- The whole card is the Watch button, as in Discord. -->
    <button
      type="button"
      class="hit"
      data-testid="watch"
      aria-label={t('tile.watch', { name: participant.label })}
      onclick={onwatch}
    ></button>
    <div class="center" aria-hidden="true">
      <img class="big-avatar" src={participant.avatar} alt="" />
      {#if !strip}
        <span class="watch-pill">{t('tile.watchButton')}</span>
      {/if}
    </div>
  {:else}
    <button
      type="button"
      class="hit"
      aria-pressed={focused}
      aria-label={focused ? t('tile.unfocus') : t('tile.focus', { name: participant.label })}
      onclick={(e) => {
        // A mouse click should not leave the overlays pinned by :focus-within.
        if (e.detail > 0) e.currentTarget.blur();
        onfocus();
      }}
      ondblclick={() => toggleFullscreen(tileEl)}
    ></button>
  {/if}

  {#if previewOff}
    <div class="center muted-note" data-testid="preview-off">
      <span>{prefs.preview ? t('tile.previewPaused') : t('tile.previewHidden')}</span>
    </div>
  {/if}

  <span class="live">{t('tile.live')}</span>

  {#if statLines}
    <pre class="stats">{statLines}</pre>
  {/if}

  {#if watchers.length}
    <div
      class="viewers overlay"
      data-testid="tile-viewers"
      title={t('tile.watching', { names: watchers.map((v) => v.name).join(', ') })}
    >
      {#each watchers.slice(0, 5) as v (v.identity)}
        <img class="avatar" src={v.avatar} alt="" />
      {/each}
      <span aria-hidden="true">👁</span>
      <span>{watchers.length}</span>
      <span class="sr-only">{t('tile.viewers', { count: watchers.length })}</span>
    </div>
  {/if}

  <!-- One bottom row: the controls wrap above the label instead of covering it. -->
  <div class="bottom">
    <div class="label overlay">
      <img class="avatar" src={participant.avatar} alt="" />
      <span class="name">{participant.label}{participant.local ? ` ${t('you')}` : ''}</span>
      <span class="quality" data-testid="tile-quality">{badge}</span>
    </div>

    {#if !card}
      <div class="controls overlay">
        {#if participant.local}
          <button
            type="button"
            class="btn icon"
            data-testid="preview-toggle"
            aria-label={t('tile.preview')}
            title={t('tile.preview')}
            aria-pressed={prefs.preview}
            onclick={() => prefs.setPreview(!prefs.preview)}
          >
            {prefs.preview ? '👁' : '🙈'}
          </button>
          <button type="button" class="btn danger" aria-label={t('tile.stop')} title={t('tile.stop')} onclick={onstop}>
            <span aria-hidden="true">⏹</span>
            {#if !strip}
              <span aria-hidden="true">{t('tile.stop')}</span>
            {/if}
          </button>
        {:else}
          <button
            type="button"
            class="btn"
            data-testid="unwatch"
            aria-label={t('tile.unwatch')}
            title={t('tile.unwatch')}
            onclick={onunwatch}
          >
            <span aria-hidden="true">✕</span>
            {#if !strip}
              <span aria-hidden="true">{t('tile.unwatch')}</span>
            {/if}
          </button>
          {#if audio}
            <div class="volume">
              <button
                type="button"
                class="btn icon"
                data-testid="mute"
                aria-label={muted ? t('tile.unmute') : t('tile.mute')}
                title={muted ? t('tile.unmute') : t('tile.mute')}
                aria-pressed={muted}
                onclick={() => prefs.toggleMute(participant.identity, participant.mine)}
              >
                {muted ? '🔇' : '🔊'}
              </button>
              {#if !strip}
                <input
                  type="range"
                  name="volume"
                  min="0"
                  max="100"
                  value={volume}
                  aria-label={t('tile.volume', { name: participant.label })}
                  oninput={(e) => prefs.setVolume(participant.identity, Number(e.currentTarget.value))}
                />
              {/if}
            </div>
          {/if}
          {#if !strip}
            <select
              class="select"
              name="quality"
              data-testid="quality-select"
              value={quality}
              aria-label={t('tile.quality')}
              title={t('tile.quality')}
              onchange={pickQuality}
            >
              {#each QUALITY_CHOICES as q (q)}
                <option value={q}>{t(`quality.${q}`)}</option>
              {/each}
            </select>
          {/if}
          {#if pipSupported}
            <button
              type="button"
              class="btn icon"
              aria-label={t('tile.pip')}
              title={t('tile.pip')}
              aria-pressed={pip}
              onclick={togglePip}
            >
              ⧉
            </button>
          {/if}
        {/if}
        <button
          type="button"
          class="btn icon"
          aria-label={fullscreen ? t('tile.exitFullscreen') : t('tile.fullscreen')}
          title={fullscreen ? t('tile.exitFullscreen') : t('tile.fullscreen')}
          onclick={() => toggleFullscreen(tileEl)}
        >
          ⛶
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .tile {
    position: relative;
    min-width: 0;
    min-height: 0;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--bg-2);
    border: 1px solid var(--border);
    isolation: isolate;
  }
  .tile:fullscreen {
    border-radius: 0;
    border: 0;
    background: #000;
  }
  .tile.focused {
    box-shadow: 0 0 0 2px var(--accent);
  }
  .tile:hover:not(.focused) {
    box-shadow: 0 0 0 2px var(--hover);
  }

  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    display: block;
  }
  .local video {
    opacity: 0.9;
  }
  audio {
    display: none;
  }

  /* Centred over the tile, under its overlays; clicks go through to .hit. */
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 12px;
    pointer-events: none;
    text-align: center;
  }
  .big-avatar {
    width: clamp(40px, 22%, 88px);
    aspect-ratio: 1;
    border-radius: 50%;
    border: 2px solid var(--border);
  }
  .watch-pill {
    padding: 8px 18px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  .card:hover .watch-pill,
  .card:has(.hit:focus-visible) .watch-pill {
    background: var(--accent-hover);
  }
  .muted-note {
    color: var(--text-muted);
    font-size: 13px;
  }

  .hit {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: inherit;
  }
  .hit:focus-visible {
    outline-offset: -3px;
  }
  .focused .hit {
    cursor: zoom-out;
  }

  .live {
    position: absolute;
    left: 10px;
    top: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    background: var(--danger);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.02em;
    pointer-events: none;
  }

  /* Discord-style: overlays fade in on hover or keyboard focus. Not
     :focus-within, which would pin them after a mouse click on a control;
     an open quality dropdown keeps them up while the pointer is in the popup. */
  .overlay {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    transition: opacity 0.15s ease;
  }
  /* The bottom row's overlays sit in its flex row instead. */
  .bottom .overlay {
    position: static;
  }
  .tile:hover .overlay,
  .tile:has(:focus-visible) .overlay,
  .tile:has(select:focus) .overlay {
    opacity: 1;
  }
  @media (hover: none) {
    .overlay {
      opacity: 1;
    }
  }

  .bottom {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    display: flex;
    flex-wrap: wrap-reverse;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }

  .label {
    min-width: 0;
    max-width: 100%;
    padding: 3px 10px 3px 3px;
    border-radius: 999px;
    background: var(--scrim);
    color: var(--on-scrim);
    font-weight: 600;
    pointer-events: none;
  }
  .label .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quality {
    font-weight: 500;
    font-size: 12px;
    opacity: 0.75;
  }
  .quality:empty {
    display: none;
  }

  .viewers {
    right: 10px;
    top: 10px;
    padding: 2px 8px 2px 2px;
    gap: 0;
    border-radius: 999px;
    background: var(--scrim);
    color: var(--on-scrim);
    font-size: 12px;
    font-weight: 600;
    cursor: default;
  }
  .viewers img {
    width: 20px;
    height: 20px;
    margin-left: -6px;
    border: 2px solid #000;
  }
  .viewers img:first-child {
    margin-left: 0;
  }
  .viewers span {
    margin-left: 4px;
  }

  .controls {
    margin-left: auto;
    pointer-events: auto;
    padding: 4px;
    border-radius: var(--radius-sm);
    background: var(--scrim);
    color: var(--on-scrim);
  }
  .controls .btn:not(.danger),
  .controls .select {
    background-color: transparent;
    color: var(--on-scrim);
    border-color: transparent;
  }
  .controls .btn:not(.danger):hover,
  .controls .select:hover {
    background-color: rgba(255, 255, 255, 0.14);
  }
  .controls .select option {
    color: var(--text);
  }
  .volume {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .volume input {
    width: 90px;
    accent-color: var(--accent);
  }

  .stats {
    position: absolute;
    left: 10px;
    top: 36px;
    margin: 0;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--scrim);
    color: var(--on-scrim);
    font:
      11px / 1.45 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    white-space: pre;
    pointer-events: none;
  }

  .strip .bottom {
    left: 6px;
    right: 6px;
    bottom: 6px;
    gap: 4px;
  }
  .strip .label {
    font-size: 12px;
  }
  .strip .controls {
    padding: 2px;
  }
  /* Too small for the stats box (it would cover the controls); the label's
     live quality badge stays. */
  .strip .stats {
    display: none;
  }
  .strip .viewers {
    right: 6px;
    top: 6px;
  }

  @media (max-width: 720px) {
    .volume input {
      width: 64px;
    }
  }
</style>
