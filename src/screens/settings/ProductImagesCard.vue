<script setup lang="ts">
// «صور الأصناف» card in Settings («الأصناف والبيع», docs/ui/mockup-v1/views/settings.js,
// ADR-018 §5, plan item 1.2 step 5).

import { onMounted, ref } from 'vue';
import { describeError } from '../../api/errors';
import { listProductImages } from '../../api/images';
import { appearance, setAppearance } from '../../ui/appearance';
import { num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

const count = ref(0);

async function loadCount(): Promise<void> {
  try {
    const imgs = await listProductImages();
    count.value = imgs.length;
  } catch {
    count.value = 0;
  }
}

async function onToggle(ev: Event): Promise<void> {
  const checked = (ev.target as HTMLInputElement).checked;
  const next = checked ? 'on' : 'off';
  try {
    await setAppearance({ images: next });
    toast(
      checked
        ? 'هتظهر صور الأصناف في شاشة البيع'
        : 'اتخفت صور الأصناف من شاشة البيع (الصور محفوظة مش بتتمسح)',
      'info',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

onMounted(() => {
  void loadCount();
});
</script>

<template>
  <section class="card">
    <h3>صور الأصناف</h3>
    <div class="s-row">
      <div class="t">
        <b>اعرض صور الأصناف</b>
        <small>في مربعات البيع ونتايج البحث وتطبيق الموبايل، والصنف اللي ملوش صورة بتفضل أيقونته</small>
      </div>
      <label class="switch">
        <input
          id="show-product-images"
          type="checkbox"
          :checked="appearance.images === 'on'"
          aria-label="اعرض صور الأصناف"
          @change="onToggle"
        />
        <span></span>
      </label>
    </div>
    <div class="note" style="margin-top: 12px">
      <Icon name="info" />
      <span>
        اختيارية: بتتضاف من المخزن بالدوس على أيقونة الصنف. الصورة بتتقص مربع وتتصغّر لوحدها (حوالي 15 ك.ب)، يعني ألف صنف بصورهم حوالي 15 م.ب بس.
        {{ count > 0 ? `عندك ${num(count)} صنف بصورة دلوقتي.` : 'لسه مفيش صور.' }}
      </span>
    </div>
  </section>
</template>
