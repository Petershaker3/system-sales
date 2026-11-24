<script setup lang="ts">
// Customer picker, creation, and آجل debt repayment modal
// (`docs/ui/mockup-v1/pos.js`, `ADR-020` §3).
import { computed, ref } from 'vue';

import {
  createCustomer,
  type Customer,
  recordCustomerPayment,
} from '../../api/customer';
import { describeError } from '../../api/errors';
import WalletNumberChips from './WalletNumberChips.vue';
import { money, moneyInputValue, moneyUnitWord, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

const props = defineProps<{
  customers: readonly Customer[];
  selectedCustomerId: string | null;
}>();

const emit = defineEmits<{
  close: [];
  pick: [customer: Customer | null];
  updated: [customer: Customer];
}>();

const searchQuery = ref('');
const addingNew = ref(false);
const newName = ref('');
const newContact = ref('');
const busy = ref(false);
const error = ref('');

const repayTarget = ref<Customer | null>(null);
const repayAmountText = ref('');
const repayMethod = ref<'cash' | 'vf' | 'instapay' | 'card'>('cash');
/** The shop wallet number the customer transferred into (`ADR-041`). */
const repayWalletId = ref<string | null>(null);
const repayNote = ref('');

const filteredCustomers = computed<Customer[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return [...props.customers];
  return props.customers.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      (c.contact ?? '').toLowerCase().includes(q)
  );
});

