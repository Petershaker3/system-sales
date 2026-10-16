// Application entry point.
//
// Deliberately minimal: this step exists only to prove that
// Vue → Vite → dist/ → Tauri resolves end to end. No routing, no state
// management, and no UI structure belong here yet.

import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');