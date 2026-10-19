<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Session } from '../../api/identity';
import type { ScreenId } from '../../shell/nav';
import Icon from '../../ui/Icon.vue';
import {
  GUIDE_CATEGORIES,
  GUIDE_TOPICS,
  KEYBOARD_SHORTCUTS,
  filterGuideShortcuts,
  filterGuideTopics,
  type GuideCategoryId,
} from './guide';

const props = defineProps<{
  session: Session;
}>();

const emit = defineEmits<{
  goScreen: [screen: ScreenId];
}>();

const isOwner = computed(() => props.session.role === 'manager');
const activeCategory = ref<GuideCategoryId>('all');
const searchQuery = ref('');

const visibleTopics = computed(() =>
  filterGuideTopics(GUIDE_TOPICS, activeCategory.value, searchQuery.value),
);

const visibleShortcuts = computed(() =>
  filterGuideShortcuts(KEYBOARD_SHORTCUTS, searchQuery.value),
);

const showShortcutsCard = computed(
  () =>
    (activeCategory.value === 'all' || activeCategory.value === 'shortcuts') &&
    visibleShortcuts.value.length > 0,
);

function canJumpTo(ownerOnly: boolean): boolean {
  return !ownerOnly || isOwner.value;
}
</script>

<template>
  <div class="page" data-guide-screen>
    <div class="page-h">
      <div>
        <h2>
          دليل السيستم الشامل
          <span class="sub">
            مرجع كامل جوه البرنامج لكل شاشة، اختصار كيبورد، وصلاحية — دوس
            <kbd>F1</kbd> في أي وقت لفتحه
          </span>
        </h2>
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap">
        <label class="inline-search" style="min-width: 310px">
          <Icon name="search" />
          <input
            v-model="searchQuery"
            type="search"
            placeholder="ابحث في الدليل: صيانة، سوفت وير، جرد، IMEI، فلاشة، F10..."
            data-guide-search
          />
        </label>
        <button
          v-if="searchQuery"
          type="button"
          class="btn ghost sm"
          @click="searchQuery = ''"
        >
          مسح البحث
        </button>
        <button
          type="button"
          class="btn primary sm"
          data-guide-back-pos
          @click="emit('goScreen', 'pos')"
        >
          <Icon name="shopping-cart" /> رجوع لشاشة البيع
        </button>
      </div>
    </div>

    <!-- Category filter pills -->
    <div
      class="seg"
      style="display: flex; flex-wrap: wrap; gap: 6px"
      data-guide-categories
    >
      <button
        v-for="cat in GUIDE_CATEGORIES"
        :key="cat.id"
        type="button"
        :class="{ on: activeCategory === cat.id }"
        :data-guide-cat="cat.id"
        @click="activeCategory = cat.id"
      >
        {{ cat.label }}
        <span class="tag sm" style="margin-right: 4px">{{ cat.badge }}</span>
      </button>
    </div>

    <!-- Quick summary banner -->
    <div class="card" style="padding: 14px 16px" data-guide-overview-banner>
      <div
        class="row"
        style="justify-content: space-between; flex-wrap: wrap; gap: 12px"
      >
        <div>
          <b style="font-size: 14px"
            >كل مراحل السيستم (المرحلة 1 لحد المرحلة 4) شغّالة بالكامل</b
          >
          <div class="muted" style="font-size: 12.5px; margin-top: 4px">
            الكمبيوتر هو مصدر الحقيقة الوحيد بقاعدة بيانات محلية سريعة من غير
            إنترنت · الموبايل مساعد لحظي على الـ Wi-Fi أو متابعة مشفّرة للمالك
            من برّه المحل · وفلوس الصيانة مفصولة تماماً عن فلوس السوفت وير.
          </div>
        </div>
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <span class="tag ok">8 شاشات تشغيل</span>
          <span class="tag info">12 اختصار كيبورد</span>
          <span class="tag warn">نسخ احتياطي مشفّر AES-256</span>
        </div>
      </div>
    </div>

    <!-- Keyboard shortcuts reference card -->
    <div
      v-if="showShortcutsCard"
      class="card"
      style="padding: 16px"
      data-guide-shortcuts-card
    >
      <div
        class="row"
        style="justify-content: space-between; margin-bottom: 12px"
      >
        <div>
          <h3 style="margin: 0; font-size: 15px">
            اختصارات الكيبورد السريعة (عشان تشتغل من غير ماوس)
          </h3>
          <small class="muted"
            >كل اختصار مكتوب جمبه بيعمل إيه وفي أنهي شاشة</small
          >
        </div>
        <span class="tag info">F1 – F12</span>
      </div>
      <div
        style="
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
          gap: 10px;
        "
      >
        <div
          v-for="sc in visibleShortcuts"
          :key="sc.key"
          class="row"
          style="
            justify-content: space-between;
            padding: 9px 12px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--surface-2);
          "
          :data-guide-shortcut="sc.key"
        >
          <div>
            <div style="font-weight: 700; font-size: 13px">{{ sc.action }}</div>
            <small class="muted">{{ sc.where }}</small>
          </div>
          <kbd
            class="mono"
            dir="ltr"
            style="font-size: 12.5px; padding: 3px 8px"
            >{{ sc.key }}</kbd
          >
        </div>
      </div>
    </div>

    <!-- Guide Topic Cards -->
    <div
      v-if="visibleTopics.length > 0"
      style="
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
        gap: 14px;
      "
      data-guide-topics-grid
    >
      <div
        v-for="topic in visibleTopics"
        :key="topic.id"
        class="card"
        style="
          padding: 16px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          gap: 12px;
        "
        :data-guide-topic="topic.id"
      >
        <div>
          <div
            class="row"
            style="
              justify-content: space-between;
              align-items: flex-start;
              gap: 8px;
              margin-bottom: 6px;
            "
          >
            <h3 style="margin: 0; font-size: 15px; line-height: 1.4">
              {{ topic.title }}
            </h3>
            <span
              class="tag sm"
              :class="topic.ownerOnly ? 'warn' : 'ok'"
              style="flex-shrink: 0"
            >
              {{ topic.ownerOnly ? 'للمالك فقط' : 'للمالك والبيّاع' }}
            </span>
          </div>
          <p class="muted" style="margin: 0 0 10px; font-size: 12.5px">
            {{ topic.summary }}
          </p>
          <ul
            style="
              margin: 0;
              padding-right: 18px;
              display: flex;
              flex-direction: column;
              gap: 6px;
              font-size: 13px;
              line-height: 1.55;
            "
          >
            <li v-for="(bullet, idx) in topic.bullets" :key="idx">
              {{ bullet }}
            </li>
          </ul>
        </div>

        <div
          v-if="topic.targetScreen"
          class="row"
          style="
            justify-content: flex-end;
            padding-top: 8px;
            border-top: 1px solid var(--line);
          "
        >
          <button
            v-if="canJumpTo(topic.ownerOnly)"
            type="button"
            class="btn sm"
            :data-guide-jump="topic.targetScreen"
            @click="emit('goScreen', topic.targetScreen)"
          >
            <Icon name="arrow-left" />
            {{ topic.targetLabel || 'افتح الشاشة دي' }}
          </button>
          <span v-else class="muted" style="font-size: 12px">
            الشاشة دي بتفتح بحساب المالك بس
          </span>
        </div>
      </div>
    </div>

    <div
      v-else-if="!showShortcutsCard"
      class="card"
      style="padding: 28px; text-align: center"
    >
      <b>مفيش نتائج مطابقة لـ «{{ searchQuery }}»</b>
      <div class="muted" style="margin-top: 6px">
        جرّب تكتب كلمة تانية زي: صيانة، سوفت، جرد، IMEI، محفظة، مرتجع، أو دوس
        «مسح البحث».
      </div>
    </div>
  </div>
</template>
