<script setup lang="ts">
// The frame every signed-in screen sits in (docs/ui/mockup-v1/app.js: rail,
// top bar, user menu). Positions and steps follow the approved mockup; only
// screens that exist in this build appear on the rail.
//
// The user chip switches who is working (ADR-017 §2, `docs/PLAN.md` §4): pick
// someone, and the menu becomes their PIN pad; their PIN signs them in and the
// open invoices stay where they are. «قفل» on the rail and Ctrl+L lock the
// screen (App.vue owns the lock).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import * as api from '../api/identity';
import type { Session, UserSummary } from '../api/identity';
import {
  currentShiftSummary,
  type CurrentShiftState,
  type ShiftSummary,
} from '../api/shift';
import { runPeriodicBackupTick } from '../api/backup';
import { describeError } from '../api/errors';
import {
  appearance,
  loadShopLogo,
  resolvedTheme,
  shopLogo,
  toggleTheme,
} from '../ui/appearance';
import { fmtTime } from '../ui/format';
import Icon from '../ui/Icon.vue';
import PinPad from '../ui/PinPad.vue';
import { toast } from '../ui/toast';
import PosScreen from '../screens/pos/PosScreen.vue';
import SalesScreen from '../screens/sales/SalesScreen.vue';
import WalletsScreen from '../screens/wallets/WalletsScreen.vue';
import StoreScreen from '../screens/store/StoreScreen.vue';
import SettingsScreen from '../screens/settings/SettingsScreen.vue';
import DrawerExpenseModal from './DrawerExpenseModal.vue';
import ShiftModal from './ShiftModal.vue';
import { avatarColour, navFor, roleName, TITLES } from './nav';
import type { ScreenId } from './nav';

const props = defineProps<{ session: Session; busy: boolean; users: readonly UserSummary[] }>();
const emit = defineEmits<{
  signOut: [];
  lock: [];
  switched: [session: Session];
  setPin: [];
  openLockFor: [userId: string];
}>();

const demo = import.meta.env.VITE_DEMO === '1';
/** The browser demo's PINs, shown under the switch pad as the mockup does. Empty in real builds. */
const DEMO_PINS: Record<string, string> = demo ? { peter: '1111', youssef: '2222', marina: '3333' } : {};

const screen = ref<ScreenId>('pos');
const items = computed(() => navFor(props.session.role));
const dark = computed(() => {
  void appearance.theme;
  return resolvedTheme() === 'dark';
});

// A seller never lands on an owner screen, even after a switch or a role change.
watch(
  () => props.session.role,
  () => {
    if (!items.value.some((item) => item.id === screen.value)) screen.value = 'pos';
  }
);

const me = computed(() => props.users.find((user) => user.id === props.session.userId) ?? null);
const others = computed(() => props.users.filter((user) => !user.disabled && user.id !== props.session.userId));

const menuOpen = ref(false);
const swUser = ref<UserSummary | null>(null);
const swError = ref('');
const swBusy = ref(false);
const swPad = ref<InstanceType<typeof PinPad> | null>(null);

function closeMenu(): void {
  menuOpen.value = false;
  swUser.value = null;
  swError.value = '';
}

function swPick(user: UserSummary): void {
  if (!user.hasPin) {
    // No PIN yet: the lock card takes their password instead.
    closeMenu();
    emit('openLockFor', user.id);
    return;
  }
  swUser.value = user;
  swError.value = '';
  // The pad owns the keyboard now; a focused search box must not take the digits.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

async function swSubmit(pin: string): Promise<void> {
  const user = swUser.value;
  if (user === null || swBusy.value) return;
  swBusy.value = true;
  swError.value = '';
  try {
    const next = await api.loginWithPin(user.id, pin);
    closeMenu();
    emit('switched', next);
  } catch (err) {
    swError.value = describeError(err);
    swPad.value?.clear();
  } finally {
    swBusy.value = false;
  }
}

function menuAction(action: 'lock' | 'setPin' | 'signOut'): void {
  closeMenu();
  if (action === 'lock') emit('lock');
  else if (action === 'setPin') emit('setPin');
  else emit('signOut');
}

/** While the switch pad is open, every key is the pad's and stops here. */
function onSwitchKey(event: KeyboardEvent): void {
  if (swUser.value === null) return;
  event.stopPropagation();
  if (swPad.value?.handleKey(event)) event.preventDefault();
}

const clock = ref(fmtTime());
let tick = 0;

const shiftState = ref<CurrentShiftState>({
  openShift: null,
  lastClosedShift: null,
  recentClosedShifts: [],
});
const drawerModalOpen = ref(false);
const shiftModalOpen = ref(false);

async function refreshShiftState(): Promise<void> {
  try {
    shiftState.value = await currentShiftSummary();
  } catch {
    // Best-effort refresh in topbar
  }
}

async function openDrawerExpenseModal(): Promise<void> {
  await refreshShiftState();
  if (!shiftState.value.openShift) {
    toast('افتح الوردية الأول عشان تسجّل مصروف أو حركة درج', 'err');
    shiftModalOpen.value = true;
    return;
  }
  drawerModalOpen.value = true;
}

async function openShiftDialog(): Promise<void> {
  await refreshShiftState();
  shiftModalOpen.value = true;
}

function onDrawerSummaryUpdated(updated: ShiftSummary): void {
  shiftState.value = {
    ...shiftState.value,
    openShift: updated,
  };
}

watch(
  () => props.session.userId,
  () => {
    void refreshShiftState();
  }
);

function onDocClick(event: MouseEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('.user-switch')) closeMenu();
}

