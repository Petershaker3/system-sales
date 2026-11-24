<script setup lang="ts">
// Customer file panel (P4, `spec:178-179`).
//
// Manager-only screen: listing and archiving require `ManageCustomers`, and
// the backend refuses a sales caller regardless of what the DOM offers
// (`spec:210`). Creation rides on the same API for both roles, so this panel
// is hidden from sales purely as presentation — the invoice-time entry for
// sales lives with the sale itself (P5), not here.
//
// No merge affordance on purpose: similar names are separate records and the
// UI never offers "use the existing one" by name.

import { onMounted, ref } from 'vue';

import * as api from '../api/customer';
import { describeError } from '../api/errors';
import type { Customer } from '../api/customer';

const customers = ref<Customer[]>([]);
const busy = ref(false);
const error = ref('');

const formName = ref('');
const formContact = ref('');

async function load(): Promise<void> {
  busy.value = true;
  try {
    customers.value = await api.listCustomers();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function submitCreate(): Promise<void> {
  busy.value = true;
  try {
    await api.createCustomer(
      formName.value,
      formContact.value.trim() === '' ? null : formContact.value,
    );
    formName.value = '';
    formContact.value = '';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function archive(id: string): Promise<void> {
  busy.value = true;
  try {
    await api.archiveCustomer(id);
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="panel">
    <h3 class="panel-title">ملف العملاء</h3>
    <p class="hint">
      اسم وجهة تواصل واحدة اختيارية لكل عميل. الأسماء المتشابهة سجلات منفصلة
      ولا تُدمج أبدًا.
    </p>

    <form @submit.prevent="submitCreate">
      <label class="field">
        <span>اسم العميل</span>
        <input v-model="formName" autocomplete="off" required maxlength="120" />
      </label>
      <label class="field">
        <span>جهة التواصل (اختياري)</span>
        <input v-model="formContact" autocomplete="off" maxlength="64" />
      </label>
      <button type="submit" :disabled="busy">إضافة عميل</button>
    </form>

    <ul>
      <li v-for="customer in customers" :key="customer.id">
        {{ customer.name }}
        <span v-if="customer.contact">— {{ customer.contact }}</span>
        <button type="button" :disabled="busy" @click="archive(customer.id)">
          أرشفة
        </button>
      </li>
    </ul>
    <p v-if="customers.length === 0" class="hint">لا يوجد عملاء بعد.</p>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>
