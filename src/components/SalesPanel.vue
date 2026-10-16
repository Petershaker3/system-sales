<script setup lang="ts">
// Safe Sales panel (Sales V1).
//
// Two operations, and the panel's job is to make the *confirmation* honest:
//
//   - record: an immutable cash sale. Routine work.
//   - cancel: a reversal that undoes a recorded sale. Manager-only, Sensitive.
//
// # Why the total is confirmed rather than sent
//
// The panel shows a total it computed from the catalogue prices it loaded, and
// sends that figure as `confirmedTotalMinor`. Rust does not take it as the
// price — it re-reads every price inside the transaction that writes the sale,
// and refuses with `SALE_PRICE_CHANGED` if the two disagree. So the number the
// operator agreed to is a claim to be checked, never an input to be trusted.
//
// That is why `SALE_PRICE_CHANGED` is handled as a normal outcome and not as a
// failure: the sale was not written, the prices are re-read, the total changes,
// and the operator confirms the new one. Committing the newer price silently
// would sell at a figure nobody agreed to.
//
// # Why cancellation is a reversal, not an undo
//
// There is no "delete sale" anywhere in this file. Cancelling calls
// `cancel_sale`, which writes a second document that returns the stock and
// points at the movement it undoes. The panel keeps the sale id of what it just
// recorded so the reversal can be started without the operator retyping it, but
// the stored sale itself is never touched.
//
// # Why cost is never rendered here
//
// `SaleOutcome` carries `costTotalMinor` because the Rust service returns it.
// This panel does not display it. Cost is `ViewCostAndProfit`, which a sales
// role never holds — a figure the backend refuses to disclose must not be shown
// merely because it arrived on the wire.
//
// # What V1 refuses, on purpose
//
// No discounts, no VAT, and no serialised or one-off products.
// Those are `SALE_*` refusals from the service, not checks invented here; the
// product picker offers only `quantity` products so the refusal is rarely met in
// normal use, but the service still refuses it (fail-closed).
//
// A customer rides with the recorded sale, never inside the basket: after the
// invoice commits, the operator either links a new customer (created here,
// both roles), picks an existing one (managers browse), or keeps a free-text
// name on the unlinked document. Linking is one-time — the service refuses a
// second link rather than rewriting history (`spec:178`).

import { computed, ref } from 'vue';

import * as catalog from '../api/catalog';
import * as customers from '../api/customer';
import * as lifecycle from '../api/lifecycle';
import * as sales from '../api/sales';
import { describeError } from '../api/errors';
import PatternPrompt from './PatternPrompt.vue';
import type { Product } from '../api/catalog';
import type { Customer } from '../api/customer';

// --- pickers ----------------------------------------------------------------

const products = ref<Product[]>([]);
const selectedProductId = ref('');
const lineQuantity = ref('');

const selectedProduct = computed(
  () => products.value.find((product) => product.id === selectedProductId.value) ?? null
);

// --- the basket -------------------------------------------------------------

/** One line as it stands on screen. The unit price is the catalogue's. */
interface BasketLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  /** `null` when the product has no sale price; such a line cannot be sold. */
  readonly unitPriceMinor: number | null;
  /**
   * The warranty the operator typed for this item, as an ISO day (`YYYY-MM-DD`),
   * or `''` for none (decision D4: the operator states both ends, this software
   * invents neither).
   */
  readonly warrantyStart: string;
  readonly warrantyEnd: string;
}

const basket = ref<BasketLine[]>([]);
const error = ref('');
const notice = ref('');
const busy = ref(false);

/**
 * What the operator is about to agree to, in piastres.
 *
 * Computed from the prices this screen loaded. It is *not* the sale's price —
 * Rust recomputes that under the write lock. The two exist so the operator's
 * agreement can be checked rather than assumed.
 */
const basketTotalMinor = computed(() => {
  let total = 0;
  for (const line of basket.value) {
    if (line.unitPriceMinor === null) continue;
    total += line.unitPriceMinor * line.quantity;
  }
  return total;
});

/** Lines the service will accept. A line without a price is refused as empty-priced. */
const sellable = computed(() => basket.value.filter((line) => line.unitPriceMinor !== null));

