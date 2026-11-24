<script setup lang="ts">
// «طرق الدفع اللي بتظهر في شاشة الدفع» card in Settings
// (`docs/ui/mockup-v1/views/settings.js`, `ADR-020` §1, `docs/PLAN.md` §8).
import { describeError } from '../../api/errors';
import {
  appearance,
  isPayMethodEnabled,
  PAY_METHODS,
  type PayMethodId,
  setAppearance,
} from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

async function toggleMethod(id: PayMethodId, enabled: boolean): Promise<void> {
  if (id === 'cash') return;
  const current = PAY_METHODS.map((m) => m.id).filter((mId) =>
    isPayMethodEnabled(mId, appearance.payMethods)
  );
  const nextSet = new Set<PayMethodId>(current);
  if (enabled) nextSet.add(id);
  else nextSet.delete(id);
  nextSet.add('cash');

  const nextValue = PAY_METHODS.map((m) => m.id)
    .filter((mId) => nextSet.has(mId))
    .join(',');
  const meta = PAY_METHODS.find((m) => m.id === id);

  try {
    await setAppearance({ payMethods: nextValue });
    toast(
      enabled
        ? `اتفتحت طريقة الدفع: ${meta?.name ?? id}`
        : `اتقفلت طريقة الدفع: ${meta?.name ?? id}`,
      'info'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-card="payment-methods">
    <h3>طرق الدفع اللي بتظهر في شاشة الدفع</h3>
    <div class="note" style="margin-bottom: 8px">
      <Icon name="info" />
      <span>
        اقفل الطرق اللي مش بتستخدمها في المحل عشان شاشة الدفع تفضل رايقة للبيّاع. «الكاش» شغّال دايمًا.
      </span>
    </div>
    <div
      v-for="m in PAY_METHODS"
      :key="m.id"
      class="s-row"
      :data-pay-method-row="m.id"
    >
      <div class="t">
        <b><Icon :name="m.icon" /> {{ m.name }}</b>
        <small>{{ m.hint }}</small>
      </div>
      <label class="switch">
        <input
          :id="`pay-method-toggle-${m.id}`"
          type="checkbox"
          :checked="isPayMethodEnabled(m.id, appearance.payMethods)"
          :disabled="!!m.alwaysEnabled"
          @change="
            toggleMethod(
              m.id,
              ($event.target as HTMLInputElement).checked
            )
          "
        />
        <span />
      </label>
    </div>
  </section>
</template>
