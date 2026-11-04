<script setup lang="ts">
// «الشريط الجانبي» — the rail's shape, and the two doors that used to live on it.
//
// Three things moved here from the rail itself:
//   * light / dark (`ui.theme`), which every role may still set — it is a look,
//     not a shop decision;
//   * «الدليل», which is a page of help, not a place in the shop;
//   * the order of the sections (`ui.nav_order`), which is the owner's layout.
//
// The rail keeps the shop's own screens. A rail that also carried the guide, the
// theme and the settings put ten similar buttons in one column, and the one door
// that changes the shop looked like the ninth page.

import { computed, ref } from 'vue';

import { describeError } from '../../api/errors';
import { isPhone } from '../../shell/device';
import {
  moveSection,
  navSectionsFor,
  orderSections,
  parseNavOrder,
  SECTION_ORDER,
} from '../../shell/nav';
import type { ScreenId } from '../../shell/nav';
import { appearance, setAppearance, type ThemeChoice } from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import { useReauth } from '../../shell/reauth';

const THEMES: readonly { id: ThemeChoice; label: string; icon: 'sun' | 'moon' | 'monitor' }[] = [
  { id: 'light', label: 'فاتح', icon: 'sun' },
  { id: 'dark', label: 'غامق', icon: 'moon' },
  { id: 'auto', label: 'زي الويندوز', icon: 'monitor' },
];

const busy = ref(false);
const {
  open: reauthOpen,
  password: reauthPassword,
  error: reauthError,
  busy: reauthBusy,
  run: runReauth,
  confirm: confirmReauth,
  cancel: cancelReauth,
} = useReauth();

/** The sections this device shows, laid out the way the rail is showing them now. */
const railItems = computed(() =>
  orderSections(navSectionsFor('manager', isPhone()), parseNavOrder(appearance.navOrder)),
);

const isDefaultOrder = computed(
  () => railItems.value.map((item) => item.id).join(',') === SECTION_ORDER.filter((id) =>
    railItems.value.some((item) => item.id === id),
  ).join(','),
);

async function saveOrder(next: readonly ScreenId[]): Promise<void> {
  busy.value = true;
  try {
    await setAppearance({ navOrder: next.join(',') });
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function onMove(id: ScreenId, delta: -1 | 1): void {
  const next = moveSection(
    railItems.value.map((item) => item.id),
    id,
    delta,
  );
  void saveOrder(next);
}

function onResetOrder(): void {
  // Empty means «the order this build ships», so a section added by a later
  // update still lands where its author put it.
  void saveOrder([]);
}

function pickTheme(id: ThemeChoice): void {
  // `AppearanceKey::Theme` is the one choice every role may change, but the
  // backend still asks for the password that proves the session; the shared gate
  // is what turns that refusal into a field (`shell/reauth.ts`).
  void runReauth(async () => {
    try {
      await setAppearance({ theme: id });
    } catch (err) {
      toast(describeError(err), 'err');
    }
  }, 'تغيير الوضع بين الفاتح والغامق');
}

function openGuide(): void {
  window.dispatchEvent(new CustomEvent('mshop:open-guide'));
}
</script>

<template>
  <section class="card rail-card" data-rail-settings-card>
    <header class="card-h">
      <h3>الشريط الجانبي</h3>
      <span class="sub">الترتيب والوضع بيتحفظوا للمحل ده</span>
    </header>

    <!-- light / dark ------------------------------------------------------- -->
    <div class="rc-row">
      <div class="rc-label">
        <b>الوضع</b>
        <small>فاتح أو غامق، أو يتبع ويندوز. على أي حساب.</small>
      </div>
      <div class="seg" data-rail-theme>
        <button
          v-for="t in THEMES"
          :key="t.id"
          type="button"
          :class="{ on: appearance.theme === t.id }"
          :data-theme-choice="t.id"
          @click="pickTheme(t.id)"
        >
          <Icon :name="t.icon" />
          {{ t.label }}
        </button>
      </div>
    </div>

    <!-- the rail's order --------------------------------------------------- -->
    <div class="rc-row rc-row-block">
      <div class="rc-label">
        <b>ترتيب الأقسام</b>
        <small>
          حرّك القسم اللي بتستخدمه أكتر لفوق. «الإعدادات» مش من الأقسام —
          مكانها تحت لوحدها.
        </small>
      </div>
      <ol class="rc-list" data-rail-order>
        <li v-for="(item, index) in railItems" :key="item.id" :data-rail-row="item.id">
          <span class="rc-ico"><Icon :name="item.icon" /></span>
          <span class="rc-name">{{ item.label }}</span>
          <span class="rc-pos">{{ index + 1 }}</span>
          <button
            type="button"
            class="btn sm ghost"
            :disabled="busy || index === 0"
            :title="`حرّك «${item.label}» لفوق`"
            :data-rail-up="item.id"
            @click="onMove(item.id, -1)"
          >
            <Icon name="arrow-up" />
          </button>
          <button
            type="button"
            class="btn sm ghost"
            :disabled="busy || index === railItems.length - 1"
            :title="`حرّك «${item.label}» لتحت`"
            :data-rail-down="item.id"
            @click="onMove(item.id, 1)"
          >
            <Icon name="arrow-down" />
          </button>
        </li>
      </ol>
      <button
        type="button"
        class="btn sm"
        :disabled="busy || isDefaultOrder"
        data-rail-order-reset
        @click="onResetOrder"
      >
        <Icon name="rotate-ccw" /> رجّع الترتيب الأصلي
      </button>
    </div>

    <!-- the guide ---------------------------------------------------------- -->
    <div class="rc-row">
      <div class="rc-label">
        <b>الدليل</b>
        <small>شرح كل شاشة واختصاراتها — أو F1 من أي مكان.</small>
      </div>
      <button type="button" class="btn sm" data-open-guide-from-settings @click="openGuide">
        <Icon name="info" /> افتح دليل السيستم
      </button>
    </div>

    <div v-if="reauthOpen" class="overlay">
      <form class="modal" @submit.prevent="confirmReauth">
        <h3 class="modal-title">تأكيد الهوية</h3>
        <p class="hint">تغيير الوضع (فاتح/غامق) محتاج كلمة مرور المدير.</p>
        <label class="field">
          <span>كلمة المرور</span>
          <input
            v-model="reauthPassword"
            type="password"
            autocomplete="current-password"
            required
            autofocus
            data-rail-reauth
          />
        </label>
        <p v-if="reauthError" class="error" role="alert">{{ reauthError }}</p>
        <div class="row">
          <button type="submit" :disabled="reauthBusy">تأكيد</button>
          <button type="button" class="soft" @click="cancelReauth">إلغاء</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.rail-card {
  display: grid;
  gap: 14px;
}
.rc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.rc-row-block {
  display: grid;
  justify-content: stretch;
}
.rc-label b {
  display: block;
  font-size: 0.95rem;
}
.rc-label small {
  color: var(--muted);
  font-size: 0.82rem;
}
.rc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.rc-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--r-s);
  background: var(--surface-2);
}
.rc-ico {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-s);
  color: var(--accent-text);
  background: var(--accent-weak);
  flex: none;
}
.rc-name {
  flex: 1;
  font-weight: 600;
}
.rc-pos {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 1.5em;
  text-align: center;
}
</style>
