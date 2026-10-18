<script setup lang="ts">
// IMEI picker & late-registration modal (`MODALS.imei` in `docs/ui/mockup-v1/pos.js`,
// `ADR-019`, `docs/PLAN.md` §7).
import { computed, ref } from 'vue';

import type { PosProduct, PosUnit } from '../../api/pos';
import { money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { imeiLuhn, normalizeImeiDigits } from './imei';

const props = defineProps<{
  product: PosProduct;
  units: readonly PosUnit[];
  takenImeis: ReadonlySet<string>;
  freeStock: number;
  currentImei: string | null;
  canClear: boolean;
}>();

const emit = defineEmits<{
  close: [];
  pick: [imei: string | null];
}>();

const query = ref('');

/** Free registered units for this phone (plus `currentImei` if already attached to this line). */
const freeUnits = computed<PosUnit[]>(() =>
  props.units.filter(
    (u) =>
      u.productId === props.product.id &&
      (!props.takenImeis.has(u.imei) || u.imei === props.currentImei)
  )
);

/** How many units on the shelf have no registered IMEI yet (`onHand - registeredUnitsCount`). */
const totalRegisteredForProduct = computed(
  () => props.units.filter((u) => u.productId === props.product.id).length
);
const unregisteredCount = computed(() =>
  Math.max(0, props.product.onHand - totalRegisteredForProduct.value)
);

const digits = computed(() => normalizeImeiDigits(query.value));

const filteredUnits = computed<PosUnit[]>(() => {
  const d = digits.value;
  if (d === '') return freeUnits.value;
  return freeUnits.value.filter(
    (u) => u.imei.endsWith(d) || u.imei.includes(d) || (u.imei2 !== null && u.imei2.includes(d))
  );
});

/** Whether the typed 15 digits are already registered anywhere in the shop. */
const existingInShop = computed(() => {
  const d = digits.value;
  if (d.length !== 15) return null;
  return props.units.find((u) => u.imei === d || u.imei2 === d) ?? null;
});

const canRegisterLate = computed(() => {
  const d = digits.value;
  if (!/^\d{15}$/.test(d)) return null;
  if (existingInShop.value !== null) return null;
  if (props.takenImeis.has(d) && d !== props.currentImei) {
    return { ok: false as const, message: 'الـ IMEI ده محطوط بالفعل في فاتورة مفتوحة.' };
  }
  if (unregisteredCount.value <= 0) {
    return {
      ok: false as const,
      message: `كل المتاح (${num(props.product.onHand)}) متسجّل ليه IMEI بالفعل — اختار واحد من القائمة.`,
    };
  }
  if (!imeiLuhn(d)) {
    return {
      ok: false as const,
      message: 'الـ 15 رقم فيهم رقم غلط (فحص Luhn) — راجع العلبة أو اكتب *#06#.',
    };
  }
  return { ok: true as const, imei: d };
});

function onEnter(): void {
  if (filteredUnits.value.length > 0 && digits.value.length < 15) {
    const first = filteredUnits.value[0];
    if (first) emit('pick', first.imei);
    return;
  }
  if (filteredUnits.value.length === 1) {
    const first = filteredUnits.value[0];
    if (first) {
      emit('pick', first.imei);
      return;
    }
  }
  if (canRegisterLate.value?.ok) {
    emit('pick', canRegisterLate.value.imei);
  }
}
</script>

<template>
  <Modal
    :title="currentImei ? 'تغيير أو تسجيل IMEI' : 'اختار جهاز بالـ IMEI'"
    :sub="`${product.name} · ${product.salePriceMinor !== null ? money(product.salePriceMinor) : ''} · متاح ${num(freeStock)}`"
    size="md"
    @close="emit('close')"
  >
    <div class="stack">
      <label class="search-box">
        <Icon name="scan-barcode" />
        <input
          id="imei-in"
          v-model="query"
          :class="{ mono: query !== '' }"
          :dir="query ? 'ltr' : 'rtl'"
          inputmode="numeric"
          maxlength="17"
          autocomplete="off"
          placeholder="امسح الباركود أو اكتب آخر 4 أرقام أو 15 رقم كاملين…"
          data-autofocus
          @keydown.enter.prevent="onEnter"
        />
        <span class="muted" style="font-size: 0.78rem">{{ num(digits.length) }}/15</span>
      </label>

      <div v-if="canRegisterLate !== null">
        <div v-if="canRegisterLate.ok" class="new-imei-box ok">
          <div>
            <b>تسجيل جهاز جديد من الرصيد غير المسجّل وبيعه</b>
            <div class="mono" dir="ltr">{{ canRegisterLate.imei }}</div>
          </div>
          <button
            id="imei-register-btn"
            type="button"
            class="btn primary sm"
            @click="emit('pick', canRegisterLate.imei)"
          >
            <Icon name="check" /> سجّل وبيع <kbd>Enter</kbd>
          </button>
        </div>
        <div v-else class="note warn">
          <Icon name="triangle-alert" />
          <span>{{ canRegisterLate.message }}</span>
        </div>
      </div>

      <div class="imei-list">
        <div v-if="filteredUnits.length === 0" class="muted" style="padding: 12px; text-align: center">
          <template v-if="freeUnits.length === 0 && unregisteredCount > 0">
            مفيش أجهزة متسجّل ليها IMEI مسبقًا — امسح الـ 15 رقم من العلبة فوق عشان يتسجّل ويتباع.
          </template>
          <template v-else>
            مفيش جهاز مسجّل مطابق للبحث ده.
          </template>
        </div>
        <button
          v-for="(u, idx) in filteredUnits"
          :key="u.id"
          type="button"
          class="imei-row"
          :class="{ on: u.imei === currentImei || (idx === 0 && digits !== '') }"
          @click="emit('pick', u.imei)"
        >
          <Icon name="smartphone" />
          <bdi dir="ltr" class="mono imei-digits">
            {{ u.imei.slice(0, 11) }}<b>{{ u.imei.slice(11) }}</b>
          </bdi>
          <span v-if="u.conditionGrade" class="tag">فئة {{ u.conditionGrade }}</span>
          <span
            v-if="u.batteryHealthPct !== null && u.batteryHealthPct !== undefined"
            class="tag mono"
            dir="ltr"
          >
            {{ u.batteryHealthPct }}%
          </span>
          <span v-if="u.color" class="tag">{{ u.color }}</span>
          <span v-if="u.accessories" class="tag">{{ u.accessories }}</span>
          <span v-if="u.intakeNote" class="muted" style="font-size: 0.78rem">
            {{ u.intakeNote }}
          </span>
          <span class="sp" />
          <span class="pick-lbl">
            {{ u.imei === currentImei ? 'المربوط حاليًا' : 'اختار' }}
            <kbd v-if="idx === 0">Enter</kbd>
          </span>
        </button>
      </div>
    </div>

    <template #foot>
      <button
        v-if="canClear && currentImei !== null"
        id="imei-clear-btn"
        type="button"
        class="btn danger"
        @click="emit('pick', null)"
      >
        <Icon name="x" /> شيل الـ IMEI (بيع بالعدد)
      </button>
      <span class="sp" />
      <button type="button" class="btn ghost" @click="emit('close')">إلغاء</button>
    </template>
  </Modal>
</template>

<style scoped>
.imei-list {
  display: grid;
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
}
.imei-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--ink);
  cursor: pointer;
  text-align: start;
}
.imei-row:hover,
.imei-row.on {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.imei-digits {
  font-size: 0.95rem;
  letter-spacing: 0.03em;
}
.imei-digits b {
  color: var(--accent);
}
.pick-lbl {
  font-size: 0.82rem;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.new-imei-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--accent);
  background: var(--accent-weak);
}
.sp {
  flex: 1;
}
</style>
