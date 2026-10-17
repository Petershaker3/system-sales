// Application entry point.
//
// Order matters: the fonts and design tokens load first, the look is applied
// before the first frame (the approved defaults at once, then the shop's stored
// choices), and only then is the app mounted.
//
// The browser demo (`npm run demo`, mode `demo`) installs its in-memory stand-in
// for Rust before anything calls it. The condition is replaced at build time, so
// production and every Tauri build leave the demo out of the bundle entirely.

import { createApp } from 'vue';

import './styles/fonts.css';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/controls.css';
import './styles/pos.css';
import './styles/modal.css';
import './styles/pages.css';
import './styles/settings.css';
import './styles/lock.css';
import './styles/toast.css';
import './styles/legacy.css';
import './styles/motion.css';

import App from './App.vue';
import { startAppearance } from './ui/appearance';

async function boot(): Promise<void> {
  if (import.meta.env.VITE_DEMO === '1') {
    const demo = await import('./dev/demo-backend');
    demo.install();
  }
  await startAppearance();
  createApp(App).mount('#app');
}

void boot();