async function submitNewCustomer(): Promise<void> {
  if (busy.value) return;
  const name = newName.value.trim();
  if (!name) {
    error.value = 'اكتب اسم العميل';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const created = await createCustomer(
      name,
      newContact.value.trim() === '' ? null : newContact.value.trim()
    );
    toast(`اتسجّل العميل: ${created.name}`, 'ok');
    emit('updated', created);
    emit('pick', created);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function openRepay(customer: Customer): void {
  repayTarget.value = customer;
  repayAmountText.value = moneyInputValue(customer.balanceMinor);
  repayMethod.value = 'cash';
  repayWalletId.value = null;
  repayNote.value = '';
  error.value = '';
}

async function submitRepay(): Promise<void> {
  const target = repayTarget.value;
  if (!target || busy.value) return;
  const minor = parseMoney(repayAmountText.value);
  if (minor === null || minor <= 0) {
    error.value = 'اكتب مبلغ السداد بالجنيه أكبر من صفر';
    return;
  }
  if (minor > target.balanceMinor) {
    error.value = `المبلغ أكبر من الرصيد الآجل اللي على العميل (${money(target.balanceMinor)})`;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const updated = await recordCustomerPayment(
      target.id,
      minor,
      repayMethod.value,
      repayNote.value.trim() === '' ? null : repayNote.value.trim(),
      repayWalletId.value
    );
    toast(
      `اتسجّل سداد ${money(minor)} من «${updated.name}» — المتبقي عليه ${money(updated.balanceMinor)}`,
      'ok'
    );
    repayTarget.value = null;
    emit('updated', updated);
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    :title="repayTarget ? `تحصيل آجل — ${repayTarget.name}` : 'عميل الفاتورة'"
    :sub="
      repayTarget
        ? `رصيده الآجل الحالي: ${money(repayTarget.balanceMinor)}`
        : 'اختار عميل متسجّل أو ضيف عميل جديد (مطلوب للبيع الآجل)'
    "
    size="md"
    :closable="!busy"
    @close="emit('close')"
  >
    <div v-if="repayTarget" class="stack">
      <div class="due-box">
        <div class="r">
          <span>الرصيد الآجل على العميل</span>
          <b class="num">{{ money(repayTarget.balanceMinor) }}</b>
        </div>
      </div>
      <div class="field">
        <label for="repay-amount-in">المبلغ المدفوع ({{ moneyUnitWord() }})</label>
        <input
          id="repay-amount-in"
          v-model="repayAmountText"
          class="big-in num"
          inputmode="decimal"
          autocomplete="off"
          data-autofocus
        />
      </div>
      <div class="field">
        <span class="label">طريقة التحصيل</span>
        <div class="chips">
          <button
            v-for="[id, label] in [
              ['cash', 'كاش'],
              ['vf', 'فودافون كاش'],
              ['instapay', 'إنستاباي'],
              ['card', 'فيزا / ميزة'],
            ] as const"
            :key="id"
            type="button"
            class="chip"
            :class="{ on: repayMethod === id }"
            @click="repayMethod = id"
          >
            {{ label }}
          </button>
        </div>
        <WalletNumberChips :method="repayMethod" v-model="repayWalletId" />
      </div>
      <div class="field">
        <label for="repay-note-in">ملاحظة (اختياري)</label>
        <input
          id="repay-note-in"
          v-model="repayNote"
          autocomplete="off"
          maxlength="200"
          placeholder="مثال: دفعة تحت الحساب"
        />
      </div>
      <div class="err-msg" role="alert">{{ error }}</div>
    </div>

    <div v-else class="stack">
      <div class="row" style="gap: 8px">
        <label class="inline-search" style="flex: 1">
          <Icon name="search" />
          <input
            id="cust-search-in"
            v-model="searchQuery"
            placeholder="ابحث بالاسم أو رقم الموبايل…"
            autocomplete="off"
            data-autofocus
          />
        </label>
        <button
          id="toggle-new-customer-btn"
          type="button"
          class="btn"
          :class="{ primary: !addingNew }"
          @click="addingNew = !addingNew"
        >
          <Icon name="user-plus" /> {{ addingNew ? 'إخفاء الإضافة' : 'عميل جديد' }}
        </button>
      </div>

      <form
        v-if="addingNew"
        class="card stack"
        style="padding: 12px; background: var(--surface-2)"
        @submit.prevent="submitNewCustomer"
      >
        <div class="grid2">
          <div class="field">
            <label for="new-cust-name-in">اسم العميل</label>
            <input
              id="new-cust-name-in"
              v-model="newName"
              autocomplete="off"
              maxlength="120"
              placeholder="مثال: محمود عبد الرحمن"
            />
          </div>
          <div class="field">
            <label for="new-cust-contact-in">رقم الموبايل (اختياري)</label>
            <input
              id="new-cust-contact-in"
              v-model="newContact"
              :class="{ mono: newContact !== '' }"
              :dir="newContact ? 'ltr' : 'rtl'"
              inputmode="tel"
              autocomplete="off"
              maxlength="64"
              placeholder="01xxxxxxxxx"
            />
          </div>
        </div>
        <div class="row" style="justify-content: flex-end; gap: 8px">
          <button
            id="save-new-customer-btn"
            type="submit"
            class="btn primary sm"
            :disabled="busy"
          >
            <Icon name="check" /> حفظ واختيار للفاتورة
          </button>
        </div>
      </form>

      <div class="cust-list">
        <div v-if="filteredCustomers.length === 0" class="no-res">
          مفيش عميل مطابق — دوس «عميل جديد» عشان تضيفه على طول
        </div>
        <div
          v-for="c in filteredCustomers"
          :key="c.id"
          class="result"
          :class="{ on: c.id === selectedCustomerId }"
          :data-customer-id="c.id"
          @click="emit('pick', c)"
        >
          <div class="ico"><Icon name="user" /></div>
          <div class="t">
            <div class="n"><bdi dir="rtl">{{ c.name }}</bdi></div>
            <div class="s">
              <span v-if="c.contact" class="mono" dir="ltr">{{ c.contact }}</span>
              <span v-else>بدون رقم موبايل</span>
            </div>
          </div>
          <span v-if="c.balanceMinor > 0" class="tag warn num">
            عليه {{ money(c.balanceMinor) }} آجل
          </span>
          <span v-else class="tag ok">خالص</span>
          <button
            v-if="c.balanceMinor > 0"
            type="button"
            class="btn sm"
            title="تحصيل دفعة من الرصيد الآجل"
            @click.stop="openRepay(c)"
          >
            <Icon name="hand-coins" /> تحصيل
          </button>
        </div>
      </div>

      <div v-if="error" class="err-msg" role="alert">{{ error }}</div>
    </div>

    <template #foot>
      <template v-if="repayTarget">
        <button
          id="confirm-repay-btn"
          type="button"
          class="btn primary"
          :disabled="busy"
          @click="submitRepay"
        >
          <Icon name="check" /> تسجيل السداد ({{ money(parseMoney(repayAmountText) ?? 0) }})
        </button>
        <button
          type="button"
          class="btn ghost"
          :disabled="busy"
          @click="repayTarget = null"
        >
          رجوع للقائمة
        </button>
      </template>
      <template v-else>
        <button
          v-if="selectedCustomerId !== null"
          id="clear-customer-btn"
          type="button"
          class="btn ghost danger"
          @click="emit('pick', null)"
        >
          <Icon name="x" /> شيل العميل من الفاتورة
        </button>
        <span class="sp" />
        <button type="button" class="btn ghost" @click="emit('close')">إغلاق</button>
      </template>
    </template>
  </Modal>
</template>
