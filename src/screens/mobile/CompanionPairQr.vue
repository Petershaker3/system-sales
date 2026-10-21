<script setup lang="ts">
// The pairing QR, in one place (`ADR-042`).
//
// It belongs to the computer: the machine that owns the database is the one a
// handset points at, so the handset must never render this. The settings card and
// the computer's link panel both use this component, which is the difference
// between "the QR is on the PC" being a rule and being a habit someone remembers.

import { computed } from 'vue';
import { appearance } from '../../ui/appearance';
import { buildPairingQrMatrix } from './companion';

const props = withDefaults(
  defineProps<{
    /** The `MSHOP-PAIR|v1|…` payload. Empty falls back to the shop's own. */
    readonly payload: string;
    /** The DOM hook the smoke test and the docs read. */
    readonly marker?: string;
    readonly ariaLabel?: string;
    readonly side?: number;
  }>(),
  { marker: 'data-companion-qr', ariaLabel: 'كود ربط الموبايل', side: 21 },
);

const matrix = computed(() =>
  buildPairingQrMatrix(
    props.payload ||
      `MSHOP-PAIR|v1|${appearance.shopName || 'موبايل ستور'}|192.168.1.10:8787|PAIR-8787`,
    props.side,
  ),
);

const markerAttrs = computed(() => ({ [props.marker]: '' }));
</script>

<template>
  <div class="pair-qr" v-bind="markerAttrs">
    <svg
      :viewBox="`0 0 ${side} ${side}`"
      :width="side === 21 ? 136 : 120"
      :height="side === 21 ? 136 : 120"
      shape-rendering="crispEdges"
      :aria-label="ariaLabel"
    >
      <rect :width="side" :height="side" fill="#ffffff" />
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
