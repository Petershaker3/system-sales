<script setup lang="ts">
// «خصم المصاريف» في الإعدادات (طلب صاحب المحل، 2026-11-02).
//
// مصاريف اليوم بتتخصم منين في الأرقام اللي بتتعرض؟
//   - «من صافي اليوم» (الافتراضي): صافي النهارده = ربح اليوم ناقص مصاريف اليوم.
//   - «في ملخص الشهر بس»: صافي النهارده يفضل عن البيع والخدمة، والمصاريف تتحسب
//     مرة واحدة في تقرير الشهر — عشان مبيعات اليوم تفضل مستقلة.
import { describeError } from '../../api/errors';
import { appearance, setAppearance, type ExpensesDeductChoice } from '../../ui/appearance';
import { toast } from '../../ui/toast';

const MODES: readonly { value: ExpensesDeductChoice; label: string; sub: string }[] = [
  {
    value: 'day',
    label: 'من صافي اليوم',
    sub: 'صافي النهارده بينقص بمصاريفه: الصافي اللي بيتعرض هو اللي فضل في إيدك فعلاً.',
  },
  {
    value: 'month',
    label: 'في ملخص الشهر بس',
    sub: 'صافي النهارده يبقى عن البيع والخدمة بس، والمصاريف تتحسب مرة واحدة في تقرير الشهر.',
  },
];

async function choose(mode: ExpensesDeductChoice): Promise<void> {
  if (appearance.expensesDeduct === mode) return;
  try {
    await setAppearance({ expensesDeduct: mode });
    toast(
      mode === 'month'
        ? 'المصاريف هتظهر في ملخص الشهر بس — صافي اليوم بقى مستقل'
        : 'مصاريف اليوم بقت بتتخصم من صافي اليوم',
      'info',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-settings-card="expenses-deduct">
    <h3>خصم المصاريف</h3>
    <div class="s-row">
      <div class="t">
        <b>مصاريف اليوم بتتخصم فين؟</b>
        <span class="muted">
          الاختيار ده بيغيّر رقم «صافي النهارده» في التقارير والمبيعات. المصاريف نفسها
          بتتسجل في الحالتين، وما فيش رقم بيضيع.
        </span>
      </div>
    </div>
    <div class="expenses-deduct-choices" data-expenses-deduct-choices>
      <button
        v-for="mode in MODES"
        :key="mode.value"
        type="button"
        class="btn"
        :class="{ primary: appearance.expensesDeduct === mode.value }"
        :data-expenses-deduct="mode.value"
        :title="mode.sub"
        @click="choose(mode.value)"
      >
        {{ mode.label }}
      </button>
    </div>
    <small class="muted" data-expenses-deduct-note>
      {{
        appearance.expensesDeduct === 'month'
          ? 'دلوقتي: صافي اليوم قبل المصاريف، والمصاريف في ملخص الشهر.'
          : 'دلوقتي: مصاريف اليوم بتتخصم من صافي اليوم.'
      }}
    </small>
  </section>
</template>

<style scoped>
.expenses-deduct-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 6px;
}
</style>
