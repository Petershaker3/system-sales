/// <reference types="vite/client" />

// Type shim for Vue single-file components.
//
// `vue-tsc` type-checks `.vue` files directly, so this shim only needs to
// satisfy plain `tsc` and editor tooling. It deliberately declares no props or
// emits type, so a component imported without its real definition cannot
// silently type-check as `any`.

declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}