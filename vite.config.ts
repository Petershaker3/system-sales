/// <reference types="vite/client" />
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Tauri drives the dev server and loads the built assets from disk.
//
// Target selection (ADR-008 / Gate C decision D-1):
//
// Tauri's published example is a two-branch conditional:
//
//     platform == 'windows' ? 'chrome105' : 'safari13'
//
// That expression never names Android, so Android silently falls through to
// `safari13` — a WebKit target. Android uses the system Android WebView, which
// is Chromium-based, so `safari13` is the wrong target for it: it under-targets
// and can permit syntax the device WebView rejects.
//
// Android therefore gets an explicit branch at `chrome105`, matching the
// Windows floor. Raising it later requires evidence from the real device
// WebView, not from the docs.
const BROWSER_TARGETS: Record<string, string> = {
  windows: 'chrome105',
  android: 'chrome105',
  ios: 'safari13',
  macos: 'safari13',
  linux: 'safari13',
};

// Unknown or absent platform must not silently inherit a WebKit target, which
// is the exact defect D-1 exists to prevent. Default to the Chromium floor.
const DEFAULT_TARGET = 'chrome105';

// Bracket access is required by `noPropertyAccessFromIndexSignature`, and these
// values are `string | undefined` — Tauri sets them, nothing guarantees it.
const devHost = process.env['TAURI_DEV_HOST'];
const platform = process.env['TAURI_ENV_PLATFORM'];
const isDebug = process.env['TAURI_ENV_DEBUG'] !== undefined;

// `--mode demo` builds the browser demo (src/dev/demo-backend.ts): the screens
// on an in-memory stand-in for Rust, served to any host so it can be previewed.
// It is never used by Tauri, and its output goes to `dist-demo/`, apart from the
// `dist/` that Tauri embeds and the architecture tests inspect.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
  plugins: [vue()],

  ...(demo ? { define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') } } : {}),

  server: {
    // Tauri expects a fixed port and fails fast if it is unavailable, because
    // a silent fallback would leave the app loading the wrong dev server.
    port: 5173,
    strictPort: true,
    host: demo ? '0.0.0.0' : devHost || false,
    ...(demo ? { allowedHosts: true as const } : {}),
    // `exactOptionalPropertyTypes` forbids passing an explicit `undefined`, so
    // the key is spread in only when there is something to pass.
    ...(devHost ? { hmr: { protocol: 'ws', host: devHost, port: 1421 } } : {}),
    watch: {
      // Never watch the Rust side; Vite has no reason to reload on it. Nor the
      // build outputs: a `npm run build` beside a running demo would otherwise
      // reload the page, and the demo's in-memory data with it.
      ignored: ['**/src-tauri/**', '**/dist/**', '**/dist-demo/**'],
    },
  },

  // Exposed to the Tauri source. Keep this list explicit and minimal.
  envPrefix: ['VITE_', 'TAURI_ENV_*'],

  build: {
    // ES2022 matches the tsconfig target and the chrome105 floor.
    target: (platform && BROWSER_TARGETS[platform]) || DEFAULT_TARGET,
    // Do not minify debug builds so stack traces stay readable on device.
    minify: !isDebug,
    sourcemap: isDebug,
    outDir: demo ? 'dist-demo' : 'dist',
    emptyOutDir: true,
  },

  preview: demo ? { host: '0.0.0.0', port: 4173, allowedHosts: true as const } : {},
  };
});