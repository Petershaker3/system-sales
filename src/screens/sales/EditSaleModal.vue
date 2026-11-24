<script setup lang="ts">
// «تعديل الفاتورة» بعد تأكيدها (طلب صاحب المحل، 2026-11-09).
//
// # ليه مش تعديل في المكان
//
// الفاتورة مستند: سطرها سعر لحظة البيع، وتكلفته، وحركة مخزون، ودفعة. الجهاز
// بيحافظ على ده كله بمنع الكتابة فوقه — وده اللي بيخلي تقارير الشهر والشهر اللي
// فات قابلة للتصديق. فالتعديل هنا **تصحيح موثّق**: بندخل مرتجع للكميات اللي
// على الفاتورة، وبنسجّل فاتورة مصححة بالسطور والأسعار الجديدة، الاتنين في ترانزاكشن
// واحدة (`record_sale_exchange`). الفاتورة القديمة تفضل في السجل بمرتجعها،
// والجديدة هي اللي العميل بيمشي بيها — والفرق في الدرج هو فرق الإجمالي بالظبط.
//
// # إيه اللي بيتعدل
//
// الكمية، سعر السطر، شيل سطر، إضافة صنف من الكتالوج، الخصم، الزيادة، وطريقة
// الدفع. الأصناف اللي بـIMEI كميتها واحدة دايمًا ورقمها بيفضل معاها.
import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import type { PosProduct } from '../../api/pos';
import {
  inspectSaleForReturn,
  recordSaleExchange,
  type ReturnableSaleInspection,
  type SaleHistoryEntry,
  type SaleLine,
} from '../../api/sales';
import { appearance, type PayMethodId } from '../../ui/appearance';
import { enabledPayMethods, PAY_METHODS } from '../pos/payments';
import { money, moneyInputValue, moneyUnitWord, num, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { withOwnerApproval } from '../../shell/approval';
import { toast } from '../../ui/toast';

const props = defineProps<{
  sale: SaleHistoryEntry;
  products: readonly PosProduct[];
}>();

const emit = defineEmits<{
  close: [];
  saved: [];
}>();

interface EditRow {
  key: number;
  productId: string;
  name: string;
  quantity: number;
  unitPriceText: string;
  imei: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
  /** A serialised unit keeps quantity 1 and its own IMEI. */
  serial: boolean;
  /** How many of this line the shop may still correct (sold − already returned). */
  maxQty: number;
}

let keySeq = 1;

const rows = ref<EditRow[]>([]);
const discountText = ref('');
const surchargeText = ref(
  (props.sale.surchargeMinor ?? 0) > 0 ? moneyInputValue(props.sale.surchargeMinor ?? 0) : ''
);
const reasonText = ref('تعديل فاتورة');
const method = ref<PayMethodId>('cash');
const addQuery = ref('');
const error = ref('');
const busy = ref(false);
const loading = ref(true);
const loaded = ref<ReturnableSaleInspection | null>(null);
/** The seeded values, so «حفظ» with nothing changed cannot write a second invoice. */
const baseline = ref({ discount: 0, surcharge: 0, fingerprint: '' });

/**
 * The ways the corrected invoice may be paid: whatever the shop enabled, plus
 * whatever the old invoice actually used — a «على الحساب» invoice that is edited
 * must stay on the account, or the edit would claim the customer paid cash.
 */
const methodChoices = computed<readonly { id: PayMethodId; name: string }[]>(() => {
  const original = props.sale.payments[0]?.method as PayMethodId | undefined;
  // «تقسيط» needs the provider's reference, and this window does not ask for it:
  // it is offered only when the old invoice already carried one (the reference is
  // carried over). Everything else the shop enabled is a plain method.
  const choices = enabledPayMethods(appearance.payMethods)
    .filter((meta) => meta.id !== 'install')
    .map((meta) => ({ id: meta.id, name: meta.name }));
  if (original && !choices.some((choice) => choice.id === original)) {
    const meta = PAY_METHODS.find((candidate) => candidate.id === original);
    if (meta) choices.push({ id: meta.id, name: meta.name });
  }
  return choices;
});

const isSplitPaid = computed(() => props.sale.payments.length > 1);

const addResults = computed(() => {
  const q = addQuery.value.trim().toLowerCase();
  if (q === '') return [];
  return props.products
    .filter((p) => p.disposition === 'quantity' && p.salePriceMinor !== null)
    .filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q)
    )
    .slice(0, 8);
});

