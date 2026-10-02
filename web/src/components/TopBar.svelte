<script lang="ts">
  import { avatarUrl } from '../lib/avatar';
  import { t } from '../lib/i18n/i18n.svelte';
  import { prefs, type LangChoice } from '../lib/prefs.svelte';
  import type { RoomController } from '../lib/room.svelte';
  import { THEME_CHOICES, parseThemeChoice } from '../lib/theme';

  let { rc }: { rc: RoomController } = $props();

  // Language names stay in their own language so anyone can find theirs.
  const LANGS: { value: LangChoice; label?: string }[] = [
    { value: 'auto' },
    { value: 'pt-BR', label: 'Português' },
    { value: 'en', label: 'English' },
  ];
</script>

<header class="top">
  <div class="brand">
    <span class="logo" aria-hidden="true">📺</span>
    <span class="title">Telinha</span>
    {#if rc.group}<span class="chip">{rc.group}</span>{/if}
    {#if rc.roomName}<span class="muted room">{t('top.room', { name: rc.roomName })}</span>{/if}
  </div>

  <div class="actions">
    <button
      class="btn ghost"
      data-testid="copy-link"
      aria-label={t('top.copyLink')}
      title={t('top.copyLinkTitle')}
      onclick={() => void rc.copyLink()}>
      <span aria-hidden="true">🔗</span><span class="label">{t('top.copyLink')}</span>
    </button>
    <button
      class="btn ghost icon"
      data-testid="stats-toggle"
      aria-pressed={prefs.stats}
      aria-label={t('top.stats')}
      title={t('top.stats')}
      onclick={() => prefs.setStats(!prefs.stats)}>📊</button
    >
    <select
      class="select"
      name="theme"
      data-testid="theme-select"
      aria-label={t('top.theme')}
      title={t('top.theme')}
      value={prefs.theme}
      onchange={(e) => prefs.setTheme(parseThemeChoice(e.currentTarget.value))}
    >
      {#each THEME_CHOICES as c (c)}
        <option value={c}>{t(`theme.${c}`)}</option>
      {/each}
    </select>
    <select
      class="select"
      name="lang"
      data-testid="lang-select"
      aria-label={t('top.language')}
      title={t('top.language')}
      value={prefs.lang}
      onchange={(e) => prefs.setLang(LANGS.find((l) => l.value === e.currentTarget.value)?.value ?? 'auto')}
    >
      {#each LANGS as l (l.value)}
        <option value={l.value}>{l.label ?? t('lang.auto')}</option>
      {/each}
    </select>
    {#if rc.user}
      <div class="me" data-testid="me">
        <img class="avatar" src={avatarUrl(rc.user.id, rc.user.avatar)} alt="" />
        <span class="name">{rc.user.name}</span>
      </div>
    {/if}
  </div>
</header>

<style>
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 16px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    min-width: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
  }
  .title {
    font-weight: 700;
    font-size: 16px;
  }
  .logo {
    font-size: 18px;
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--bg-3);
    border: 1px solid var(--border);
    font-size: 12px;
    font-weight: 600;
  }
  .room {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-left: 4px;
    padding: 3px 10px 3px 3px;
    border-radius: 999px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    font-weight: 600;
    max-width: 180px;
  }
  .me .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 720px) {
    .top {
      flex-wrap: wrap;
      padding: 8px 12px;
    }
    .room,
    .label {
      display: none;
    }
  }
</style>
