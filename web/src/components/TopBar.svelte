<script lang="ts">
  import { avatarUrl } from '../lib/avatar';
  import { t } from '../lib/i18n/i18n.svelte';
  import type { RoomController } from '../lib/room.svelte';
  import SettingsMenu from './SettingsMenu.svelte';

  let { rc }: { rc: RoomController } = $props();
</script>

<!-- Three columns: the side ones share the leftover width equally, so the
     title sits in the middle of the viewport whatever is beside it. -->
<header class="top">
  <div class="left">
    {#if rc.roomName}<span class="muted room">{t('top.room', { name: rc.roomName })}</span>{/if}
    <button
      class="btn ghost"
      data-testid="copy-link"
      aria-label={t('top.copyLink')}
      title={t('top.copyLinkTitle')}
      onclick={() => void rc.copyLink()}>
      <span aria-hidden="true">🔗</span><span class="label">{t('top.copyLink')}</span>
    </button>
  </div>

  <div class="brand">
    <span class="logo" aria-hidden="true">📺</span>
    <span class="title">Telinha</span>
  </div>

  <div class="right">
    <SettingsMenu />
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
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    background: var(--bg-1);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .right {
    /* SettingsMenu's popover anchors here. */
    position: relative;
    justify-content: flex-end;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title {
    font-weight: 700;
    font-size: 16px;
  }
  .logo {
    font-size: 18px;
  }
  .room {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 180px;
    margin-left: 4px;
    padding: 3px 10px 3px 3px;
    border-radius: 999px;
    background: var(--bg-2);
    border: 1px solid var(--border);
    font-weight: 600;
  }
  .me .name {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 720px) {
    .top {
      gap: 8px;
      padding: 8px 12px;
    }
    .room,
    .label {
      display: none;
    }
    /* Hidden visually but still read, so the chip isn't an unnamed avatar. */
    .me .name {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    .me {
      margin-left: 0;
      padding: 3px;
    }
  }
</style>
