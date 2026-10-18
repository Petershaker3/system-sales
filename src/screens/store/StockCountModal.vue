<script setup lang="ts">
// Phase 2 — Item 2.4: الجرد بالمسح وكشف الـ IMEI الناقص (`ADR-034`, `docs/PLAN.md` §11 & §19).
// Allows scanning 15-digit IMEIs and product barcodes, immediately highlights missing
// IMEI units on the shelf, and reconciles stock differences with Owner PIN approval.

import { computed, nextTick, onMounted, ref } from 'vue';
import { listCategories, type CategoryEntry } from '../../api/categories';
import { describeError } from '../../api/errors';
import {
  listAllProductUnits,
  reconcileStockCount,
  type ProductUnit,
} from '../../api/inventory';
import { posCatalog, type PosProduct } from '../../api/pos';
import { withOwnerApproval } from '../../shell/approval';
import { money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import {
  buildReconcilePayload,
  computeStockCountSummary,
  createStockCountRows,
  markAllRowsMatched,
  resolveScanInput,
  setRowCountedQty,
  STOCK_COUNT_REASONS,
  toggleUnitScanned,
  type StockCountFilterTab,
  type StockCountRowState,
  type StockCountScope,
} from './stock-count';

const emit = defineEmits<{
  close: [];
  reconciled: [];
}>();

const loading = ref(true);
const busy = ref(false);
const error = ref('');

const rows = ref<StockCountRowState[]>([]);
const scope = ref<StockCountScope>('all');
const activeTab = ref<StockCountFilterTab>('all');
const searchQuery = ref('');

const scanInput = ref('');
const scanEl = ref<HTMLInputElement | null>(null);
const scanFeedback = ref<{
  readonly kind: 'ok' | 'warn' | 'err';
  readonly text: string;
} | null>(null);

const selectedReason = ref<string>(STOCK_COUNT_REASONS[0]!);
const extraNote = ref('');

async function loadData(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [catSnap, categories, units] = await Promise.all([
      posCatalog().catch(() => null),
      listCategories().catch((): CategoryEntry[] => []),
      listAllProductUnits().catch((): ProductUnit[] => []),
    ]);
    const catNames = new Map<string, string>(categories.map((c) => [c.id, c.name]));
    const posProducts: readonly PosProduct[] = catSnap?.products ?? [];

    rows.value = createStockCountRows(
      posProducts.map((p) => ({
        id: p.id,
        name: p.name,
        categoryId: p.categoryId,
        categoryLabel: (p.categoryId && catNames.get(p.categoryId)) || 'عام',
        barcode: p.barcode,
        isSerialized:
          p.disposition === 'serialized' ||
          p.tracking === 'serial_optional' ||
          p.tracking === 'serial_required' ||
          p.brandId !== null,
        onHand: p.onHand,
      })),
      units
    );
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
    await nextTick();
    scanEl.value?.focus();
  }
}

onMounted(loadData);

const scopedRows = computed<readonly StockCountRowState[]>(() => {
  return rows.value.filter((r) => {
    if (scope.value === 'imei') return r.isSerialized || r.units.length > 0;
    if (scope.value === 'items') return !r.isSerialized && r.units.length === 0;
    return true;
  });
});

const summary = computed(() => computeStockCountSummary(scopedRows.value));

const filteredRows = computed<readonly StockCountRowState[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return scopedRows.value.filter((row) => {
    const missingInRow = row.units.some((u) => !u.scanned);
    const hasDiff = row.countedQty !== row.expectedQty || missingInRow;
    if (activeTab.value === 'discrepancies' && !hasDiff) return false;
    if (activeTab.value === 'matched' && hasDiff) return false;
    if (activeTab.value === 'missing_imeis' && !missingInRow) return false;

    if (!q) return true;
    if (row.name.toLowerCase().includes(q)) return true;
    if (row.barcode && row.barcode.toLowerCase().includes(q)) return true;
    if (row.categoryLabel.toLowerCase().includes(q)) return true;
    return row.units.some(
      (u) => u.imei.includes(q) || (u.imei2 !== null && u.imei2.includes(q))
    );
  });
});

