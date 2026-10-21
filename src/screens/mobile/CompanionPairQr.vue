<script setup lang="ts">
// The pairing QR, in one place (`ADR-042`).
//
// It belongs to the computer: the machine that owns the database is the one a
// handset points at, so the handset must never render this. The settings card and
// the computer's link panel both use this component, which is the difference
// between "the QR is on the PC" being a rule and being a habit someone remembers.
//
// The modules are a real QR code (`buildPairingQrMatrix` → `@zxing/library`):
// the encoding is lazy-loaded, so the white plate with its quiet zone renders
// first and the squares land a moment later. The plate never collapses — the
// smoke test counts the `<svg>` before the writer has said a word.

import { computed, ref, watch } from 'vue';
import { appearance } from '../../ui/appearance';
import { buildPairingQrMatrix } from './companion';

const props = withDefaults(
  defineProps<{
    /** The `MSHOP-PAIR|v1|…` payload. Empty falls back to the shop's own. */
    readonly payload: string;
    /** The DOM hook the smoke test and the docs read. */
    readonly marker?: string;
    readonly ariaLabel?: string;
    /** Rendered pixel size of the square. */
    readonly pixels?: number;
  }>(),
  { marker: 'data-companion-qr', ariaLabel: 'كود ربط الموبايل', pixels: 136 },
);

const effectivePayload = computed(
  () =>
    props.payload ||
    `MSHOP-PAIR|v1|${appearance.shopName || 'موبايل ستور'}|192.168.1.10:8787|PAIR-8787`,
);

const matrix = ref<boolean[][]>([]);
// One encode is in flight per payload; a stale result must not overwrite a
// newer one (the rotate button changes the pair code on purpose).
let encodeToken = 0;

watch(
  effectivePayload,
  (payload) => {
    const token = ++encodeToken;
    void buildPairingQrMatrix(payload)
      .then((grid) => {
        if (token === encodeToken) matrix.value = grid;
      })
      .catch(() => {
        if (token === encodeToken) matrix.value = [];
      });
  },
  { immediate: true },
);

/** The QR version grows with the payload; 21 is version 1, the smallest. */
const side = computed(() => Math.max(matrix.value.length, 21));
/** A quiet zone of four modules — the part scanners look for around the code. */
const quiet = 4;
const markerAttrs = computed(() => ({ [props.marker]: '' }));
</script>

<template>
  <div class="pair-qr" v-bind="markerAttrs">
    <svg
      :viewBox="`${-quiet} ${-quiet} ${side + quiet * 2} ${side + quiet * 2}`"
      :width="pixels"
      :height="pixels"
      shape-rendering="crispEdges"
      role="img"
      :aria-label="ariaLabel"
    >
      <rect
        :x="-quiet"
        :y="-quiet"
        :width="side + quiet * 2"
        :height="side + quiet * 2"
        fill="#ffffff"
      />
      <template v-for="(row, r) in matrix" :key="r">
        <template v-for="(cell, c) in row" :key="`${r}-${c}`">
          <rect
            v-if="cell"
            :x="c"
            :y="r"
            width="1"
            height="1"
            fill="#141517"
          />
        </template>
      </template>
    </svg>
  </div>
</template>
