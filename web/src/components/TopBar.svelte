<script lang="ts">
  import { avatarUrl } from '../lib/avatar';
  import { t } from '../lib/i18n/i18n.svelte';
  import type { RoomController } from '../lib/room.svelte';
  import head from '../assets/telinha-head.webp';
  import { PEOPLE_ID } from './PeopleList.svelte';
  import SettingsMenu from './SettingsMenu.svelte';

  let { rc, peopleOpen, ontogglepeople }: { rc: RoomController; peopleOpen: boolean; ontogglepeople: () => void } =
    $props();
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
    <img class="logo" src={head} alt="" width="106" height="112" draggable="false" />
    <span class="title">Telinha</span>
  </div>

  <div class="right">
    <!-- 👥 drawn in currentColor (the emoji ignores it): readable on every theme, follows hover. -->
    <button
      class="btn ghost icon people"
      data-testid="people-toggle"
      aria-label={t('people.toggle')}
      title={t('people.toggle')}
      aria-expanded={peopleOpen}
      aria-controls={PEOPLE_ID}
      onclick={ontogglepeople}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
          <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
          <path d="M18 14.3c2.1.7 3.5 2.8 3.5 5.7" />
        </g>
      </svg>
    </button>
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
    display: block;
    width: auto;
    height: 28px;
    user-select: none;
  }
  .room {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
  }
  .people svg {
    display: block;
  }
  .people[aria-expanded='true'] {
    background: var(--hover);
    color: var(--text);
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
    /* The avatar never squeezes: the right group is tight on small phones. */
    .me {
      flex: none;
      margin-left: 0;
      padding: 3px;
    }
  }
  /* Room for the right group's three buttons on the smallest phones. */
  @media (max-width: 360px) {
    .top {
      gap: 4px;
      padding: 8px;
    }
    .left,
    .right {
      gap: 2px;
    }
  }
</style>
