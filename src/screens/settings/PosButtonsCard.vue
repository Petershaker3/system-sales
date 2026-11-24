<script setup lang="ts">
// «زراير شاشة البيع» — which of the till's quick actions are shown beside the
// search box (owner, 2026-11-05; `ui.pos_hidden_buttons`).
//
// The row is three buttons — camera, «إضافة صيانة / سوفت وير», «فحص IMEI» — that
// a shop may want shorter: a counter with a barcode printer and no camera, or a
// shop that never opens a maintenance ticket, should be able to take the button
// away instead of living with it. What is stored is what to **hide**, so a button
// a later build adds appears on its own.
//
// «خدمات» and «مرتجع / استبدال» are not here: they are doors of the invoice
// itself, and hiding them would hide part of the sale.

import { computed } from 'vue';

import { describeError } from '../../api/errors';
import { appearance, setAppearance } from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import {
  hiddenButtonsSummary,
  isQuickActionShown,
  POS_QUICK_ACTIONS,
  toggleQuickAction,
} from '../pos/quick-actions';

const hidden = computed(() => appearance.posHiddenButtons);
const summary = computed(() => hiddenButtonsSummary(hidden.value));

async function toggle(id: (typeof POS_QUICK_ACTIONS)[number]['id']): Promise<void> {
  const next = toggleQuickAction(hidden.value, id);
  const action = POS_QUICK_ACTIONS.find((candidate) => candidate.id === id);
  const willHide = !isQuickActionShown(next, id);
  try {
    await setAppearance({ posHiddenButtons: next });
    toast(
      willHide
        ? `اتخفت «${action?.label ?? id}» من شاشة البيع — بترجعها من هنا في أي وقت`
        : `رجعت «${action?.label ?? id}» لشاشة البيع`,
      'info',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-pos-buttons-card>
    <h3>زراير شاشة البيع</h3>
    <p class="muted" style="margin: 0 0 12px">
      الزراير اللي جنب خانة البحث في البيع. اخفي اللي مش بتستخدمه، والباقي بيفضل مكانه —
      «خدمات» و«مرتجع / استبدال» مالهمش علاقة، دول أبواب الفاتورة نفسها.
    </p>

    <div
      v-for="action in POS_QUICK_ACTIONS"
      :key="action.id"
      class="s-row"
      :data-pos-button-row="action.id"
    >
      <div class="t">
        <b><Icon :name="action.icon" /> {{ action.label }}</b>
        <small>{{ action.hint }}</small>
      </div>
      <div class="seg" role="group" :aria-label="action.label">
        <button
          type="button"
          :data-pos-button-show="action.id"
          :class="{ active: isQuickActionShown(hidden, action.id) }"
          :aria-pressed="isQuickActionShown(hidden, action.id)"
          @click="!isQuickActionShown(hidden, action.id) && toggle(action.id)"
        >
          ظاهر
        </button>
        <button
          type="button"
          :data-pos-button-hide="action.id"
          :class="{ active: !isQuickActionShown(hidden, action.id) }"
          :aria-pressed="!isQuickActionShown(hidden, action.id)"
          @click="isQuickActionShown(hidden, action.id) && toggle(action.id)"
        >
          مخفي
        </button>
      </div>
    </div>

    <div class="note" style="margin-top: 12px">
      <Icon name="info" />
      <span data-pos-buttons-summary>{{ summary }}</span>
    </div>
  </section>
</template>
