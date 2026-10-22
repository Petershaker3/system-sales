<script setup lang="ts">
// The frame every signed-in screen sits in (docs/ui/mockup-v1/app.js: rail,
// top bar, user menu). Positions and steps follow the approved mockup; only
// screens that exist in this build appear on the rail.
//
// The user chip switches who is working (ADR-017 §2, `docs/PLAN.md` §4): pick
// someone, and the menu becomes their PIN pad; their PIN signs them in and the
// open invoices stay where they are. «قفل» on the rail and Ctrl+L lock the
// screen (App.vue owns the lock).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import * as api from '../api/identity';
import type { Session, UserSummary } from '../api/identity';
import {
  currentShiftSummary,
  type CurrentShiftState,
  type ShiftSummary,
} from '../api/shift';
import { runPeriodicBackupTick } from '../api/backup';
import { describeError } from '../api/errors';
import { appearance, loadShopLogo, shopLogo } from '../ui/appearance';
import { fmtTime } from '../ui/format';
import Icon from '../ui/Icon.vue';
import PinPad from '../ui/PinPad.vue';
import { toast } from '../ui/toast';
import PosScreen from '../screens/pos/PosScreen.vue';
import SalesScreen from '../screens/sales/SalesScreen.vue';
import WalletsScreen from '../screens/wallets/WalletsScreen.vue';
import RepairsScreen from '../screens/repairs/RepairsScreen.vue';
import StoreScreen from '../screens/store/StoreScreen.vue';
import PhonesScreen from '../screens/phones/PhonesScreen.vue';
import ReportsScreen from '../screens/reports/ReportsScreen.vue';
import ExpensesScreen from '../screens/expenses/ExpensesScreen.vue';
import MobileCompanionScreen from '../screens/mobile/MobileCompanionScreen.vue';
import PhoneCaptureScreen from '../screens/mobile/PhoneCaptureScreen.vue';
import SettingsScreen from '../screens/settings/SettingsScreen.vue';
import GuideScreen from '../screens/guide/GuideScreen.vue';
import DrawerExpenseModal from './DrawerExpenseModal.vue';
import { openModeHint, openMode } from './open-mode';
import ShiftModal from './ShiftModal.vue';
import { isPhone } from './device';
import {
  avatarColour,
  navSectionsFor,
  orderSections,
  parseNavOrder,
  roleName,
  settingsNavItem,
  TITLES,
} from './nav';
import type { ScreenId } from './nav';

const props = defineProps<{ session: Session; busy: boolean; users: readonly UserSummary[] }>();

/**
 * The shop is running without an account (`ADR-039`).
 *
 * Presentation only, and it removes affordances rather than adding powers: there is
 * nothing to lock, nobody to switch to, and no password to sign out and back in
 * with. What an open shop may *do* is decided in Rust, not here.
 */
const open = computed(() => openMode.value.active);
const openHint = computed(() => openModeHint());
const settingsScreen = ref<InstanceType<typeof SettingsScreen> | null>(null);

/** الإعدادات ← المستخدمين والصلاحيات, where the owner account is made. */
async function openOwnerAccountForm(): Promise<void> {
  screen.value = 'settings';
  await nextTick();
  settingsScreen.value?.openTab('users');
}
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

const initialScreen = (): ScreenId => {
  if (typeof window !== 'undefined') {
    const requested = (
      window as unknown as { __MSHOP_INITIAL_SCREEN__?: ScreenId }
    ).__MSHOP_INITIAL_SCREEN__;
    if (requested) return requested;
  }
  // The till is the first screen on every device, and on a phone that is a decision
  // and not a default: this build used to open a handset on «الموبايل» — the desktop
  // screen that previews the four helper screens inside phone frames (`ADR-037`) — so
  // the owner's phone showed them a shrunken desktop page *about* their phone instead
  // of the shop. The preview belongs on the computer that serves it.
  return 'pos';
};
const screen = ref<ScreenId>(initialScreen());
const salesFocusTarget = ref<
  { readonly kind: 'day'; readonly iso: string } | { readonly kind: 'month'; readonly key: string } | null
>(null);

function openSalesDayFromReports(iso: string): void {
  salesFocusTarget.value = { kind: 'day', iso };
  screen.value = 'sales';
}

function openSalesMonthFromReports(key: string): void {
  salesFocusTarget.value = { kind: 'month', key };
  screen.value = 'sales';
}
/**
 * The rail: the shop's own screens in the order the owner arranged
 * (الإعدادات ← الشريط الجانبي). «الإعدادات» is not one of them — it is the single
 * door to the shop's setup, and it sits alone at the bottom so it cannot be
 * mistaken for a section or reached by muscle memory meant for one.
 */
const items = computed(() =>
  orderSections(
    navSectionsFor(props.session.role, isPhone()),
    parseNavOrder(appearance.navOrder),
  ),
);
const settingsItem = settingsNavItem();
/**
 * A screen inside the shell (a settings card) can send the operator to the guide.
 *
 * A custom event rather than a prop: «الإعدادات» is mounted deep inside the shell,
 * and threading a callback through every screen it is not part of would be a wire
 * that exists for one button.
 */
function onOpenGuideRequest(): void {
  screen.value = 'guide';
}

/**
 * A screen asks for one settings tab (the phones screen's setup cards, which would
 * otherwise have to duplicate the settings UI to change one number).
 */
