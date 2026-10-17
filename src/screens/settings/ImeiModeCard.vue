<script setup lang="ts">
// «وضع الـ IMEI للموبايلات» card in Settings (`docs/ui/mockup-v1/views/settings.js`,
// `ADR-019`, `docs/PLAN.md` §7 & §11).
import { describeError } from '../../api/errors';
import { appearance, setAppearance } from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

async function chooseMode(mode: 'optional' | 'required'): Promise<void> {
  if (appearance.imeiMode === mode) return;
  try {
    await setAppearance({ imeiMode: mode });
    toast(
      mode === 'optional'
        ? 'الـ IMEI بقى اختياري: تقدر تبيع الموبايل بضغطة أو تربط الـ IMEI وقت ما تحب'
        : 'الـ IMEI بقى إلزامي: كل موبايل لازم يتسجّل ليه IMEI وقت الاستلام والبيع',
      'info'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card">
    <h3>الـ IMEI للموبايلات</h3>
    <div class="s-row">
      <div class="t">
        <b>تسجيل الـ IMEI في الاستلام والبيع</b>
        <small>
          في الوضع الاختياري تقدر تستلم وتبيع الموبايل بالعدد أو تسجّل الـ 15 رقم وقت ما تحب
        </small>
      </div>
      <div class="seg" role="group" aria-label="وضع الـ IMEI">
        <button
          id="imei-mode-optional"
          type="button"
          class="seg-b"
          :class="{ on: appearance.imeiMode === 'optional' }"
          @click="chooseMode('optional')"
        >
          اختياري (الأسرع)
        </button>
        <button
          id="imei-mode-required"
          type="button"
          class="seg-b"
          :class="{ on: appearance.imeiMode === 'required' }"
          @click="chooseMode('required')"
        >
          إلزامي لكل جهاز
        </button>
      </div>
    </div>
    <div class="note" style="margin-top: 12px">
      <Icon name="info" />
      <span>
        لو بعت موبايل من غير IMEI وفيه أجهزة متسجّل ليها IMEI، السيستم بيسحب من الرصيد غير المسجّل الأول، ولو خلص بيقفل أقدم جهاز مسجّل تلقائيًا عشان الأعداد تفضل مظبوطة.
      </span>
    </div>
  </section>
</template>
