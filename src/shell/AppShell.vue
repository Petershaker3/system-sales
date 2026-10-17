<script setup lang="ts">
// The frame every signed-in screen sits in (docs/ui/mockup-v1/app.js: rail,
// top bar, user menu). Positions and steps follow the approved mockup; only
// screens that exist in this build appear on the rail.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import type { Session } from '../api/identity';
import { describeError } from '../api/errors';
import { resolvedTheme, appearance, toggleTheme } from '../ui/appearance';
import { fmtTime } from '../ui/format';
import Icon from '../ui/Icon.vue';
import { toast } from '../ui/toast';
import PosScreen from '../screens/pos/PosScreen.vue';
import SalesScreen from '../screens/sales/SalesScreen.vue';
import StoreScreen from '../screens/store/StoreScreen.vue';
import SettingsScreen from '../screens/settings/SettingsScreen.vue';
import { avatarColour, navFor, roleName, TITLES } from './nav';
import type { ScreenId } from './nav';

const props = defineProps<{ session: Session; busy: boolean }>();
const emit = defineEmits<{ signOut: [] }>();

const demo = import.meta.env.VITE_DEMO === '1';
const screen = ref<ScreenId>('pos');
const items = computed(() => navFor(props.session.role));
const dark = computed(() => {
  void appearance.theme;
  return resolvedTheme() === 'dark';
});

// A seller never lands on an owner screen, even after a role change.
watch(
  () => props.session.role,
  () => {
    if (!items.value.some((item) => item.id === screen.value)) screen.value = 'pos';
  }
);

const menuOpen = ref(false);
const clock = ref(fmtTime());
let tick = 0;

function onDocClick(event: MouseEvent): void {
  if (!(event.target instanceof Element) || !event.target.closest('.user-switch')) menuOpen.value = false;
}

onMounted(() => {
  tick = window.setInterval(() => (clock.value = fmtTime()), 15_000);
  document.addEventListener('mousedown', onDocClick);
});
onBeforeUnmount(() => {
  window.clearInterval(tick);
  document.removeEventListener('mousedown', onDocClick);
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
      <div class="logo" aria-hidden="true">م</div>
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
      <button type="button" class="nav-btn" title="تسجيل الخروج" :disabled="busy" @click="emit('signOut')">
        <Icon name="log-out" />
        <span>خروج</span>
      </button>
    </nav>

    <main class="main">
      <header class="topbar">
        <h1>{{ TITLES[screen] }}</h1>
        <span v-if="demo" class="status fresh-tag" title="نسخة للتجربة في المتصفح. البيانات وهمية ومش بتتحفظ">
          <Icon name="info" /> نسخة تجربة: بيانات وهمية
        </span>
        <div class="sp" />
        <span class="status num" title="الساعة">{{ clock }}</span>
        <div class="user-switch" :class="{ open: menuOpen }">
          <button
            type="button"
            class="user-chip"
            aria-haspopup="true"
            :aria-expanded="menuOpen ? 'true' : 'false'"
            @click="menuOpen = !menuOpen"
          >
            <span class="avatar" :style="{ background: avatarColour(session.userId) }">{{
              session.displayName.charAt(0)
            }}</span>
            <span class="who">{{ session.displayName }}<small>{{ roleName(session.role) }}</small></span>
            <Icon name="chevron-down" class="chev" />
          </button>
          <div v-if="menuOpen" class="sw-menu" role="menu">
            <div class="sw-cur">
              <span class="avatar" :style="{ background: avatarColour(session.userId) }">{{
                session.displayName.charAt(0)
              }}</span>
              <span class="t"><b>{{ session.displayName }}</b><small>{{ roleName(session.role) }}، شغّال دلوقتي</small></span>
            </div>
            <button type="button" class="sw-item sm" role="menuitem" :disabled="busy" @click="emit('signOut')">
              <Icon name="log-out" /><span class="t">تسجيل الخروج</span>
            </button>
          </div>
        </div>
      </header>

      <div class="content">
        <PosScreen v-if="screen === 'pos'" :session="session" @go="screen = $event" />
        <SalesScreen v-else-if="screen === 'sales'" />
        <StoreScreen v-else-if="screen === 'store'" />
        <SettingsScreen v-else-if="screen === 'settings'" />
      </div>
    </main>
  </div>
</template>
