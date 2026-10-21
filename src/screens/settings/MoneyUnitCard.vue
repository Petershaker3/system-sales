<script setup lang="ts">
// «وحدة الفلوس» - جنيه ولا قرش على الشاشة (`ADR-044`).
//
// المبالغ محفوظة في قاعدة البيانات بالقرش دايمًا (`ADR-010`)؛ اللي بيتغيّر هنا هو
// الوحدة اللي بتُكتب بيها وبتُقرا بيها. المحل اللي بيقول «١٥٠ جنيه» بيكتب 150،
// ومحل بيقول «١٥٠٠٠ قرش» بيكتب 15000 — والرقم في التقارير هو هو.
import { computed } from 'vue';

import { describeError } from '../../api/errors';
import { appearance, setAppearance } from '../../ui/appearance';
import { money, moneyUnitWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

const current = computed(() => appearance.moneyUnit);

/** A number drawn in the unit the shop just chose — proof, not a promise. */
const sample = computed(() => money(150_000));

async function choose(unit: 'egp' | 'piastre'): Promise<void> {
  if (appearance.moneyUnit === unit) return;
  try {
    await setAppearance({ moneyUnit: unit });
    toast(
      unit === 'egp'
        ? 'الفلوس بقت بالجنيه: اكتب 150 واقرا 150 ج.م'
        : 'الفلوس بقت بالقرش: اكتب 15000 واقرا 15,000 قرش',
      'info'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-money-unit-card>
    <h3><Icon name="banknote" /> وحدة الفلوس</h3>
    <div class="s-row">
      <div class="t">
        <b>بتكتب وبتقرا إزاي؟</b>
        <small>
          المبلغ نفسه ما بيتغيّرش في الحسابات — اللي بيتغيّر هو الوحدة اللي بتكتب بيها
          وتشوفها. «جنيه» هي اللي بيستخدمها المحل عادةً.
        </small>
      </div>
      <div class="seg" role="group" aria-label="وحدة الفلوس">
        <button
          id="money-unit-egp"
          type="button"
          class="seg-b"
          :class="{ on: current === 'egp' }"
          data-money-unit="egp"
          @click="choose('egp')"
        >
          جنيه (ج.م)
        </button>
        <button
          id="money-unit-piastre"
          type="button"
          class="seg-b"
          :class="{ on: current === 'piastre' }"
          data-money-unit="piastre"
          @click="choose('piastre')"
        >
          قرش
        </button>
      </div>
    </div>
    <div class="note" style="margin-top: 12px" data-money-unit-sample>
      <Icon name="info" />
      <span>
        1500 جنيه بتظهر {{ sample }} — وفي الخانات بتكتب
        {{ current === 'egp' ? '١٥٠٠' : '١٥٠٠٠٠' }} ({{ moneyUnitWord() }}).
      </span>
    </div>
  </section>
</template>
