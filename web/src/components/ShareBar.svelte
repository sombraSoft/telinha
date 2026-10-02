<script lang="ts">
  import { t } from '../lib/i18n/i18n.svelte';
  import { prefs } from '../lib/prefs.svelte';
  import type { RoomController } from '../lib/room.svelte';
  import { FRAME_RATES, RESOLUTIONS, parseShareSettings } from '../lib/share';
  import { codecCaps } from '../lib/stats';

  let { rc }: { rc: RoomController } = $props();

  const caps = codecCaps();
  const capsLine = $derived(
    caps
      .map((c) => t('stats.caps', { codec: c.codec, send: c.send ? '✓' : '✗', recv: c.recv ? '✓' : '✗' }))
      .join(' · '),
  );
  const codecInfo = $derived(
    rc.share ? `${rc.share.codec.toUpperCase()} · ${rc.share.audio ? t('share.withSound') : t('share.noSound')}` : '',
  );

  function change(part: 'res' | 'fps', value: string) {
    void rc.setShareSettings(parseShareSettings({ ...prefs.share, [part]: Number(value) }));
  }
</script>

<footer class="bar">
  <div class="settings">
    <label>
      <span>{t('share.resolution')}</span>
      <select class="select" name="res" data-testid="res-select" value={String(prefs.share.res)} onchange={(e) => change('res', e.currentTarget.value)}>
        {#each RESOLUTIONS as r (r)}
          <option value={String(r)}>{r === 1440 ? t('share.source') : `${r}p`}</option>
        {/each}
      </select>
    </label>
    <label>
      <span>{t('share.fps')}</span>
      <select class="select" name="fps" data-testid="fps-select" value={String(prefs.share.fps)} onchange={(e) => change('fps', e.currentTarget.value)}>
        {#each FRAME_RATES as f (f)}
          <option value={String(f)}>{f}</option>
        {/each}
      </select>
    </label>
    {#if codecInfo}<span class="info">{codecInfo}</span>{/if}
    {#if prefs.stats}<span class="info">{capsLine}</span>{/if}
  </div>

  <button
    class="btn share"
    class:primary={!rc.share}
    class:danger={!!rc.share}
    data-testid="share-button"
    disabled={!rc.connected || rc.busy}
    onclick={() => void rc.toggleShare()}
  >
    <span aria-hidden="true">{rc.share ? '⏹' : '🖥️'}</span>
    {rc.share ? t('share.stop') : t('share.start')}
  </button>
</footer>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 10px 16px;
    background: var(--bg-1);
    border-top: 1px solid var(--border);
  }
  .settings {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    min-width: 0;
    color: var(--text-muted);
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  label .select {
    color: var(--text);
  }
  .info {
    font-size: 12px;
  }
  .share {
    min-height: 40px;
    padding: 8px 20px;
    border-radius: var(--radius-sm);
    font-size: 15px;
  }

  @media (max-width: 720px) {
    .bar {
      padding: 8px 12px;
    }
    .share {
      flex: 1 0 100%;
    }
  }
</style>