async function onOpenSettingsRequest(event: Event): Promise<void> {
  const detail = (event as CustomEvent<{ tab?: string }>).detail;
  screen.value = 'settings';
  await nextTick();
  const tab = detail?.tab;
  if (tab === 'shop' || tab === 'look' || tab === 'rail' || tab === 'catalog' || tab === 'users' || tab === 'pay' || tab === 'receipt' || tab === 'backup' || tab === 'devices') {
    settingsScreen.value?.openTab(tab);
  }
}

// A seller never lands on an owner screen, even after a switch or a role change.
watch(
  () => props.session.role,
  () => {
    if (screen.value !== 'guide' && !items.value.some((item) => item.id === screen.value)) screen.value = 'pos';
  }
);

watch(screen, () => {
  const el = document.querySelector('.content');
  if (el) el.scrollTop = 0;
});

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
  if (swUser.value === null) {
    if (event.key === 'F1') {
      event.preventDefault();
      screen.value = 'guide';
    }
    return;
  }
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
  window.addEventListener('mshop:open-guide', onOpenGuideRequest);
  window.addEventListener('mshop:open-settings', onOpenSettingsRequest);
});
onBeforeUnmount(() => {
  window.clearInterval(tick);
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('keydown', onSwitchKey, true);
  window.removeEventListener('mshop:open-guide', onOpenGuideRequest);
  window.removeEventListener('mshop:open-settings', onOpenSettingsRequest);
});

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
      <!-- The foot of the rail: the app's own doors, apart from the shop's sections.
           The guide and light/dark live in الإعدادات ← الشريط الجانبي now: they are
           settings, not places in the shop, and a rail that mixed the two made
           «الإعدادات» look like one more page among nine. -->
      <div class="rail-foot" data-rail-foot>
        <button
          v-if="settingsItem && props.session.role === 'manager'"
          type="button"
          class="nav-btn nav-icon"
          :class="{ active: screen === 'settings' }"
          title="الإعدادات"
          aria-label="الإعدادات"
          data-rail-settings
          @click="screen = 'settings'"
        >
          <Icon name="settings" />
        </button>
        <!-- No lock while the shop runs without an account (`ADR-039`): the lock ends
             a session, and this shop has no session row to end. -->
        <button
          v-if="!open"
          type="button"
          class="nav-btn nav-icon"
          title="قفل الشاشة (Ctrl+L)"
          aria-label="قفل الشاشة"
          data-rail-lock
          :disabled="busy"
          @click="emit('lock')"
        >
          <Icon name="lock-keyhole" />
        </button>
      </div>
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
          type="button"
          class="btn sm ghost"
          data-open-system-guide
          title="دليل السيستم الشامل (F1)"
          @click="screen = 'guide'"
        >
          <Icon name="info" />
          <span>دليل السيستم</span>
        </button>
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
            <span class="who">{{ session.displayName
              }}<small>{{ open ? 'من غير حساب' : roleName(session.role) }}</small></span>
            <Icon name="chevron-down" class="chev" />
          </button>

          <div v-if="menuOpen && swUser === null" class="sw-menu" role="menu" aria-label="تبديل البيّاع">
            <div class="sw-cur">
              <span class="avatar" :style="{ background: avatarColour(session.userId) }">{{
                session.displayName.charAt(0)
              }}</span>
              <span class="t"><b>{{ session.displayName }}</b><small>{{ open ? 'المحل شغال من غير حساب' : roleName(session.role) + '، شغّال دلوقتي' }}</small></span>
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
            <!-- While the shop is open the daily secret has nothing to protect
                 (`ADR-039`): no lock, no sign-out, no PIN — and no second account to
                 switch to either. The chip stays, because it is who the audit names. -->
            <template v-if="!open">
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
            </template>
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

      <!-- The shop is open: one line, one button, and the till carries on. -->
      <div v-if="open" class="open-note" data-open-mode-note>
        <Icon name="info" />
        <span class="t">{{ openHint }}</span>
        <button type="button" class="btn sm primary" data-open-account-btn @click="openOwnerAccountForm">
          اعمل حساب المالك
        </button>
      </div>

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
          :focus-target="salesFocusTarget"
          @changed="refreshShiftState"
        />
        <WalletsScreen
          v-else-if="screen === 'wallets'"
          :session="session"
          @changed="refreshShiftState"
        />
        <RepairsScreen
          v-else-if="screen === 'repairs'"
          :session="session"
          @changed="refreshShiftState"
        />
        <StoreScreen v-else-if="screen === 'store'" :session="session" />
        <PhonesScreen v-else-if="screen === 'phones'" />
        <ReportsScreen
          v-else-if="screen === 'reports'"
          :session="session"
          @open-sales-day="openSalesDayFromReports"
          @open-sales-month="openSalesMonthFromReports"
          @go-screen="screen = $event"
        />
        <ExpensesScreen
          v-else-if="screen === 'expenses'"
          :session="session"
          @changed="refreshShiftState"
        />
        <MobileCompanionScreen
          v-else-if="screen === 'mobile'"
          :session="session"
          @go-screen="screen = $event"
          @changed="refreshShiftState"
        />
        <PhoneCaptureScreen
          v-else-if="screen === 'capture'"
          :session="session"
        />
        <SettingsScreen v-else-if="screen === 'settings'" ref="settingsScreen" />
        <GuideScreen
          v-else-if="screen === 'guide'"
          :session="session"
          @go-screen="screen = $event"
        />
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