onMounted(async () => {
  try {
    const inspection = await inspectSaleForReturn(props.sale.saleId);
    loaded.value = inspection;
    rows.value = inspection.lines
      .filter((line) => line.remainingQty > 0)
      .map((line) => ({
        key: keySeq++,
        productId: line.productId,
        name: line.productName,
        quantity: line.remainingQty,
        unitPriceText: moneyInputValue(line.unitSellingPriceMinor),
        imei: line.imei,
        warrantyStart: line.warrantyStart,
        warrantyEnd: line.warrantyEnd,
        serial: line.imei !== null,
        maxQty: line.remainingQty,
      }));

    // The old invoice's discount is seeded so the corrected total starts equal
    // to what the customer still owes — the edit shows the change, not a jump.
    const gross = rows.value.reduce(
      (sum, row) => sum + (parseMoney(row.unitPriceText) ?? 0) * row.quantity,
      0
    );
    const stillOwed = Math.max(
      0,
      props.sale.totalMinor -
        props.sale.alreadyRefundedMinor -
        (props.sale.surchargeMinor ?? 0)
    );
    const seeded = Math.max(0, Math.min(gross, gross - stillOwed));
    discountText.value = seeded > 0 ? moneyInputValue(seeded) : '';

    const wanted = (props.sale.payments[0]?.method ?? 'cash') as PayMethodId;
    method.value = methodChoices.value.some((choice) => choice.id === wanted)
      ? wanted
      : 'cash';
    baseline.value = {
      discount: seeded,
      surcharge: props.sale.surchargeMinor ?? 0,
      fingerprint: rows.value
        .map((row) => `${row.productId}|${row.quantity}|${parseMoney(row.unitPriceText) ?? 0}`)
        .sort()
        .join('~'),
    };
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loading.value = false;
  }
});

function rowGross(row: EditRow): number {
  return Math.max(0, parseMoney(row.unitPriceText) ?? 0) * Math.max(0, row.quantity);
}

const grossMinor = computed(() => rows.value.reduce((sum, row) => sum + rowGross(row), 0));
const discountMinor = computed(() => {
  const typed = Math.max(0, parseMoney(discountText.value) ?? 0);
  return Math.min(typed, grossMinor.value);
});
const surchargeMinor = computed(() => Math.max(0, parseMoney(surchargeText.value) ?? 0));
const totalMinor = computed(() => grossMinor.value - discountMinor.value + surchargeMinor.value);

const canSave = computed(
  () =>
    !loading.value &&
    !busy.value &&
    rows.value.length > 0 &&
    rows.value.every((row) => row.quantity > 0 && row.quantity <= row.maxQty)
);

function setQuantity(row: EditRow, raw: string): void {
  const typed = Number.parseInt(raw, 10);
  if (!Number.isFinite(typed)) {
    row.quantity = Math.min(1, row.maxQty);
    return;
  }
  const ceiling = row.serial ? 1 : Math.max(1, row.maxQty);
  row.quantity = Math.max(1, Math.min(ceiling, typed));
}

function removeRow(key: number): void {
  rows.value = rows.value.filter((row) => row.key !== key);
}

function addProduct(product: PosProduct): void {
  if (product.salePriceMinor === null) {
    error.value = `«${product.name}» من غير سعر بيع. ظبّط سعره من المخزن الأول.`;
    return;
  }
  const existing = rows.value.find((row) => row.productId === product.id && !row.serial);
  if (existing) {
    // A product added here is not on the old invoice: its ceiling is not the
    // returned quantity, it is stock — Rust refuses more than the shelf holds.
    existing.maxQty = Math.min(9999, existing.maxQty + 1);
    existing.quantity = Math.min(existing.maxQty, existing.quantity + 1);
  } else {
    rows.value.push({
      key: keySeq++,
      productId: product.id,
      name: product.name,
      quantity: 1,
      unitPriceText: moneyInputValue(product.salePriceMinor),
      imei: null,
      warrantyStart: null,
      warrantyEnd: null,
      serial: false,
      // Not on the old invoice, so nothing caps it here: stock caps it in Rust.
      maxQty: 9999,
    });
  }
  addQuery.value = '';
  error.value = '';
}

/** Every line still on the old invoice comes back, so the corrected one is whole. */
function returnLines() {
  return (loaded.value?.lines ?? [])
    .filter((line) => line.remainingQty > 0)
    .map((line) => ({
      saleLineId: line.lineId,
      quantity: line.remainingQty,
      condition: 'intact' as const,
    }));
}

function newSaleLines(): SaleLine[] {
  return rows.value.map((row) => ({
    productId: row.productId,
    quantity: row.quantity,
    unitPriceMinor: parseMoney(row.unitPriceText) ?? 0,
    discountMinor: 0,
    imei: row.imei,
    ...(row.warrantyStart ? { warrantyStart: row.warrantyStart } : {}),
    ...(row.warrantyEnd ? { warrantyEnd: row.warrantyEnd } : {}),
  }));
}

