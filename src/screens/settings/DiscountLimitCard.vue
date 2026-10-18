<script setup lang="ts">
// «حد خصم البيّاع من غير PIN المالك» card in Settings
// (`docs/ui/mockup-v1/views/settings.js`, `ADR-021` §1, `docs/PLAN.md` §4 & §5).
import { ref, watch } from 'vue';

import { describeError } from '../../api/errors';
import {
  appearance,
  normalizeDiscountLimitPct,
  setAppearance,
} from '../../ui/appearance';
import { parseCount } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

const PRESETS = ['0', '5', '10', '15', '20'] as const;
const draft = ref(appearance.discountLimitPct);

watch(
  () => appearance.discountLimitPct,
  (v) => {
    draft.value = v;
  }
);

async function applyPct(raw: string): Promise<void> {
  const parsed = parseCount(raw);
  if (parsed === null || parsed < 0 || parsed > 100) {
    toast('اكتب نسبة خصم صحيحة بين 0 و 100%', 'err');
    draft.value = appearance.discountLimitPct;
    return;
  }
  const normalized = normalizeDiscountLimitPct(String(parsed));
  draft.value = normalized;
  if (normalized === appearance.discountLimitPct) return;
  try {
    await setAppearance({ discountLimitPct: normalized });
    toast(
      normalized === '0'
        ? 'أي خصم دلوقتي هيطلب موافقة المالك بالـPIN'
        : `حد خصم البيّاع من غير PIN بقى ${normalized}%`,
      'info'
    );
  } catch (err) {
    draft.value = appearance.discountLimitPct;
    toast(describeError(err), 'err');
  }
}

async function toggleSellerCanCloseShift(event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked;
  const next = checked ? 'on' : 'off';
  try {
    await setAppearance({ sellerCanCloseShift: next });
    toast(
      checked
        ? 'تم السماح للبيّاع بتقفيل الوردية'
        : 'تقفيل الوردية بقى للمالك بس',
      'info'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-card="discount-limit">
    <h3>صلاحيات البيّاع والخصومات</h3>
    <div class="s-row">
      <div class="t">
        <b>أقصى نسبة خصم للبيّاع من غير PIN المالك</b>
        <small>
          لو مجموع خصم الأصناف وخصم الفاتورة عدّى النسبة دي، السيستم هيطلب PIN المالك قبل إتمام البيعة
        </small>
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap">
        <div class="seg" role="group" aria-label="اختيارات سريعة لحد الخصم">
          <button
            v-for="p in PRESETS"
            :id="`discount-limit-preset-${p}`"
            :key="p"
            type="button"
            class="seg-b"
            :class="{ on: appearance.discountLimitPct === p }"
            @click="applyPct(p)"
          >
            {{ p }}%
          </button>
        </div>
        <div class="row" style="gap: 6px">
          <input
            id="discount-limit-pct-input"
            v-model="draft"
            class="in mono"
            dir="ltr"
            inputmode="numeric"
            style="width: 72px; text-align: center"
            aria-label="نسبة حد الخصم"
            @keydown.enter.prevent="applyPct(draft)"
          />
          <button
            id="discount-limit-pct-save"
            type="button"
            class="btn"
            @click="applyPct(draft)"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
    <div class="s-row" style="margin-top: 10px">
      <div class="t">
        <b>السماح للبيّاع بتقفيل الوردية</b>
        <small>
          افتراضيًا المالك بس اللي بيقفّل الوردية. لو فعّلتها يقدر البيّاع يقفّل الوردية ويبعت التقرير على واتساب
        </small>
      </div>
      <label class="switch">
        <input
          id="seller-can-close-shift-toggle"
          type="checkbox"
          data-seller-can-close-shift-toggle
          :checked="appearance.sellerCanCloseShift === 'on'"
          @change="toggleSellerCanCloseShift"
        />
        <i />
      </label>
    </div>
    <div class="note" style="margin-top: 10px">
      <Icon name="percent" />
      <span>
        لو خلّيتها <b>0%</b> يبقى أي خصم مهما كان صغير لازم يوافق عليه المالك بالـPIN.
      </span>
    </div>
  </section>
</template>
