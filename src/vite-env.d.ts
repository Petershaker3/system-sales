/// <reference types="vite/client" />

// Build-time flags this project reads.
//
// Declared rather than accessed through an index signature, because the DOT
// form is what Vite statically replaces at build time. That replacement is not
// cosmetic: it is what lets the bundler prove a branch dead and leave the code
// behind it out of the bundle. A bracket access (`env['X']`) still typechecks
// but is not reliably replaced, and the guarded module then ships in production
// anyway. `npm run build` plus a `dist/` check is what keeps that honest.
interface ImportMetaEnv {
  /**
   * Includes the one-time recovery panel (plan R1, Design B).
   *
   * Unset by default, which is the safe state: the production bundle contains
   * no recovery UI. This flag is hygiene, NOT a security control - the control
   * is the Rust `recovery` cargo feature, without which the commands the panel
   * calls do not exist at all.
   */
  readonly VITE_RECOVERY?: string;
  /**
   * Builds the browser demo: an in-memory stand-in for the Rust backend
   * (src/dev/demo-backend.ts) so the screens can be seen in a plain browser.
   *
   * Unset by default. The production bundle and every Tauri build leave the
   * demo code out entirely, by the same dead-branch rule as above. Nothing in
   * the demo is persisted, and every screen says it shows demo data.
   */
  readonly VITE_DEMO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}