async function loadProducts(): Promise<void> {
  busy.value = true;
  try {
    // Only `quantity` products: V1 refuses the other two dispositions, so
    // offering them here would just be a way to reach a refusal.
    const listed = await catalog.listProducts('active');
    products.value = listed.filter((product) => product.disposition === 'quantity');
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- building the basket ----------------------------------------------------

function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 ? value : null;
}

/**
 * Add a line, or raise the quantity of one already present.
 *
 * Merging rather than appending keeps the basket the way an operator reads it:
 * one row per product, not one row per tap.
 */
function addLine(): void {
  const product = selectedProduct.value;
  if (product === null) {
    error.value = 'اختر منتجًا أولًا.';
    return;
  }
  const quantity = parseQuantity(lineQuantity.value);
  if (quantity === null) {
    error.value = 'الكمية يجب أن تكون عددًا صحيحًا أكبر من صفر.';
    return;
  }
  if (product.salePriceMinor === null) {
    error.value = 'لا يوجد سعر بيع لهذا المنتج. حدّد السعر من شاشة المنتجات أولًا.';
    return;
  }

  const existing = basket.value.find((line) => line.productId === product.id);
  if (existing !== undefined) {
    basket.value = basket.value.map((line) =>
      line.productId === product.id
        ? { ...line, quantity: line.quantity + quantity }
        : line
    );
  } else {
    basket.value = [
      ...basket.value,
      {
        productId: product.id,
        name: product.name,
        quantity,
        unitPriceMinor: product.salePriceMinor,
        warrantyStart: '',
        warrantyEnd: '',
      },
    ];
  }

  lineQuantity.value = '';
  error.value = '';
  notice.value = '';
}

function removeLine(productId: string): void {
  basket.value = basket.value.filter((line) => line.productId !== productId);
}

/**
 * Record one warranty boundary on one line.
 *
 * No validation happens here on purpose: the backend owns the rule and answers
 * with its own Arabic message (`SALE_WARRANTY_DATE_INVALID`,
 * `SALE_WARRANTY_RANGE_INVALID`). A second copy of that rule in the browser is a
 * second thing to keep in step with it, and the browser copy is the one that
 * never runs on the shop's real screen.
 */
function setWarranty(
  productId: string,
  boundary: 'warrantyStart' | 'warrantyEnd',
  value: string
): void {
  basket.value = basket.value.map((line) =>
    line.productId === productId ? { ...line, [boundary]: value } : line
  );
  error.value = '';
}

function clearBasket(): void {
  basket.value = [];
  notice.value = '';
  error.value = '';
}

// --- recording --------------------------------------------------------------

const showPattern = ref(false);

/** The sale as last recorded, so a reversal can be started from it directly. */
const lastSaleId = ref('');
const lastReference = ref('');
const lastTotalMinor = ref<number | null>(null);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Record the sale, showing the total as confirmed.
 *
 * The confirmation figure is sent, never the per-line prices. On
 * `SALE_PRICE_CHANGED` the catalogue is re-read and the basket rebuilt at the
 * new prices, so the operator sees what changed and confirms again.
 */
async function submitSale(): Promise<void> {
  if (sellable.value.length === 0) {
    error.value = 'أضف بنودًا قبل تسجيل البيع.';
    return;
  }

  busy.value = true;
  notice.value = '';
  try {
    const outcome = await sales.recordSale(
      sellable.value.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        // The key is omitted rather than sent as `undefined` or `''`: an absent
        // date is no warranty, and both of those would travel to the backend only
        // to be trimmed away. `exactOptionalPropertyTypes` is on, so the shape has
        // to be built rather than assigned.
        ...(line.warrantyStart === '' ? {} : { warrantyStart: line.warrantyStart }),
        ...(line.warrantyEnd === '' ? {} : { warrantyEnd: line.warrantyEnd }),
      })),
      basketTotalMinor.value
    );

    lastSaleId.value = outcome.saleId;
    lastReference.value = outcome.reference;
    lastTotalMinor.value = outcome.totalMinor;

    notice.value = `تم تسجيل البيع. رقم الفاتورة ${outcome.reference} بإجمالي ${formatPiastres(outcome.totalMinor)}.`;
    basket.value = [];
    resetCustomerSection();
    error.value = '';
    if (props.canBrowseCustomers === true) {
      await loadExistingCustomers();
    }
    await loadProducts();
  } catch (err) {
    if (codeOf(err) === 'SALE_PRICE_CHANGED') {
      // Nothing was written. Re-read the prices so the operator agrees to the
      // current ones rather than to a figure that has already moved.
      await loadProducts();
      error.value = describeError(err);
      notice.value = 'راجع الإجمالي الجديد وأكّد من جديد.';
      return;
    }
    if (codeOf(err) === 'PATTERN_REQUIRED' || codeOf(err) === 'PATTERN_APPROVAL_STALE') {
      showPattern.value = true;
      return;
    }
    // Any other refusal wrote nothing, so the basket on screen is still correct.
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function afterPatternVerified(): void {
  showPattern.value = false;
  // The assurance from the Pattern prompt is not what record_sale needs — it is
  // Routine — so the sale simply runs again.
  void submitSale();
}

// --- customer link (CUST-02, CUST-05) ----------------------------------------

/**
 * Invoice-time customer entry. Runs only against the just-recorded sale, so
 * there is no sale picker and no way to attach a customer to the wrong
 * document. A successful link locks this section until the next sale: the
 * service refuses a second link, and the UI does not offer one.
 */
const customerName = ref('');
const customerContact = ref('');
const existingCustomerId = ref('');
const existingCustomers = ref<Customer[]>([]);
const linkedCustomerLabel = ref('');

function resetCustomerSection(): void {
  customerName.value = '';
  customerContact.value = '';
  existingCustomerId.value = '';
  linkedCustomerLabel.value = '';
}

async function loadExistingCustomers(): Promise<void> {
  try {
    existingCustomers.value = await customers.listCustomers();
  } catch (err) {
    error.value = describeError(err);
  }
}

/** Create a new customer and link it to the just-recorded sale. Both roles. */
async function linkNewCustomer(): Promise<void> {
  if (lastSaleId.value === '' || customerName.value.trim() === '') {
    error.value = 'أدخل اسم العميل أولًا.';
    return;
  }
  busy.value = true;
  try {
    const created = await customers.createCustomer(
      customerName.value,
      customerContact.value.trim() === '' ? null : customerContact.value,
    );
    await sales.linkSaleCustomer(lastSaleId.value, created.id);
    linkedCustomerLabel.value = created.name;
    customerName.value = '';
    customerContact.value = '';
    error.value = '';
    notice.value = `تم ربط الفاتورة ${lastReference.value} بالعميل ${created.name}.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/** Link an already-recorded customer. Managers only (browsing needs it). */
async function linkExistingCustomer(): Promise<void> {
  if (lastSaleId.value === '' || existingCustomerId.value === '') {
    error.value = 'اختر عميلًا من القائمة أولًا.';
    return;
  }
  busy.value = true;
  try {
    await sales.linkSaleCustomer(lastSaleId.value, existingCustomerId.value);
    const picked = existingCustomers.value.find((c) => c.id === existingCustomerId.value);
    linkedCustomerLabel.value = picked?.name ?? '';
    existingCustomerId.value = '';
    error.value = '';
    notice.value = `تم ربط الفاتورة ${lastReference.value} بالعميل ${linkedCustomerLabel.value}.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/** Keep a free-text name on the unlinked sale. Both roles. */
async function saveCustomerSnapshot(): Promise<void> {
  if (lastSaleId.value === '' || customerName.value.trim() === '') {
    error.value = 'أدخل اسم العميل أولًا.';
    return;
  }
  busy.value = true;
  try {
    await sales.setSaleCustomerName(lastSaleId.value, customerName.value);
    linkedCustomerLabel.value = `${customerName.value.trim()} (اسم نصي)`;
    customerName.value = '';
    customerContact.value = '';
    error.value = '';
    notice.value = `تم حفظ اسم العميل نصيًا على الفاتورة ${lastReference.value}.`;
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- cancellation -----------------------------------------------------------

/**
 * Whether to offer the reversal form.
 *
 * Presentation only. `CancelTransaction` is manager-only and the backend refuses
 * a sales role regardless of what the DOM offers (`spec:210`).
 */
const props = defineProps<{ canCancel: boolean; canBrowseCustomers?: boolean }>();

const cancelSaleId = ref('');
const cancelReason = ref('');
const cancelPassword = ref('');
const showCancelDialog = ref(false);

/** Open the reversal form for a specific sale. */
function startCancel(saleId: string): void {
  cancelSaleId.value = saleId;
  cancelReason.value = '';
  cancelPassword.value = '';
  error.value = '';
  notice.value = '';
  showCancelDialog.value = true;
}

function closeCancelDialog(): void {
  showCancelDialog.value = false;
  cancelPassword.value = '';
}

/** Prove the Manager password, then reverse. The two steps answer different questions. */
async function confirmCancel(): Promise<void> {
  busy.value = true;
  try {
    await lifecycle.reauthenticate(cancelPassword.value);
    cancelPassword.value = '';
    await performCancel();
  } catch (err) {
    if (codeOf(err) === 'PATTERN_REQUIRED' || codeOf(err) === 'PATTERN_APPROVAL_STALE') {
      showCancelDialog.value = false;
      showPattern.value = true;
      return;
    }
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * The reversal itself, with the assurance already raised.
 *
 * A Pattern refusal opens the prompt instead of being reported as an error: it
 * means the operation needs one more step, not that it failed.
 */
async function performCancel(): Promise<void> {
  busy.value = true;
  try {
    const outcome = await sales.cancelSale(cancelSaleId.value, cancelReason.value.trim());
    closeCancelDialog();
    notice.value = `تم إلغاء عملية البيع ${outcome.reference} بإرجاع الكميات إلى المخزون.`;
    error.value = '';
    lastSaleId.value = '';
    lastTotalMinor.value = null;
  } catch (err) {
    if (codeOf(err) === 'PATTERN_REQUIRED' || codeOf(err) === 'PATTERN_APPROVAL_STALE') {
      closeCancelDialog();
      showPattern.value = true;
      return;
    }
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- labels ----------------------------------------------------------------

/** Piastres to a readable amount. Display only; never fed back into arithmetic. */
function formatPiastres(minor: number | null): string {
  if (minor === null) return '—';
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole}.${String(rest).padStart(2, '0')} ج.م`;
}

void loadProducts();
</script>

<template>
  <section class="sales">
    <h2 class="sales-title">البيع</h2>

    <!-- Add a line -->
    <form class="form" @submit.prevent="addLine">
      <label class="field">
        <span>المنتج</span>
        <select v-model="selectedProductId">
          <option value="">— اختر منتجًا —</option>
          <option v-for="product in products" :key="product.id" :value="product.id">
            {{ product.name }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>الكمية</span>
        <input v-model="lineQuantity" inputmode="numeric" autocomplete="off" />
      </label>
      <button type="submit" :disabled="busy || selectedProductId === ''">إضافة</button>
    </form>

    <!-- The basket -->
    <div v-if="basket.length === 0" class="gate">
      <p class="hint">لا توجد بنود. اختر منتجًا وكميته ثم اضغط إضافة.</p>
    </div>

    <div v-else class="basket">
      <ul class="line-list">
        <li v-for="line in basket" :key="line.productId" class="line">
          <span class="line-name">{{ line.name }}</span>
          <span class="line-quantity">× {{ line.quantity }}</span>
          <span class="line-total">
            {{ formatPiastres(line.unitPriceMinor === null ? null : line.unitPriceMinor * line.quantity) }}
          </span>
          <button type="button" :disabled="busy" @click="removeLine(line.productId)">حذف</button>
          <!--
            Warranty for THIS item (D4/D9): per line, because a customer who buys
            two things has two coverages. `type="date"` gives the platform's own
            picker and hands back `YYYY-MM-DD` — the exact form the column stores,
            and a shape that cannot be typed wrong. `dir="ltr"` because a date is
            read left to right even inside an Arabic layout.
          -->
          <label class="warranty-field">
            <span>ضمان من</span>
            <input
              type="date"
              dir="ltr"
              :value="line.warrantyStart"
              :disabled="busy"
              @input="setWarranty(line.productId, 'warrantyStart', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="warranty-field">
            <span>ضمان إلى</span>
            <input
              type="date"
              dir="ltr"
              :value="line.warrantyEnd"
              :disabled="busy"
              @input="setWarranty(line.productId, 'warrantyEnd', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </li>
      </ul>

      <p class="total">
        الإجمالي: <strong>{{ formatPiastres(basketTotalMinor) }}</strong>
      </p>
      <p class="hint">
        الدفع نقدًا فقط. الإجمالي المعروض مُراجَع داخل تسجيل البيع؛ إن تغيّر السعر
        يُرفض البيع ولا يُكتب شيء.
      </p>
      <p class="hint">
        الضمان اختياري لكل بند على حدة، وتكتب تاريخيه بنفسك. لا توجد مدة افتراضية.
      </p>

      <div class="row">
        <button type="button" :disabled="busy" @click="submitSale">تسجيل البيع</button>
        <button type="button" :disabled="busy" @click="clearBasket">إفراغ</button>
      </div>
    </div>

    <!-- The sale just recorded, and the reversal it can start -->
    <div v-if="lastReference !== ''" class="recorded">
      <h3 class="recorded-title">آخر عملية بيع</h3>
      <dl class="facts">
        <dt>رقم الفاتورة</dt>
        <dd>{{ lastReference }}</dd>
        <dt>الإجمالي</dt>
        <dd>{{ formatPiastres(lastTotalMinor) }}</dd>
      </dl>
      <p class="hint">
        الإلغاء عملية عكسية موثّقة: يُرجَع المخزون وتبقى عملية البيع الأصلية في السجل.
      </p>
      <button
        v-if="props.canCancel"
        type="button"
        :disabled="busy"
        @click="startCancel(lastSaleId)"
      >
        إلغاء هذه العملية
      </button>

      <!-- Invoice-time customer (CUST-02, CUST-05). One link per sale: once
        linked, this section reports the fact instead of offering another. -->
      <div v-if="linkedCustomerLabel !== ''" class="recorded">
        <p class="hint">عميل الفاتورة: {{ linkedCustomerLabel }}</p>
      </div>
      <div v-else class="recorded">
        <h3 class="recorded-title">عميل الفاتورة (اختياري)</h3>
        <label class="field">
          <span>اسم العميل</span>
          <input v-model="customerName" autocomplete="off" maxlength="120" />
        </label>
        <label class="field">
          <span>جهة التواصل (لعميل جديد فقط)</span>
          <input v-model="customerContact" autocomplete="off" maxlength="64" />
        </label>
        <div class="row">
          <button type="button" :disabled="busy" @click="linkNewCustomer">
            ربط عميل جديد
          </button>
          <button type="button" :disabled="busy" @click="saveCustomerSnapshot">
            اسم نصي فقط
          </button>
        </div>
        <div v-if="props.canBrowseCustomers === true" class="row">
          <label class="field">
            <span>أو اختر عميلًا مسجلًا</span>
            <select v-model="existingCustomerId">
              <option value="">— اختر عميلًا —</option>
              <option v-for="customer in existingCustomers" :key="customer.id" :value="customer.id">
                {{ customer.name }}
              </option>
            </select>
          </label>
          <button
            type="button"
            :disabled="busy || existingCustomerId === ''"
            @click="linkExistingCustomer"
          >
            ربط الموجود
          </button>
        </div>
      </div>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Step-up prompt: permissionless by design, so no re-auth in front of it. -->
    <PatternPrompt
      :visible="showPattern"
      @verified="afterPatternVerified"
      @cancelled="showPattern = false"
    />

    <!-- Reversal confirmation: the Manager password is re-proved here on purpose. -->
    <div v-if="showCancelDialog" class="overlay">
      <form class="modal" @submit.prevent="confirmCancel">
        <h3 class="modal-title">إلغاء عملية بيع</h3>
        <p class="hint">
          ستُكتب عملية عكسية تُرجع الكميات إلى المخزون. لا يُحذف أي سجل.
        </p>
        <label class="field">
          <span>سبب الإلغاء</span>
          <input v-model="cancelReason" autocomplete="off" required />
        </label>
        <label class="field">
          <span>كلمة مرور المدير</span>
          <input
            v-model="cancelPassword"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </label>
        <div class="row">
          <button type="submit" :disabled="busy">تأكيد الإلغاء</button>
          <button type="button" :disabled="busy" @click="closeCancelDialog">إلغاء</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* Minimal, matching StockPanel. */
.sales {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.sales-title {
  font-size: 1.05rem;
  margin: 0 0 1rem;
}
.gate {
  margin-bottom: 1rem;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.basket {
  margin: 1rem 0;
}
.line-list {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid #f0f0f0;
  /* Wraps rather than squeezes: the two date fields are as wide as a phone
     screen each, and a squeezed date input is an unusable one. */
  flex-wrap: wrap;
}
.line-name {
  flex: 1 1 auto;
}
.warranty-field {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.85rem;
  /* The label reads right-to-left even though the value inside it does not. */
  flex: 0 0 auto;
}
.warranty-field input {
  font: inherit;
  padding: 0.2rem 0.3rem;
  border: 1px solid #ccc;
  border-radius: 3px;
}
.total {
  font-size: 1rem;
  margin: 0.5rem 0;
}
.recorded {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid #eee;
}
.recorded-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
}
.notice {
  margin-top: 0.75rem;
  padding: 0.6rem;
  border: 1px solid #070;
  color: #070;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 10;
}
.modal {
  background: #fff;
  padding: 1rem;
  max-width: 22rem;
  width: 100%;
}
.modal-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
</style>