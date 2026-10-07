<script lang="ts">
  import { untrack } from 'svelte';
  import head from '../assets/telinha-head.webp';
  import { t } from '../lib/i18n/i18n.svelte';
  import type { RoomSession } from '../lib/room.svelte';
  import {
    type Fps,
    FRAME_RATES,
    PRESET_SETTINGS,
    PRESETS,
    presetOf,
    RESOLUTIONS,
    type Res,
    type ShareSettings,
  } from '../lib/share';

  let {
    rc,
    open = $bindable(false),
    fallback,
  }: {
    rc: RoomSession;
    open: boolean;
    /** Gets focus on close when the opener has gone (Quality vanishes when the share ends). */
    fallback?: HTMLElement;
  } = $props();

  const id = $props.id();
  let dlg = $state<HTMLDialogElement>();
  // Edited here, saved only on Go live / Apply; Back throws it away.
  let draft = $state<ShareSettings>(untrack(() => ({ ...rc.shareSettings })));
  let opener: HTMLElement | null = null;
  let openedLive = false;
  let downOnBackdrop = false;

  // While streaming it changes the live share instead of starting one.
  const live = $derived(!!rc.share);

  // A real modal <dialog>: the browser traps focus, makes the page inert and
  // turns Escape into a close.
  $effect(() => {
    const d = dlg;
    if (!d) return;
    if (open && !d.open) {
      untrack(() => {
        draft = { ...rc.shareSettings };
        opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        openedLive = !!rc.share;
      });
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  });

  // The share ended under it (the browser's Stop sharing bar, a rejoin): its
  // Apply would quietly turn into Go live and open the picker again.
  $effect(() => {
    if (open && openedLive && !rc.share) open = false;
  });

  function onClose() {
    open = false;
    openedLive = false;
    (opener?.isConnected ? opener : fallback)?.focus();
    opener = null;
  }

  // Only a click that starts and ends on the backdrop closes: dragging out of
  // the card (say, selecting text) must not.
  function onPointerdown(e: PointerEvent) {
    downOnBackdrop = e.target === dlg;
  }
  function onClick(e: MouseEvent) {
    if (downOnBackdrop && e.target === dlg) open = false;
    downOnBackdrop = false;
  }

  function pickPreset(value: string) {
    const p = PRESETS.find((x) => x === value) ?? 'custom';
    draft = p === 'custom' ? { ...draft, preset: p } : { ...draft, ...PRESET_SETTINGS[p], preset: p };
  }

  // A manual pick shows the preset it matches, else Custom.
  function pick(res: Res, fps: Fps) {
    draft = { ...draft, res, fps, preset: presetOf(res, fps) };
  }

  function submit() {
    open = false;
    // Still inside the click, so the browser's picker may open.
    void rc.useShareSettings({ ...draft });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (backdrop clicks; Escape is the dialog's own) -->
<!-- biome-ignore lint/a11y/useKeyWithClickEvents: backdrop clicks only; Escape is the dialog's own -->
<dialog
  class="modal"
  aria-labelledby="{id}-title"
  data-testid="share-modal"
  bind:this={dlg}
  onclose={onClose}
  onpointerdown={onPointerdown}
  onclick={onClick}
>
  <div class="card">
    <button
      type="button"
      class="btn ghost icon close"
      data-testid="share-close"
      aria-label={t('share.close')}
      title={t('share.close')}
      onclick={() => (open = false)}
    >
      <span aria-hidden="true">✕</span>
    </button>

    <img class="glyph" src={head} alt="" width="106" height="112" draggable="false" />
    <h2 id="{id}-title">{t('share.modalTitle')}</h2>

    <label class="heading" for="{id}-preset">{t('share.streamQuality')}</label>
    <select
      class="select"
      id="{id}-preset"
      name="preset"
      data-testid="share-preset"
      value={draft.preset}
      onchange={(e) => pickPreset(e.currentTarget.value)}
    >
      {#each PRESETS as p (p)}
        <option value={p}>{t(`share.preset.${p}`)}</option>
      {/each}
    </select>

    <div class="box">
      <fieldset>
        <legend class="heading">{t('share.resolution')}</legend>
        <div class="seg">
          {#each RESOLUTIONS as r (r)}
            <label class:on={draft.res === r}>
              <input
                type="radio"
                name="{id}-res"
                value={r}
                data-testid="res-{r}"
                checked={draft.res === r}
                onchange={() => pick(r, draft.fps)}
              />
              <span>{r}<span class="sr-only">p</span></span>
            </label>
          {/each}
        </div>
      </fieldset>
      <fieldset>
        <legend class="heading">{t('share.frameRate')}</legend>
        <div class="seg">
          {#each FRAME_RATES as f (f)}
            <label class:on={draft.fps === f}>
              <input
                type="radio"
                name="{id}-fps"
                value={f}
                data-testid="fps-{f}"
                checked={draft.fps === f}
                onchange={() => pick(draft.res, f)}
              />
              <span>{f}<span class="sr-only"> fps</span></span>
            </label>
          {/each}
        </div>
      </fieldset>
    </div>

    <label class="check">
      <input
        type="checkbox"
        name="audio"
        data-testid="share-audio"
        aria-describedby="{id}-audio-hint"
        checked={rc.canChangeAudio ? draft.audio : rc.shareSettings.audio}
        disabled={!rc.canChangeAudio}
        onchange={(e) => (draft.audio = e.currentTarget.checked)}
      />
      <span>{t('share.audio')}</span>
    </label>
    <p class="hint" id="{id}-audio-hint">{rc.canChangeAudio ? t('share.audioHint') : t('share.audioLocked')}</p>

    <div class="actions">
      <button type="button" class="btn ghost" data-testid="share-back" onclick={() => (open = false)}>
        {t('share.back')}
      </button>
      <button
        type="button"
        class="btn primary"
        data-testid="share-go-live"
        disabled={!rc.connected || rc.busy || (live && rc.applying)}
        onclick={submit}
      >
        {live ? t('share.apply') : t('share.goLive')}
      </button>
    </div>
  </div>
</dialog>

<style>
  .modal {
    width: 440px;
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 24px);
    overflow: auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--bg-2);
    color: var(--text);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
  }
  .modal::backdrop {
    background: rgba(0, 0, 0, 0.7);
  }
  .modal[open] {
    animation: modal-in 0.15s ease-out;
  }
  @keyframes modal-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }

  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    padding: 24px 20px 16px;
  }
  .close {
    position: absolute;
    top: 10px;
    right: 10px;
    font-size: 16px;
    line-height: 1;
  }
  .glyph {
    align-self: center;
    width: auto;
    height: 56px;
    user-select: none;
  }
  h2 {
    margin: 8px 0 20px;
    text-align: center;
    font-size: 20px;
    font-weight: 700;
  }

  .heading {
    display: block;
    margin: 0 0 8px;
    padding: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .select {
    width: 100%;
    min-height: 40px;
    color: var(--text);
  }

  .box {
    display: flex;
    flex-direction: column;
    gap: 16px;
    margin-top: 12px;
    padding: 14px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .seg {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .seg label {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-3);
    font-weight: 600;
    cursor: pointer;
    transition:
      background-color 0.12s,
      color 0.12s;
  }
  .seg label:hover {
    background-image: linear-gradient(var(--hover), var(--hover));
  }
  .seg label.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  /* The real radio covers its label: native arrow keys, clicks and checks. */
  .seg input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .seg label:has(input:focus-visible) {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 16px;
    font-weight: 500;
    cursor: pointer;
  }
  .check input {
    flex: none;
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .check:has(input:disabled) {
    opacity: 0.6;
    cursor: default;
  }
  .check input:disabled {
    cursor: default;
  }
  .hint {
    margin: 4px 0 0 28px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin: 20px -20px -16px;
    padding: 14px 20px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
  }
  .actions .btn {
    min-height: 38px;
    padding: 8px 16px;
  }

  @media (forced-colors: active) {
    .seg label.on {
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
