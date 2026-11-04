<script setup lang="ts">
// «بداية اليوم» in Settings (owner request, 2026-11-02).
//
// The shop closes after midnight, so the day's till does not change at 12:00 AM
// while the shutters are still up. This choice says when the reports start a new
// day: at midnight, or later — «من أول تاني يوم», the default, so a sale at 1:30
// AM counts on the day that is ending.
import { describeError } from '../../api/errors';
import { appearance, setAppearance, type DayStartChoice } from '../../ui/appearance';
import { toast } from '../../ui/toast';

const HOURS: readonly { value: DayStartChoice; label: string; sub: string }[] = [
  { value: '0', label: '12 ص', sub: 'اليوم يبدأ بالليل — أي بيع بعد 12 ص يتحسب على اليوم الجديد' },
  { value: '3', label: '3 الصبح', sub: 'اللي بيتباع بعد 12 ص لحد 3 الصبح يتحسب على اليوم اللي فات' },
  { value: '5', label: '5 الصبح', sub: 'الافتراضي — البيع بعد 12 ص لحد 5 الصبح على اليوم اللي فات' },
  { value: '6', label: '6 الصبح', sub: 'اللي بيتباع بعد 12 ص لحد 6 الصبح يتحسب على اليوم اللي فات' },
  { value: '8', label: '8 الصبح', sub: 'اللي بيتباع بعد 12 ص لحد 8 الصبح يتحسب على اليوم اللي فات' },
];

async function choose(hour: DayStartChoice): Promise<void> {
  if (appearance.dayStartHour === hour) return;
  try {
    await setAppearance({ dayStartHour: hour });
    toast(`بداية اليوم بقت ${HOURS.find((h) => h.value === hour)?.label ?? hour}`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-settings-card="day-start">
    <h3>بداية اليوم</h3>
    <div class="s-row">
      <div class="t">
        <b>اليوم بيتحسب من إمتى؟</b>
        <span class="muted">
          بيأثر على تقارير اليوم والوردية: البيع اللي بعد 12 ص بالليل يتحسب على النهارده ولا على
          اليوم اللي فات.
        </span>
      </div>
    </div>
    <div class="day-start-choices" data-day-start-choices>
      <button
        v-for="hour in HOURS"
        :key="hour.value"
        type="button"
        class="btn sm"
        :class="{ primary: appearance.dayStartHour === hour.value }"
        :data-day-start="hour.value"
        :title="hour.sub"
        @click="choose(hour.value)"
      >
        {{ hour.label }}
      </button>
    </div>
    <small class="muted" data-day-start-note>
      {{
        appearance.dayStartHour === '0'
          ? 'دلوقتي: اليوم يبدأ 12 ص بالليل.'
          : `دلوقتي: اليوم يبدأ الساعة ${appearance.dayStartHour} الصبح — والبيع قبل كده بيتحسب على اليوم اللي فات.`
      }}
    </small>
  </section>
</template>

<style scoped>
.day-start-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 10px 0 6px;
}
</style>