const reconcileItems = computed(() => buildReconcilePayload(scopedRows.value));

function handleScanSubmit(): void {
  const raw = scanInput.value.trim();
  if (!raw) return;
  const res = resolveScanInput(rows.value, raw);
  if (res.kind === 'matched_imei') {
    rows.value = [...res.nextRows];
    scanFeedback.value = {
      kind: 'ok',
      text: `اتمسح الموبايل ✓: ${res.row.name} — IMEI ${res.unit.imei}`,
    };
    scanInput.value = '';
  } else if (res.kind === 'duplicate_imei') {
    scanFeedback.value = {
      kind: 'warn',
      text: `الجهاز ده اتمسح قبل كده في الجرد الحالي: ${res.row.name} (${res.unit.imei})`,
    };
    scanInput.value = '';
  } else if (res.kind === 'unknown_imei') {
    scanFeedback.value = {
      kind: 'err',
      text: `الـ IMEI (${res.query}) مش موجود في رصيد المخزن الحالي!`,
    };
  } else if (res.kind === 'matched_barcode') {
    rows.value = [...res.nextRows];
    scanFeedback.value = {
      kind: 'ok',
      text: `اتمسح الصنف ✓: ${res.row.name} — الفعلي دلوقتي ${num(res.row.countedQty)} (في السيستم ${num(res.row.expectedQty)})`,
    };
    scanInput.value = '';
  } else {
    scanFeedback.value = {
      kind: 'err',
      text: `ملقيناش صنف أو IMEI بالكود ده (${res.query}).`,
    };
  }
  scanEl.value?.focus();
}

function handleToggleUnit(unitId: string, scanned: boolean): void {
  rows.value = toggleUnitScanned(rows.value, unitId, scanned);
}

function handleQtyChange(productId: string, qty: number): void {
  rows.value = setRowCountedQty(rows.value, productId, qty);
}

function handleMatchAll(): void {
  rows.value = markAllRowsMatched(rows.value);
  scanFeedback.value = {
    kind: 'ok',
    text: 'اتعلّم على كل الأصناف وأجهزة الـ IMEI إنها مطابقة لرصيد السيستم.',
  };
}

