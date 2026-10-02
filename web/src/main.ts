import { mount } from 'svelte';
import App from './App.svelte';
import './styles/themes.css';
import './styles/base.css';

const target = document.getElementById('app');
if (!target) throw new Error('missing #app');
mount(App, { target });

// Hot-swapping JS would remount App and open a second LiveKit connection next
// to the old one (ghost participants); a WebRTC session can't survive a swap
// anyway, so reload instead. CSS still updates in place.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', (payload) => {
    if (payload.updates.some((u) => u.type === 'js-update')) location.reload();
  });
}