async function save(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (rows.value.length === 0) {
    error.value = 'الفاتورة المصححة لازم يكون فيها صنف واحد على الأقل.';
    return;
  }
  if (rows.value.some((row) => (parseMoney(row.unitPriceText) ?? -1) < 0)) {
    error.value = 'فيه سعر مش صحيح.';
    return;
  }
  if (rows.value.some((row) => row.quantity > row.maxQty)) {
    error.value = 'فيه كمية أكبر من الكمية اللي على الفاتورة.';
    return;
  }
  if (discountMinor.value > grossMinor.value) {
    error.value = 'الخصم أكبر من إجمالي الأصناف.';
    return;
  }
  if (reasonText.value.trim() === '') {
    error.value = 'اكتب سبب التعديل — بيتسجل في السجل.';
    return;
  }
  if ((method.value === 'credit' || method.value === 'install') && props.sale.customerId === null) {
    error.value = 'الفاتورة دي على الحساب — لازم يكون عليها عميل عشان تتسجل من غير كاش.';
    return;
  }

  const fingerprint = rows.value
    .map((row) => `${row.productId}|${row.quantity}|${parseMoney(row.unitPriceText) ?? 0}`)
    .sort()
    .join('~');
  if (
    fingerprint === baseline.value.fingerprint &&
    discountMinor.value === baseline.value.discount &&
    surchargeMinor.value === baseline.value.surcharge &&
    method.value === ((props.sale.payments[0]?.method ?? 'cash') as PayMethodId)
  ) {
    error.value = 'مفيش تعديل في الفاتورة — اقفل من غير حفظ.';
    return;
  }

  const returns = returnLines();
  if (returns.length === 0) {
    error.value = 'مفيش سطور على الفاتورة دي تقدر تتعدل.';
    return;
  }

  busy.value = true;
  try {
    const lines = newSaleLines();
    // A zero-total invoice takes exactly one zero payment, and Rust refuses a
    // credit one: nothing is owed, so nothing is put on the account.
    const originalReference = props.sale.payments[0]?.reference ?? null;
    const payments =
      totalMinor.value === 0
        ? [{ method: 'cash' as const, amountMinor: 0, reference: null }]
        : [
            {
              method: method.value,
              amountMinor: totalMinor.value,
              reference: method.value === props.sale.payments[0]?.method ? originalReference : null,
            },
          ];
    const approval = await withOwnerApproval(
      () =>
        recordSaleExchange(
          props.sale.saleId,
          returns,
          reasonText.value.trim(),
          lines,
          discountMinor.value,
          null,
          payments,
          props.sale.customerId,
          surchargeMinor.value
        ),
      `تعديل فاتورة ${props.sale.reference}`
    );
    if (approval.status === 'cancelled') return;
    toast(
      `اتسجّلت الفاتورة المصححة ${approval.value.saleOutcome.reference} — القديمة بسجلها ومرتجعها محفوظة`,
      'ok',
      6000
    );
    emit('saved');
    emit('close');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    :title="`تعديل فاتورة ${sale.reference}`"
    sub="بتتسجل فاتورة مصححة والقديمة تفضل في السجل بمرتجعها"
    size="wide"
    @close="emit('close')"
  >
    <div class="stack" data-edit-sale-modal>
      <div class="note">
        <Icon name="info" />
        <span>
          التعديل بياخد مرتجع للكميات اللي على الفاتورة ويسجّل فاتورة جديدة مصححة
          في نفس اللحظة، عشان المخزون والدرج يفضلوا متطابقين. المطلوب الجديد
          <b class="num">{{ money(totalMinor) }}</b> بدل
          <b class="num">{{ money(sale.totalMinor) }}</b>.
        </span>
      </div>

      <div v-if="loading" class="muted">بيقرأ الفاتورة…</div>

      <template v-else>
        <div class="table-wrap">
          <table class="t" data-edit-sale-lines>
            <thead>
              <tr>
                <th>الصنف</th>
                <th class="ta-n" style="width: 90px">الكمية</th>
                <th class="ta-n" style="width: 120px">السعر ({{ moneyUnitWord() }})</th>
                <th class="ta-n">الإجمالي</th>
                <th style="width: 40px"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.key" :data-edit-sale-row="row.productId">
                <td>
                  <bdi dir="auto">{{ row.name }}</bdi>
                  <div v-if="row.imei" class="mono muted small" dir="ltr">{{ row.imei }}</div>
                </td>
                <td class="ta-n">
                  <input
                    class="in sm num"
                    type="number"
                    min="1"
                    :max="row.serial ? 1 : row.maxQty"
                    :value="row.quantity"
                    :disabled="row.serial"
                    :data-edit-sale-qty="row.productId"
                    @input="setQuantity(row, ($event.target as HTMLInputElement).value)"
                  />
                </td>
                <td class="ta-n">
                  <input
                    v-model="row.unitPriceText"
                    class="in sm mono"
                    dir="ltr"
                    inputmode="decimal"
                    :data-edit-sale-price="row.productId"
                  />
                </td>
                <td class="ta-n num">{{ money(rowGross(row)) }}</td>
                <td>
                  <button
                    type="button"
                    class="icon-btn sm danger"
                    title="شيل السطر"
                    :data-edit-sale-remove="row.productId"
                    @click="removeRow(row.key)"
                  >
                    <Icon name="trash-2" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="field">
          <label for="edit-sale-add">أضف صنف من الكتالوج</label>
          <input
            id="edit-sale-add"
            v-model="addQuery"
            class="in"
            autocomplete="off"
            placeholder="دوّر بالاسم أو الباركود"
            data-edit-sale-add
          />
        </div>
        <div v-if="addResults.length > 0" class="stack" style="gap: 6px" data-edit-sale-add-results>
          <button
            v-for="p in addResults"
            :key="p.id"
            type="button"
            class="btn soft"
            style="justify-content: space-between"
            :data-edit-sale-add-result="p.id"
            @click="addProduct(p)"
          >
            <span><bdi dir="auto">{{ p.name }}</bdi></span>
            <span class="num">{{ money(p.salePriceMinor ?? 0) }}</span>
          </button>
        </div>

        <div class="row" style="gap: 10px; flex-wrap: wrap">
          <div class="field" style="flex: 1; min-width: 160px">
            <label for="edit-sale-discount">الخصم ({{ moneyUnitWord() }})</label>
            <input
              id="edit-sale-discount"
              v-model="discountText"
              class="in mono"
              dir="ltr"
              inputmode="decimal"
              placeholder="0"
              data-edit-sale-discount
            />
          </div>
          <div class="field" style="flex: 1; min-width: 160px">
            <label for="edit-sale-surcharge">زيادة ({{ moneyUnitWord() }})</label>
            <input
              id="edit-sale-surcharge"
              v-model="surchargeText"
              class="in mono"
              dir="ltr"
              inputmode="decimal"
              placeholder="0"
              data-edit-sale-surcharge
            />
          </div>
          <div class="field" style="flex: 1; min-width: 160px">
            <label for="edit-sale-reason">سبب التعديل</label>
            <input
              id="edit-sale-reason"
              v-model="reasonText"
              class="in"
              data-edit-sale-reason
            />
          </div>
        </div>

        <p v-if="isSplitPaid" class="muted small">
          الفاتورة دي مدفوعة بأكتر من طريقة — المصححة بتتسجل بدفعة واحدة، والمرتجع
          بيرجّع لكل طريقة اللي دفعته.
        </p>
        <div class="field">
          <span class="label">طريقة دفع الفاتورة المصححة</span>
          <div class="seg" role="group" aria-label="طريقة الدفع">
            <button
              v-for="choice in methodChoices"
              :key="choice.id"
              type="button"
              :class="{ on: method === choice.id }"
              :data-edit-sale-method="choice.id"
              @click="method = choice.id"
            >
              {{ choice.name }}
            </button>
          </div>
        </div>

        <div class="sum-box">
          <div class="r">
            <span>إجمالي الأصناف</span>
            <span class="num">{{ money(grossMinor) }}</span>
          </div>
          <div v-if="discountMinor > 0" class="r">
            <span>خصم</span>
            <span class="num">− {{ money(discountMinor) }}</span>
          </div>
          <div v-if="surchargeMinor > 0" class="r">
            <span>زيادة</span>
            <span class="num">+ {{ money(surchargeMinor) }}</span>
          </div>
          <div class="r grand">
            <span>المطلوب بعد التعديل</span>
            <span class="num" data-edit-sale-total>{{ money(totalMinor) }}</span>
          </div>
        </div>

        <div v-if="error" class="banner err" role="alert" data-edit-sale-error>{{ error }}</div>
      </template>
    </div>

    <template #foot>
      <button
        type="button"
        class="btn primary"
        :disabled="!canSave"
        data-edit-sale-save
        @click="save"
      >
        <Icon name="check" /> احفظ التعديل ({{ num(rows.length) }} صنف)
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