async function submitReconciliation(): Promise<void> {
  error.value = '';
  const payload = reconcileItems.value;
  if (payload.length === 0) {
    error.value = 'مفيش أي فروق أو IMEI ناقص عشان تتسجّل تسوية جرد.';
    return;
  }
  const baseReason = selectedReason.value.trim() || STOCK_COUNT_REASONS[0]!;
  const cleanExtra = extraNote.value.trim();
  const fullReason = cleanExtra ? `${baseReason} — ${cleanExtra}` : baseReason;

  busy.value = true;
  try {
    const outcome = await withOwnerApproval(
      () => reconcileStockCount(fullReason, payload),
      `اعتماد تسوية الجرد (${fullReason})`
    );
    if (outcome.status === 'cancelled') return;
    const res = outcome.value;
    toast(
      `اتسجّلت تسوية الجرد: ${num(res.adjustedProducts)} صنف${
        res.retiredUnits > 0 ? ` · استبعاد ${num(res.retiredUnits)} جهاز IMEI ناقص` : ''
      }`,
      'ok'
    );
    emit('reconciled');
    emit('close');
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    size="wide"
    title="الجرد بالمسح وكشف الـ IMEI الناقص"
    sub="امسح باركود الأصناف أو أرقام الـ IMEI على الرف — السيستم بيكشف أي IMEI ناقص أو فرق عدد فوراً"
    @close="emit('close')"
  >
    <div class="intake sc-modal" data-stock-count-modal>
      <!-- Right Column: Scan Input + Filter Tabs + Stock & Missing IMEI List -->
      <div class="sc-col">
        <!-- Scope & Match All bar -->
        <div class="sc-top-bar">
          <div class="seg">
            <button
              type="button"
              :class="{ on: scope === 'all' }"
              data-sc-scope="all"
              @click="scope = 'all'"
            >
              كل المخزن ({{ num(rows.length) }})
            </button>
            <button
              type="button"
              :class="{ on: scope === 'imei' }"
              data-sc-scope="imei"
              @click="scope = 'imei'"
            >
              أجهزة الـ IMEI ({{ num(rows.filter((r) => r.isSerialized || r.units.length > 0).length) }})
            </button>
            <button
              type="button"
              :class="{ on: scope === 'items' }"
              data-sc-scope="items"
              @click="scope = 'items'"
            >
              الأصناف بالعدد
            </button>
          </div>
          <button
            type="button"
            class="btn sm ghost"
            data-sc-mark-all-matched
            @click="handleMatchAll"
          >
            <Icon name="check" /> اعتبر الباقي مطابق
          </button>
        </div>

        <!-- Barcode / IMEI Scan Input -->
        <div class="sc-scan-box">
          <label class="fl" for="sc-scan-input">
            امسح باركود الصنف أو الـ IMEI (15 رقم أو آخر 4 أرقام) واضغط Enter
          </label>
          <div class="sc-scan-row">
            <input
              id="sc-scan-input"
              ref="scanEl"
              v-model="scanInput"
              type="text"
              class="input"
              :class="{ mono: scanInput !== '' }"
              :dir="scanInput ? 'ltr' : 'rtl'"
              placeholder="امسح بالاسكانر أو اكتب الباركود / الـ IMEI..."
              data-sc-scan-input
              @keydown.enter.prevent="handleScanSubmit"
            />
            <button
              type="button"
              class="btn primary"
              data-sc-scan-submit
              @click="handleScanSubmit"
            >
              <Icon name="scan-line" /> سجل المسح
            </button>
          </div>
          <div
            v-if="scanFeedback"
            class="sc-feedback"
            :class="`sc-fb-${scanFeedback.kind}`"
            data-sc-scan-feedback
          >
            <bdi dir="rtl">{{ scanFeedback.text }}</bdi>
          </div>
        </div>

        <!-- Filter Tabs & Search -->
        <div class="sc-filter-row">
          <div class="seg">
            <button
              type="button"
              :class="{ on: activeTab === 'all' }"
              data-sc-tab="all"
              @click="activeTab = 'all'"
            >
              الكل ({{ num(scopedRows.length) }})
            </button>
            <button
              type="button"
              :class="{ on: activeTab === 'missing_imeis' }"
              data-sc-tab="missing_imeis"
              @click="activeTab = 'missing_imeis'"
            >
              IMEI ناقص ({{ num(summary.missingUnits.length) }})
            </button>
            <button
              type="button"
              :class="{ on: activeTab === 'discrepancies' }"
              data-sc-tab="discrepancies"
              @click="activeTab = 'discrepancies'"
            >
              فروق وعجز ({{ num(summary.discrepancyProducts) }})
            </button>
            <button
              type="button"
              :class="{ on: activeTab === 'matched' }"
              data-sc-tab="matched"
              @click="activeTab = 'matched'"
            >
              مطابق ({{ num(summary.matchedProducts) }})
            </button>
          </div>
          <input
            v-model="searchQuery"
            type="text"
            class="input sm sc-search"
            placeholder="فلتر بالاسم أو الباركود..."
            data-sc-search
          />
        </div>

        <!-- Dedicated Missing IMEIs View -->
        <div
          v-if="activeTab === 'missing_imeis'"
          class="sc-list"
          data-sc-missing-list
        >
          <div v-if="summary.missingUnits.length === 0" class="sc-empty ok">
            كل أجهزة الـ IMEI المتسجّلة في المخزن اتمسحت وموجودة على الرف ✓
          </div>
          <div
            v-for="u in summary.missingUnits"
            :key="u.id"
            class="sc-missing-card"
            :data-sc-missing-unit="u.id"
          >
            <div class="sc-missing-info">
              <div class="sc-row-title">
                <span class="tag err">IMEI ناقص</span>
                <b><bdi dir="rtl">{{ u.productName }}</bdi></b>
                <span v-if="u.conditionGrade" class="tag info">فئة {{ u.conditionGrade }}</span>
                <span v-if="u.batteryHealthPct" class="tag">بطارية {{ num(u.batteryHealthPct) }}%</span>
                <span v-if="u.color" class="tag">{{ u.color }}</span>
              </div>
              <div class="sc-missing-meta">
                <span class="mono" dir="ltr">IMEI: {{ u.imei }}</span>
                <span v-if="u.unitCostMinor > 0" class="muted">
                  · التكلفة: {{ money(u.unitCostMinor) }}
                </span>
              </div>
            </div>
            <button
              type="button"
              class="btn sm"
              :data-sc-mark-unit-present="u.id"
              @click="handleToggleUnit(u.id, true)"
            >
              <Icon name="check" /> موجود على الرف ✓
            </button>
          </div>
        </div>

        <!-- Product Rows View -->
        <div v-else class="sc-list" data-sc-rows-list>
          <div v-if="filteredRows.length === 0" class="sc-empty">
            مفيش أصناف مطابقة للفلتر الحالي.
          </div>
          <div
            v-for="row in filteredRows"
            :key="row.productId"
            class="sc-row-card"
            :class="{
              'has-diff': row.countedQty !== row.expectedQty || row.units.some((u) => !u.scanned),
            }"
            :data-sc-row="row.productId"
          >
            <div class="sc-row-head">
              <div class="sc-row-info">
                <div class="sc-row-title">
                  <b><bdi dir="rtl">{{ row.name }}</bdi></b>
                  <span class="muted">({{ row.categoryLabel }})</span>
                  <span
                    v-if="row.countedQty === row.expectedQty && !row.units.some((u) => !u.scanned)"
                    class="tag ok"
                  >
                    مطابق ✓
                  </span>
                  <span
                    v-else-if="row.countedQty < row.expectedQty"
                    class="tag err"
                    :data-sc-row-diff="row.productId"
                  >
                    عجز {{ num(row.expectedQty - row.countedQty) }}
                  </span>
                  <span
                    v-else-if="row.countedQty > row.expectedQty"
                    class="tag warn"
                    :data-sc-row-diff="row.productId"
                  >
                    زيادة +{{ num(row.countedQty - row.expectedQty) }}
                  </span>
                </div>
                <div class="sc-row-sub">
                  <span>في السيستم: <b>{{ num(row.expectedQty) }}</b></span>
                  <span v-if="row.barcode" class="mono muted" dir="ltr">· {{ row.barcode }}</span>
                </div>
              </div>

              <div class="sc-qty-ctrl">
                <button
                  type="button"
                  class="btn sm ghost"
                  :disabled="row.countedQty <= 0"
                  @click="handleQtyChange(row.productId, row.countedQty - 1)"
                >
                  −
                </button>
                <input
                  type="number"
                  min="0"
                  class="input sm mono sc-qty-in"
                  :value="row.countedQty"
                  :data-sc-qty-input="row.productId"
                  @change="
                    handleQtyChange(
                      row.productId,
                      Number(($event.target as HTMLInputElement).value)
                    )
                  "
                />
                <button
                  type="button"
                  class="btn sm ghost"
                  @click="handleQtyChange(row.productId, row.countedQty + 1)"
                >
                  +
                </button>
                <button
                  v-if="row.countedQty !== row.expectedQty || row.units.some((u) => !u.scanned)"
                  type="button"
                  class="btn sm"
                  :data-sc-row-match="row.productId"
                  @click="handleQtyChange(row.productId, row.expectedQty)"
                >
                  مطابق
                </button>
              </div>
            </div>

            <!-- Registered IMEI units inside this product row -->
            <div v-if="row.units.length > 0" class="sc-unit-chips">
              <button
                v-for="u in row.units"
                :key="u.id"
                type="button"
                class="sc-unit-chip"
                :class="u.scanned ? 'scanned' : 'missing'"
                :data-sc-unit-chip="u.id"
                @click="handleToggleUnit(u.id, !u.scanned)"
              >
                <span class="chip-status">{{ u.scanned ? '✓ موجود' : '! ناقص' }}</span>
                <span class="mono" dir="ltr">{{ u.imei }}</span>
                <span v-if="u.conditionGrade" class="chip-grade">فئة {{ u.conditionGrade }}</span>
                <span v-if="u.color" class="chip-color">{{ u.color }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Left Column: Live KPIs + Missing IMEIs Summary + Reconciliation Reason -->
      <div class="sc-col">
        <div class="sc-kpi-grid">
          <div class="sc-kpi-card" data-sc-kpi-scanned-units>
            <span class="muted">أجهزة IMEI الممسوحة</span>
            <b>{{ num(summary.scannedUnits) }} / {{ num(summary.totalUnits) }}</b>
          </div>
          <div
            class="sc-kpi-card"
            :class="summary.missingUnits.length > 0 ? 'err' : 'ok'"
            data-sc-kpi-missing-units
          >
            <span class="muted">الـ IMEI الناقص</span>
            <b>{{ num(summary.missingUnits.length) }} جهاز</b>
          </div>
          <div
            class="sc-kpi-card"
            :class="{ err: summary.shortageQtyTotal > 0 }"
            data-sc-kpi-shortage
          >
            <span class="muted">إجمالي العجز</span>
            <b>{{ num(summary.shortageQtyTotal) }} قطعة</b>
          </div>
          <div
            class="sc-kpi-card"
            :class="{ warn: summary.surplusQtyTotal > 0 }"
            data-sc-kpi-surplus
          >
            <span class="muted">إجمالي الزيادة</span>
            <b>{{ num(summary.surplusQtyTotal) }} قطعة</b>
          </div>
        </div>

        <!-- Missing IMEI Alert Box -->
        <div
          class="sc-summary-box"
          :class="summary.missingUnits.length > 0 ? 'has-missing' : 'all-ok'"
          data-sc-missing-summary
        >
          <div class="sc-summary-head">
            <b>
              {{
                summary.missingUnits.length > 0
                  ? `تنبيه: فيه ${num(summary.missingUnits.length)} جهاز بالـ IMEI متسجّل في السيستم وماتمسحش`
                  : 'ممتاز: كل أجهزة الـ IMEI المتسجّلة في المخزن موجودة ومطابقة'
              }}
            </b>
            <span v-if="summary.missingUnitsCostMinor > 0" class="tag err">
              تكلفة الناقص: {{ money(summary.missingUnitsCostMinor) }}
            </span>
          </div>
          <ul v-if="summary.missingUnits.length > 0" class="sc-missing-ul">
            <li v-for="u in summary.missingUnits.slice(0, 6)" :key="u.id">
              <bdi dir="rtl">{{ u.productName }}</bdi> —
              <span class="mono" dir="ltr">IMEI {{ u.imei }}</span>
              <span v-if="u.conditionGrade"> (فئة {{ u.conditionGrade }})</span>
            </li>
          </ul>
          <small class="muted">
            لو الجهاز موجود على الرف امسح الـ IMEI بتاعه أو دوس «موجود على الرف ✓»، ولو مفقود فعلاً اعتمد التسوية عشان يتشال من الرصيد المتاح للبيع بـ PIN المالك.
          </small>
        </div>

        <!-- Reconciliation Reason & Note -->
        <div class="sc-reason-box">
          <label class="fl">سبب تسوية الجرد (إلزامي مع موافقة PIN المالك)</label>
          <div class="sc-reason-chips">
            <button
              v-for="r in STOCK_COUNT_REASONS"
              :key="r"
              type="button"
              class="chip"
              :class="{ on: selectedReason === r }"
              :data-sc-reason-chip="r"
              @click="selectedReason = r"
            >
              {{ r }}
            </button>
          </div>
          <div class="f" style="margin-top: 8px">
            <label class="fl" for="sc-note">ملاحظة إضافية (اختياري)</label>
            <input
              id="sc-note"
              v-model="extraNote"
              type="text"
              class="input"
              placeholder="مثال: جرد رف الموبايلات المستعملة والاسكرينات..."
              data-sc-note
            />
          </div>
        </div>

        <p v-if="error" class="err-msg" role="alert">{{ error }}</p>
      </div>
    </div>

    <template #foot>
      <span class="muted">
        الأصناف اللي فيها فرق: <b>{{ num(reconcileItems.length) }}</b> صنف
      </span>
      <span class="sp"></span>
      <button type="button" class="btn ghost" @click="emit('close')">
        إغلاق <kbd>Esc</kbd>
      </button>
      <button
        type="button"
        class="btn primary"
        data-sc-submit
        :disabled="busy || reconcileItems.length === 0"
        @click="submitReconciliation"
      >
        <Icon name="check" /> اعتمد تسوية الجرد ({{ num(reconcileItems.length) }})
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sc-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.sc-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.sc-scan-box {
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
}
.sc-scan-row {
  display: flex;
  gap: 8px;
}
.sc-scan-row .input {
  flex: 1;
}
.sc-feedback {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--r);
  font-size: 12.5px;
  font-weight: 600;
}
.sc-fb-ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.sc-fb-warn {
  background: var(--warn-soft, rgba(217, 119, 6, 0.12));
  color: var(--warn, #d97706);
}
.sc-fb-err {
  background: var(--err-soft, rgba(220, 38, 38, 0.12));
  color: var(--err, #dc2626);
}
.sc-filter-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.sc-search {
  max-width: 190px;
}
.sc-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface-2);
}
.sc-empty {
  padding: 22px 12px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
.sc-empty.ok {
  color: var(--ok);
  font-weight: 600;
}
.sc-row-card,
.sc-missing-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
}
.sc-missing-card {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  border-color: var(--err, #dc2626);
}
.sc-row-card.has-diff {
  border-color: var(--brand);
}
.sc-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sc-row-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 13px;
}
.sc-row-sub,
.sc-missing-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-top: 2px;
}
.sc-qty-ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
}
.sc-qty-in {
  width: 56px;
  text-align: center;
  padding: 3px 4px;
}
.sc-unit-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px dashed var(--line);
}
.sc-unit-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--surface-2);
}
.sc-unit-chip.scanned {
  border-color: var(--ok);
  background: var(--ok-soft);
  color: var(--ok);
}
.sc-unit-chip.missing {
  border-color: var(--err, #dc2626);
  background: var(--err-soft, rgba(220, 38, 38, 0.1));
  color: var(--err, #dc2626);
}
.chip-status {
  font-weight: 700;
}
.sc-kpi-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.sc-kpi-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
}
.sc-kpi-card b {
  font-size: 15px;
}
.sc-kpi-card.err {
  border-color: var(--err, #dc2626);
}
.sc-kpi-card.ok {
  border-color: var(--ok);
}
.sc-summary-box {
  padding: 10px 12px;
  border-radius: var(--r);
  border: 1px solid var(--line);
  background: var(--surface-2);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sc-summary-box.has-missing {
  border-color: var(--err, #dc2626);
}
.sc-summary-box.all-ok {
  border-color: var(--ok);
}
.sc-summary-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}
.sc-missing-ul {
  margin: 0;
  padding-inline-start: 18px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.sc-reason-box {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface-2);
}
.sc-reason-box .f {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sc-reason-box .f .input {
  width: 100%;
}
.sc-reason-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sp {
  flex: 1;
}
</style>