onMounted(() => {
  void loadShopLogo();
  void refreshShiftState();
  void runPeriodicBackupTick().catch(() => {});
  tick = window.setInterval(() => {
    clock.value = fmtTime();
    void runPeriodicBackupTick().catch(() => {});
  }, 15_000);
  document.addEventListener('mousedown', onDocClick);
  window.addEventListener('keydown', onSwitchKey, true);
});
onBeforeUnmount(() => {
  window.clearInterval(tick);
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onSwitchKey, true);
});

async function switchTheme(): Promise<void> {
  try {
    await toggleTheme();
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <div class="shell">
    <nav class="rail" aria-label="الأقسام">
      <div class="logo" aria-hidden="true">
        <img v-if="shopLogo" :src="shopLogo" alt="" />
        <span v-else>{{ (appearance.shopName || 'م').trim().charAt(0) }}</span>
      </div>
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="nav-btn"
        :class="{ active: screen === item.id }"
        :title="item.label"
        :aria-current="screen === item.id ? 'page' : undefined"
        @click="screen = item.id"
      >
        <Icon :name="item.icon" />
        <span>{{ item.label }}</span>
      </button>
      <div class="sp" />
      <button type="button" class="nav-btn" title="فاتح / غامق" @click="switchTheme">
        <Icon :name="dark ? 'sun' : 'moon'" />
        <span>{{ dark ? 'فاتح' : 'غامق' }}</span>
      </button>
      <button type="button" class="nav-btn" title="قفل الشاشة (Ctrl+L)" :disabled="busy" @click="emit('lock')">
        <Icon name="lock-keyhole" />
        <span>قفل</span>
      </button>
    </nav>

    <main class="main">
      <header class="topbar">
        <h1>{{ TITLES[screen] }}</h1>
        <span class="shop hide-sm" data-topbar-shop-name>{{ appearance.shopName }}</span>
        <span v-if="demo" class="status fresh-tag" title="نسخة للتجربة في المتصفح. البيانات وهمية ومش بتتحفظ">
          <Icon name="info" /> نسخة تجربة: بيانات وهمية
        </span>
        <div class="sp" />
        <span
          v-if="appearance.printerEnabled === 'on'"
          class="status hide-sm"
          data-topbar-receipt-status="printer"
          title="الطابعة"
        >
          <span class="dot" />
          <Icon name="printer" /> الطابعة جاهزة
        </span>
        <span
          v-else
          class="status hide-sm"
          data-topbar-receipt-status="wa"
          title="مفيش طابعة. الإيصال بيتبعت للعميل على واتساب"
        >
          <span class="dot" />
          <Icon name="message-circle" /> الإيصال: واتساب
        </span>
        <span class="status num" title="الساعة">{{ clock }}</span>
        <span
          class="status num"
          data-topbar-shift-status
          :data-shift-open="shiftState.openShift ? 'true' : 'false'"
          :title="
            shiftState.openShift
              ? `وردية #${shiftState.openShift.shift.shiftNumber} مفتوحة`
              : 'مفيش وردية مفتوحة'
          "
        >
          <span class="dot" />
          <template v-if="shiftState.openShift">
            وردية #{{ shiftState.openShift.shift.shiftNumber }} مفتوحة
          </template>
          <template v-else>مفيش وردية مفتوحة</template>
        </span>
        <button
          v-if="shiftState.openShift"
          type="button"
          class="btn sm"
          data-open-drawer-expense
          title="تسجيل مصروف من الدرج أو سحب للمالك"
          @click="openDrawerExpenseModal"
        >
          <Icon name="receipt" />
          <span>مصروف / درج</span>
        </button>
        <button
          type="button"
          class="btn sm"
          data-open-shift-modal
          :title="shiftState.openShift ? 'تقفيل الوردية وعدّ الدرج' : 'فتح وردية جديدة'"
          @click="openShiftDialog"
        >
          <Icon name="wallet" />
          <span>{{ shiftState.openShift ? 'تقفيل الوردية' : 'فتح وردية' }}</span>
        </button>
        <div class="user-switch" :class="{ open: menuOpen }">
          <button
            type="button"
            class="user-chip"
            aria-haspopup="true"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            @click="menuOpen ? closeMenu() : (menuOpen = true)"
          >
            <span class="avatar" :style="{ background: avatarColour(session.userId) }">{{
              session.displayName.charAt(0)
            }}</span>
            <span class="who">{{ session.displayName }}<small>{{ roleName(session.role) }}</small></span>
            <Icon name="chevron-down" class="chev" />
          </button>

          <div v-if="menuOpen && swUser === null" class="sw-menu" role="menu" aria-label="تبديل البيّاع">
            <div class="sw-cur">
              <span class="avatar" :style="{ background: avatarColour(session.userId) }">{{
                session.displayName.charAt(0)
              }}</span>
              <span class="t"><b>{{ session.displayName }}</b><small>{{ roleName(session.role) }}، شغّال دلوقتي</small></span>
            </div>
            <template v-if="others.length > 0">
              <div class="sw-h">بدّل لـ</div>
              <button
                v-for="user in others"
                :key="user.id"
                type="button"
                class="sw-item"
                role="menuitem"
                @click="swPick(user)"
              >
                <span class="avatar" :style="{ background: avatarColour(user.id) }">{{ user.displayName.charAt(0) }}</span>
                <span class="t"><b>{{ user.displayName }}</b><small>{{ roleName(user.role) }}{{ user.hasPin ? '' : '، بكلمة السر' }}</small></span>
                <Icon name="chevron-left" />
              </button>
            </template>
            <div class="sw-sep" />
            <button type="button" class="sw-item sm" role="menuitem" @click="menuAction('setPin')">
              <Icon name="key-round" /><span class="t">{{ me?.hasPin ? 'غيّر الـ PIN' : 'اعمل PIN' }}</span>
            </button>
            <button type="button" class="sw-item sm" role="menuitem" @click="menuAction('lock')">
              <Icon name="lock-keyhole" /><span class="t">قفل الشاشة</span><kbd>Ctrl+L</kbd>
            </button>
            <button type="button" class="sw-item sm" role="menuitem" :disabled="busy" @click="menuAction('signOut')">
              <Icon name="log-out" /><span class="t">تسجيل الخروج</span>
            </button>
          </div>

          <div v-else-if="menuOpen && swUser" class="sw-menu pin" role="dialog" aria-label="الـ PIN">
            <div class="sw-pin-h">
              <button type="button" class="icon-btn sm" title="رجوع (Esc)" @click="swUser = null"><Icon name="arrow-right" /></button>
              <span class="avatar" :style="{ background: avatarColour(swUser.id) }">{{ swUser.displayName.charAt(0) }}</span>
              <span class="t"><b>{{ swUser.displayName }}</b><small>اكتب الـ PIN بتاعه</small></span>
            </div>
            <PinPad
              ref="swPad"
              size="sm"
              :error="swError"
              :busy="swBusy"
              :class="{ shake: swError !== '' }"
              @submit="swSubmit"
              @back="swUser = null"
              @input="swError = ''"
            />
            <div v-if="demo && DEMO_PINS[swUser.username]" class="sw-hint">
              للتجربة: {{ swUser.displayName }} <bdi dir="ltr" class="mono">{{ DEMO_PINS[swUser.username] }}</bdi>
            </div>
          </div>
        </div>
      </header>

      <div class="content">
        <PosScreen
          v-if="screen === 'pos'"
          :session="session"
          @go="screen = $event"
          @shift-changed="refreshShiftState"
        />
        <SalesScreen
          v-else-if="screen === 'sales'"
          :session="session"
          @changed="refreshShiftState"
        />
        <WalletsScreen
          v-else-if="screen === 'wallets'"
          :session="session"
          @changed="refreshShiftState"
        />
        <StoreScreen v-else-if="screen === 'store'" />
        <SettingsScreen v-else-if="screen === 'settings'" />
      </div>

      <DrawerExpenseModal
        v-if="drawerModalOpen && shiftState.openShift"
        :open-shift="shiftState.openShift"
        @close="drawerModalOpen = false"
        @updated="onDrawerSummaryUpdated"
      />
      <ShiftModal
        v-if="shiftModalOpen"
        :session="session"
        :shift-state="shiftState"
        @close="shiftModalOpen = false"
        @changed="refreshShiftState"
      />
    </main>
  </div>
</template>
