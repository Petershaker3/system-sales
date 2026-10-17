<script setup lang="ts">
// Settings → الشكل (docs/ui/mockup-v1/views/settings.js, `setLook`).
// The owner picks the look, light/dark, the shop colour, the font, the size
// and the digits; everything repaints at once and is stored in the shop
// database. Rust asks for a fresh password for these (like every setting):
// when it does, the password is asked here once and the change is retried.
import { ref } from 'vue';

import { describeError } from '../../api/errors';
import * as lifecycle from '../../api/lifecycle';
import { ACCENTS, appearance, FONTS, LOOKS, setAppearance } from '../../ui/appearance';
import type { Appearance } from '../../ui/appearance';
import { hexOf, onAccent, rgbOf } from '../../ui/color';
import type { Rgb } from '../../ui/color';
import { money } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

const THEMES = [
  { id: 'light', icon: 'sun', label: 'فاتح' },
  { id: 'dark', icon: 'moon', label: 'غامق' },
  { id: 'auto', icon: 'monitor', label: 'زي الجهاز' },
] as const;

const pending = ref<Partial<Appearance> | null>(null);
const password = ref('');
const busy = ref(false);
const error = ref('');

function labelOn(hex: string): string {
  const c = rgbOf(hex);
  return c === null ? '#ffffff' : hexOf(onAccent(c as Rgb));
}

async function choose(patch: Partial<Appearance>): Promise<void> {
  try {
    await setAppearance(patch);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'REAUTHENTICATION_REQUIRED') {
      pending.value = patch;
      password.value = '';
      error.value = '';
      return;
    }
    toast(describeError(err), 'err');
  }
}

async function confirm(): Promise<void> {
  const patch = pending.value;
  if (patch === null || busy.value) return;
  busy.value = true;
  try {
    await lifecycle.reauthenticate(password.value);
    password.value = '';
    pending.value = null;
    await setAppearance(patch);
    toast('اتحفظ الشكل');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

let colourTimer = 0;
function pickColour(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  // The picker fires while dragging; store only when it settles.
  window.clearTimeout(colourTimer);
  colourTimer = window.setTimeout(() => void choose({ accent: value }), 350);
}
</script>

<template>
  <section class="card">
    <h3><Icon name="palette" /> الشكل</h3>

    <div class="s-row" style="align-items: flex-start">
      <div class="t"><b>الطابع</b><small>شكل الواجهة كلها. أماكن الحاجات والخطوات والاختصارات زي ما هي</small></div>
      <div class="look-cards">
        <button
          v-for="look in LOOKS"
          :key="look.id"
          type="button"
          class="look-card"
          :class="{ on: appearance.look === look.id }"
          :aria-pressed="appearance.look === look.id"
          @click="choose({ look: look.id })"
        >
          <span class="lk" :class="`lk-${look.id}`" aria-hidden="true">
            <i class="lk-rail" /><i class="lk-a" /><i class="lk-b" /><i class="lk-pay" />
          </span>
          <b>{{ look.name }}</b>
          <small>{{ look.hint }}</small>
        </button>
      </div>
    </div>

    <div class="s-row">
      <div class="t"><b>الوضع</b><small>فاتح للنهار، وغامق للليل أو لو النور قوي على الشاشة</small></div>
      <div class="seg">
        <button
          v-for="t in THEMES"
          :key="t.id"
          type="button"
          :class="{ on: appearance.theme === t.id }"
          @click="choose({ theme: t.id })"
        >
          <Icon :name="t.icon" /> {{ t.label }}
        </button>
      </div>
    </div>

    <div class="s-row">
      <div class="t">
        <b>اللون الأساسي</b>
        <small>لون المحل للأزرار والتحديد، والكلام عليه بيتظبط لوحده عشان يفضل مقروء. ألوان الحالة ثابتة</small>
      </div>
      <div class="swatches">
        <button
          v-for="c in ACCENTS"
          :key="c"
          type="button"
          class="swatch"
          :class="{ on: appearance.accent === c }"
          :style="{ background: c, color: labelOn(c) }"
          :title="c"
          @click="choose({ accent: c })"
        >
          <Icon v-if="appearance.accent === c" name="check" />
        </button>
        <label class="color-in">
          <Icon name="palette" /> لون تاني
          <input type="color" :value="appearance.accent" aria-label="لون مخصص" @input="pickColour" />
        </label>
      </div>
    </div>

    <div class="s-row" style="align-items: flex-start">
      <div class="t"><b>الخط</b><small>كل الخطوط مجانية وشغالة من غير إنترنت</small></div>
      <div class="font-cards">
        <button
          v-for="f in FONTS"
          :key="f.id"
          type="button"
          class="font-card"
          :class="{ on: appearance.font === f.id }"
          :style="{ fontFamily: f.id === 'auto' ? 'var(--font-look)' : `'${f.name === 'IBM Plex' ? 'IBM Plex Sans Arabic' : f.name}'` }"
          @click="choose({ font: f.id })"
        >
          <span class="fs">أهلاً بيك، {{ money(925000) }}</span>
          <small>{{ f.name }}</small>
        </button>
      </div>
    </div>

    <div class="s-row">
      <div class="t"><b>حجم الكلام</b><small>«كبير» مريح لو الشاشة بعيدة شوية</small></div>
      <div class="seg">
        <button type="button" :class="{ on: appearance.scale === 'normal' }" @click="choose({ scale: 'normal' })">عادي</button>
        <button type="button" :class="{ on: appearance.scale === 'large' }" @click="choose({ scale: 'large' })">كبير</button>
      </div>
    </div>

    <div class="s-row">
      <div class="t"><b>شكل الأرقام</b><small>الباركود وأرقام التليفونات بتفضل إنجليزي دايمًا عشان المطابقة</small></div>
      <div class="seg">
        <button type="button" :class="{ on: appearance.digits === 'latin' }" @click="choose({ digits: 'latin' })">123</button>
        <button type="button" :class="{ on: appearance.digits === 'arabic' }" @click="choose({ digits: 'arabic' })">١٢٣</button>
      </div>
    </div>

    <Modal v-if="pending" title="تأكيد كلمة السر" sub="حفظ الشكل محتاج كلمة سر المالك" size="sm" @close="pending = null">
      <form class="stack" @submit.prevent="confirm" @keydown.enter.prevent="confirm">
        <div class="field">
          <label for="look-pass">كلمة السر</label>
          <input id="look-pass" v-model="password" type="password" autocomplete="current-password" data-autofocus />
        </div>
        <div class="err-msg" role="alert">{{ error }}</div>
      </form>
      <template #foot>
        <button type="button" class="btn primary" :disabled="busy" @click="confirm">احفظ</button>
        <button type="button" class="btn ghost" :disabled="busy" @click="pending = null">رجوع</button>
      </template>
    </Modal>
  </section>
</template>
