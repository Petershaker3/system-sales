<script setup lang="ts">
// The pairing QR, in one place (`ADR-042`).
//
// It belongs to the computer: the machine that owns the database is the one a
// handset points at, so the handset must never render this. The settings card and
// the computer's link panel both use this component, which is the difference
// between "the QR is on the PC" being a rule and being a habit someone remembers.
//
// The code is encoded for real (`pair-qr.ts`). Until the computer has a payload —
// the status has not loaded, or the link is off — the box says so instead of
// drawing a placeholder pattern that a camera would read as nothing while the
// shop keeps trying.

import { computed, ref, watch } from 'vue';

import { buildPairQr, looksLikePairPayload, type PairQrCode } from './pair-qr';

const props = withDefaults(
  defineProps<{
    /** The `MSHOP-PAIR|v1|…` (or `MSHOP-REMOTE|v1|…`) line. Empty means «not ready». */
    readonly payload: string;
    /** The DOM hook the smoke test and the docs read. */
    readonly marker?: string;
    readonly ariaLabel?: string;
    /** Rendered width in pixels; the code stays square. */
    readonly width?: number;
  }>(),
  { marker: 'data-companion-qr', ariaLabel: 'كود ربط الموبايل', width: 168 },
);

/**
 * The encoded code, filled asynchronously: the encoder is a lazy import, because
 * most of the app never shows a QR and unpacking a megabyte at launch is a cost
 * the till should not pay (`pair-qr.ts`).
 */
const qr = ref<PairQrCode | null>(null);

watch(
  () => props.payload,
  async (payload) => {
    const trimmed = payload.trim();
    qr.value = null;
    if (trimmed === '' || !looksLikePairPayload(trimmed) && !trimmed.startsWith('MSHOP-REMOTE|')) {
      return;
    }
    try {
      const built = await buildPairQr(trimmed);
      // The panel may have changed while the encoder loaded; only the newest
      // payload may be drawn, or the shop scans a code that is already stale.
      if (props.payload.trim() === trimmed) qr.value = built;
    } catch {
      // Too long for the largest version: the panel still prints the line below.
      qr.value = null;
    }
  },
  { immediate: true },
);

const markerAttrs = computed(() => ({ [props.marker]: '' }));
</script>

<template>
  <div
    class="pair-qr"
    v-bind="markerAttrs"
    :data-qr-payload="qr?.payload"
    :data-qr-modules="qr === null ? undefined : `${qr.size}x${qr.size}`"
  >
    <svg
      v-if="qr !== null"
      :viewBox="`0 0 ${qr.size} ${qr.size}`"
      :width="width"
      :height="width"
      shape-rendering="crispEdges"
      :aria-label="ariaLabel"
      role="img"
    >
      <!-- The quiet zone is part of the matrix, so the white plate is the frame. -->
      <rect :width="qr.size" :height="qr.size" fill="#ffffff" />
      <path :d="qr.path" fill="#141517" />
    </svg>
    <div v-else class="pair-qr-pending" data-qr-pending :style="{ width: `${width}px`, height: `${width}px` }">
      <span>الكود بيتجهز…</span>
      <small>لازم الكمبيوتر يفتح الربط الأول</small>
    </div>
  </div>
</template>

<style scoped>
.pair-qr {
  display: grid;
  place-items: center;
  padding: 6px;
  border-radius: var(--r-m);
  background: #ffffff;
  line-height: 0;
}
.pair-qr svg {
  display: block;
  max-width: 100%;
  height: auto;
}
.pair-qr-pending {
  display: grid;
  place-items: center;
  gap: 4px;
  line-height: 1.4;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-s);
  background: var(--surface);
  color: var(--muted);
  text-align: center;
  font-size: 0.82rem;
  padding: 8px;
}
.pair-qr-pending small {
  font-size: 0.74rem;
}
</style>
