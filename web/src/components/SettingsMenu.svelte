<script lang="ts">
  import { t } from '../lib/i18n/i18n.svelte';
  import { type LangChoice, prefs } from '../lib/prefs.svelte';
  import { codecCaps } from '../lib/stats';
  import { THEME_CHOICES } from '../lib/theme';

  // Language names stay in their own language so anyone can find theirs.
  const LANGS: { value: LangChoice; label?: string }[] = [
    { value: 'auto' },
    { value: 'pt-BR', label: 'Português' },
    { value: 'en', label: 'English' },
  ];

  const id = $props.id();
  let open = $state(false);
  let root = $state<HTMLElement>();
  let cog = $state<HTMLButtonElement>();

  const caps = codecCaps();
  const capsLine = $derived(
    caps
      .map((c) => t('stats.caps', { codec: c.codec, send: c.send ? '✓' : '✗', recv: c.recv ? '✓' : '✗' }))
      .join(' · '),
  );

  function close(refocus: boolean) {
    open = false;
    if (refocus) cog?.focus();
  }

  // Non-modal: Escape and clicks outside close it. Escape is caught on the
  // capture phase and marked handled so App's Escape (unfocus tile) skips it.
  $effect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (!root?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  });

  // Tabbing out of the menu closes it too; a null relatedTarget is a click on
  // something unfocusable, which the pointer handler already decides.
  function onFocusout(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && !root?.contains(e.relatedTarget)) close(false);
  }

  // Start keyboard users on the current theme.
  function focusCurrent(menu: HTMLElement) {
    menu.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  }
</script>

<div class="settings" bind:this={root} onfocusout={onFocusout}>
  <button
    type="button"
    class="btn ghost icon"
    data-testid="settings-button"
    aria-label={t('settings.title')}
    title={t('settings.title')}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={open ? `${id}-menu` : undefined}
    bind:this={cog}
    onclick={() => (open = !open)}
  >
    <span class="cog" aria-hidden="true">⚙</span>
  </button>

  {#if open}
    <div
      class="menu"
      id="{id}-menu"
      role="dialog"
      aria-label={t('settings.title')}
      data-testid="settings-menu"
      {@attach focusCurrent}
    >
      <section>
        <h3 id="{id}-theme">{t('top.theme')}</h3>
        <!-- biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend layout -->
        <div class="swatches" role="group" aria-labelledby="{id}-theme">
          {#each THEME_CHOICES as c (c)}
            <button
              type="button"
              class="swatch"
              data-testid="theme-{c}"
              aria-pressed={prefs.theme === c}
              onclick={() => prefs.setTheme(c)}
            >
              <!-- System previews both sides it can resolve to. -->
              <span class="preview" aria-hidden="true">
                {#each c === 'system' ? (['dark', 'light'] as const) : [c] as th (th)}
                  <span class="half" data-theme-preview={th}><span class="line"></span><span class="dot"></span></span>
                {/each}
              </span>
              <span class="name">{t(`theme.${c}`)}</span>
            </button>
          {/each}
        </div>
      </section>

      <section>
        <h3 id="{id}-lang">{t('top.language')}</h3>
        <select
          class="select"
          name="lang"
          data-testid="lang-select"
          aria-labelledby="{id}-lang"
          value={prefs.lang}
          onchange={(e) => prefs.setLang(LANGS.find((l) => l.value === e.currentTarget.value)?.value ?? 'auto')}
        >
          {#each LANGS as l (l.value)}
            <option value={l.value}>{l.label ?? t('lang.auto')}</option>
          {/each}
        </select>
      </section>

      <section>
        <label class="switch">
          <span class="text">
            <span class="label" id="{id}-debug">{t('settings.debug')}</span>
            <span class="hint" id="{id}-debug-hint">{t('settings.debugHint')}</span>
          </span>
          <!-- Named by the title alone; the hint is a description, not the name. -->
          <!-- biome-ignore-start lint/a11y/useAriaPropsForRole: a native checkbox exposes its checked state itself -->
          <input
            type="checkbox"
            role="switch"
            name="debug"
            aria-labelledby="{id}-debug"
            aria-describedby="{id}-debug-hint"
            data-testid="debug-toggle"
            checked={prefs.stats}
            onchange={(e) => prefs.setStats(e.currentTarget.checked)}
          />
          <!-- biome-ignore-end lint/a11y/useAriaPropsForRole: end of the switch -->
        </label>
        {#if prefs.stats}
          <p class="caps" data-testid="codec-caps">{capsLine}</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .cog {
    font-size: 17px;
    line-height: 1;
  }
  .btn[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
  }
  /* Anchors to the nearest positioned ancestor, TopBar's right group, so it
     lines up with the header edge instead of running off a phone. */
  .menu {
    position: absolute;
    top: calc(100% + 12px);
    right: 0;
    z-index: 15;
    width: 300px;
    max-width: calc(100vw - 24px);
    max-height: calc(100dvh - 72px);
    overflow: auto;
    padding: 12px;
    border-radius: var(--radius-md);
    background: var(--bg-2);
    border: 1px solid var(--border);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    white-space: normal;
  }
  section + section {
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  h3 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 6px;
  }
  .swatch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 4px 2px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .swatch:hover,
  .swatch[aria-pressed='true'] {
    color: var(--text);
  }
  .swatch:hover .preview {
    border-color: var(--text-muted);
  }
  /* --focus-ring, not --accent: the accent misses 3:1 against Ash's menu. */
  .swatch[aria-pressed='true'] .preview {
    border-color: var(--focus-ring);
    box-shadow: 0 0 0 1px var(--focus-ring);
  }
  .swatch[aria-pressed='true'] .name {
    font-weight: 700;
  }
  .swatch .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preview {
    display: flex;
    width: 100%;
    max-width: 44px;
    aspect-ratio: 1;
    overflow: hidden;
    border-radius: 50%;
    border: 2px solid var(--border);
  }
  /* A mini window: panel colour, one stage-coloured bar, an accent dot.
     --bg-2 rather than --bg-0 so Dark and Onyx don't read as the same black. */
  .half {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 4px;
    background: var(--bg-2);
  }
  .line {
    width: 60%;
    height: 5px;
    border-radius: 999px;
    background: var(--bg-0);
    border: 1px solid var(--border);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }

  .select {
    width: 100%;
    color: var(--text);
  }

  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    cursor: pointer;
  }
  .switch .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .switch .label {
    font-weight: 500;
  }
  .switch .hint,
  .caps {
    font-size: 12px;
    color: var(--text-muted);
  }
  input[type='checkbox'] {
    appearance: none;
    flex: none;
    position: relative;
    width: 36px;
    height: 20px;
    margin: 0;
    border-radius: 999px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    cursor: pointer;
    transition: background-color 0.12s;
  }
  input[type='checkbox']::before {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-muted);
    transition:
      transform 0.12s,
      background-color 0.12s;
  }
  input[type='checkbox']:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  input[type='checkbox']:checked::before {
    background: #fff;
    transform: translateX(16px);
  }
  .caps {
    margin: 8px 0 0;
    overflow-wrap: anywhere;
  }

  /* High contrast drops shadows and flattens borders and backgrounds, which
     would hide the selected swatch and the switch state. */
  @media (forced-colors: active) {
    .swatch[aria-pressed='true'] .preview {
      border-color: Highlight;
      border-width: 3px;
    }
    input[type='checkbox']::before {
      background: CanvasText;
    }
    input[type='checkbox']:checked {
      background: Highlight;
    }
    input[type='checkbox']:checked::before {
      background: HighlightText;
    }
  }
</style>
