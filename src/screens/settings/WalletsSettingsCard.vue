<script setup lang="ts">
/**
 * «محافظ المحل» & «عمولات الخدمات» cards in Settings
 * (Plan item 1.10, `ADR-025`, `docs/ui/mockup-v1/views/settings.js`).
 */
import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import {
  createWallet,
  deleteWallet,
  updateWallet,
  walletsOverview,
  type WalletPayMethod,
  type WalletSummary,
} from '../../api/wallet';
import {
  resolveWalletPeriodBounds,
  WALLET_PAY_OPTIONS,
  WALLET_PRESETS,
} from '../wallets/wallets';
import {
  appearance,
  type ServiceFeeMode,
  setAppearance,
} from '../../ui/appearance';
import { money, num, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';

interface EditableWalletRow {
  id: string;
  name: string;
  /** Company label, empty when the wallet stands on its own (`ADR-040`). */
  company: string;
  number: string;
  color: string;
  openingEgp: string;
  minAlertEgp: string;
  maxLimitEgp: string;
  dailyLimitEgp: string;
  payMethod: WalletPayMethod | '';
  sort: number;
  hidden: boolean;
  isCustom: boolean;
  balanceMinor: number;
}

const rows = ref<EditableWalletRow[]>([]);
const newWalName = ref('');
const newWalNumber = ref('');
const newWalCompany = ref('');
const newWalColor = ref('#0d7377');
const busy = ref(false);

const feePctInput = ref(appearance.serviceFeePct);
const feeMinInput = ref(appearance.serviceFeeMin);
const billFeeInput = ref(appearance.billFee);

const visibleCount = computed<number>(
  () => rows.value.filter((r) => !r.hidden).length
);
const totalBalanceMinor = computed<number>(() =>
  rows.value
    .filter((r) => !r.hidden)
    .reduce((acc, r) => acc + r.balanceMinor, 0)
);

function summaryToRow(ws: WalletSummary): EditableWalletRow {
  const w = ws.wallet;
  return {
    id: w.id,
    name: w.name,
    company: w.company ?? '',
    number: w.number,
    color: w.color,
    openingEgp: String(Math.round(w.openingBalanceMinor / 100)),
    minAlertEgp: String(Math.round(w.minAlertMinor / 100)),
    maxLimitEgp: String(Math.round(w.maxLimitMinor / 100)),
    dailyLimitEgp: String(Math.round(w.dailyLimitMinor / 100)),
    payMethod: w.payMethod ?? '',
    sort: w.sort,
    hidden: w.hidden,
    isCustom: w.isCustom,
    balanceMinor: ws.balanceMinor,
  };
}

async function loadWallets(): Promise<void> {
  try {
    const bounds = resolveWalletPeriodBounds('today');
    const overview = await walletsOverview(
      bounds.todayFromMs,
      bounds.periodFromMs,
      bounds.periodToMs,
      null,
      10
    );
    rows.value = overview.wallets.map(summaryToRow);
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

onMounted(() => {
  void loadWallets();
});

async function saveWalletRow(
  row: EditableWalletRow,
  msg = 'اتحفظت إعدادات المحفظة'
): Promise<void> {
  if (busy.value) return;
  const openingMinor = parseMoney(row.openingEgp) ?? 0;
  const minMinor = parseMoney(row.minAlertEgp) ?? 0;
  const maxMinor = parseMoney(row.maxLimitEgp) ?? 0;
  const dailyMinor = parseMoney(row.dailyLimitEgp) ?? 0;

  busy.value = true;
  try {
    await updateWallet({
      walletId: row.id,
      name: row.name.trim(),
      number: row.number.trim(),
      color: row.color,
      openingBalanceMinor: Math.max(0, openingMinor),
      minAlertMinor: Math.max(0, minMinor),
      maxLimitMinor: Math.max(0, maxMinor),
      dailyLimitMinor: Math.max(0, dailyMinor),
      payMethod: row.payMethod === '' ? null : row.payMethod,
      company: row.company.trim() || null,
      sort: row.sort,
      hidden: row.hidden,
    });
    await loadWallets();
    toast(msg, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
    await loadWallets();
  } finally {
    busy.value = false;
  }
}

async function moveWalletRow(
  row: EditableWalletRow,
  dir: -1 | 1
): Promise<void> {
  const list = walletRows.value;
  const at = list.findIndex((v) => v.row.id === row.id);
  if (at < 0) return;
  const a = row;
  const b = list[at + dir]?.row;
  if (!b || busy.value) return;
  const tmpSort = a.sort;
  a.sort = b.sort;
  b.sort = tmpSort === b.sort ? b.sort + dir : tmpSort;
  busy.value = true;
  try {
    await updateWallet({
      walletId: a.id,
      name: a.name,
      number: a.number,
      color: a.color,
      openingBalanceMinor: Math.max(0, parseMoney(a.openingEgp) ?? 0),
      minAlertMinor: Math.max(0, parseMoney(a.minAlertEgp) ?? 0),
      maxLimitMinor: Math.max(0, parseMoney(a.maxLimitEgp) ?? 0),
      dailyLimitMinor: Math.max(0, parseMoney(a.dailyLimitEgp) ?? 0),
      payMethod: a.payMethod === '' ? null : a.payMethod,
      company: a.company.trim() || null,
      sort: a.sort,
      hidden: a.hidden,
    });
    await updateWallet({
      walletId: b.id,
      name: b.name,
      number: b.number,
      color: b.color,
      openingBalanceMinor: Math.max(0, parseMoney(b.openingEgp) ?? 0),
      minAlertMinor: Math.max(0, parseMoney(b.minAlertEgp) ?? 0),
      maxLimitMinor: Math.max(0, parseMoney(b.maxLimitEgp) ?? 0),
      dailyLimitMinor: Math.max(0, parseMoney(b.dailyLimitEgp) ?? 0),
      payMethod: b.payMethod === '' ? null : b.payMethod,
      company: b.company.trim() || null,
      sort: b.sort,
      hidden: b.hidden,
    });
    await loadWallets();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function removeWalletRow(row: EditableWalletRow): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await deleteWallet(row.id);
    await loadWallets();
    toast(`اتشالت المحفظة «${row.name}»`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

/**
 * Rows in display order. Numbers of one company sit together under that company's name; every
 * wallet without a company is its own group, which is how a shop that never used the field
 * keeps the list it already has (`ADR-040`). A group header is only drawn when a company
 * actually holds more than one number, so one number under a company stays a plain row.
 */
interface WalletRowView {
  row: EditableWalletRow;
  groupHeader: string | null;
  groupCount: number;
  groupBalanceMinor: number;
}

const walletRows = computed<WalletRowView[]>(() => {
  const byKey = new Map<string, EditableWalletRow[]>();
  for (const r of rows.value) {
    const key = r.company.trim() || r.name.trim();
    const list = byKey.get(key);
    if (list) list.push(r);
    else byKey.set(key, [r]);
  }
  const heads: [string, EditableWalletRow[]][] = [];
  for (const entry of byKey.entries()) {
    if (entry[1][0]) heads.push(entry);
  }
  heads.sort((x, y) => (x[1][0]?.sort ?? 0) - (y[1][0]?.sort ?? 0));

  const out: WalletRowView[] = [];
  for (const [name, list] of heads) {
    // More than one number under the same label is the whole rule: the label a group is
    // filed under is the company if it has one, its own name otherwise.
    const grouped = list.length > 1;
    const balance = list.reduce((acc, r) => acc + r.balanceMinor, 0);
    list.forEach((row, i) => {
      out.push({
        row,
        groupHeader: grouped && i === 0 ? name : null,
        groupCount: grouped ? list.length : 0,
        groupBalanceMinor: balance,
      });
    });
  }
  return out;
});

/** Company labels already in use, to type a new number under one of them without retyping it. */
const knownCompanies = computed<string[]>(() => {
  const seen: string[] = [];
  for (const r of rows.value) {
    const c = r.company.trim();
    if (c && !seen.includes(c)) seen.push(c);
  }
  return seen;
});

/** Whether some payment method is received by more than one number (`ADR-040`). */
const sharedPayMethod = computed<boolean>(() => {
  const seen = new Set<string>();
  return rows.value.some((r) => {
    if (!r.payMethod) return false;
    if (seen.has(r.payMethod)) return true;
    seen.add(r.payMethod);
    return false;
  });
});

function pickWalletPreset(preset: {
  name: string;
  color: string;
  company?: string;
}): void {
  newWalName.value = preset.name;
  newWalColor.value = preset.color;
  newWalCompany.value = preset.company ?? '';
}

async function submitNewWallet(): Promise<void> {
  if (busy.value) return;
  const name = newWalName.value.trim();
  if (!name) {
    toast('اكتب اسم المحفظة', 'err');
    return;
  }
  busy.value = true;
  try {
    await createWallet(
      name,
      newWalColor.value,
      newWalNumber.value.trim() || null,
      newWalCompany.value.trim() || null
    );
    newWalName.value = '';
    newWalNumber.value = '';
    newWalCompany.value = '';
    await loadWallets();
    toast(`اتضافت محفظة «${name}»`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function selectFeeMode(mode: ServiceFeeMode): Promise<void> {
  try {
    await setAppearance({ serviceFeeMode: mode });
    toast(
      mode === 'manual'
        ? 'العمولة هتتكتب في كل عملية'
        : 'العمولة هتتحسب تلقائي وتقدر تعدّلها',
      'ok'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function saveAutoFeeSettings(): Promise<void> {
  const pct = Math.max(0, Math.min(20, parseInt(feePctInput.value, 10) || 0));
  const minEgp = Math.max(0, Math.min(1000, parseInt(feeMinInput.value, 10) || 0));
  const billEgp = Math.max(0, Math.min(1000, parseInt(billFeeInput.value, 10) || 0));
  feePctInput.value = String(pct);
  feeMinInput.value = String(minEgp);
  billFeeInput.value = String(billEgp);
  try {
    await setAppearance({
      serviceFeePct: String(pct),
      serviceFeeMin: String(minEgp),
      billFee: String(billEgp),
    });
    toast('اتحفظت إعدادات عمولات الخدمات', 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <!-- Card 1: Shop Wallets -->
  <section class="card" data-card="shop-wallets">
    <div class="between" style="margin-bottom: 4px">
      <h3>محافظ المحل</h3>
      <span class="muted" style="font-size: 0.82rem">
        {{ num(visibleCount) }} شغّالة · الإجمالي
        <b class="num">{{ money(totalBalanceMinor) }}</b>
      </span>
    </div>
    <p class="sub" style="margin-bottom: 12px">
      ضيف وعدّل أرقام المحافظ بتاعتك وحدودها وألوانها، أو اخفي اللي مش شغّال دلوقتي.
    </p>

    <div
      v-if="sharedPayMethod"
      class="note"
      style="margin: 0 0 10px"
      data-wal-shared-note
    >
      <Icon name="info" />
      <span>
        فيه أكتر من رقم بيستقبل نفس الطريقة. لحد ما الكاشير يختار رقم وقت الدفع، بيع الطريقة
        بيتسجل لأول رقم في الترتيب.
      </span>
    </div>

    <div class="wm-wallets">
      <!-- `display: contents` keeps the group header and its rows as siblings of the
           list itself, so grouping costs the grid nothing (`ADR-040`). -->
      <div
        v-for="(view, idx) in walletRows"
        :key="view.row.id"
        style="display: contents"
      >
      <div
        v-if="view.groupHeader"
        class="wm-wal-grp"
        :data-wal-group="view.groupHeader"
      >
        <b>{{ view.groupHeader }}</b>
        <small class="muted">
          {{ num(view.groupCount) }} أرقام · الإجمالي
          <b class="num">{{ money(view.groupBalanceMinor) }}</b>
        </small>
      </div>
      <div
        class="wm-wal"
        :class="{ off: view.row.hidden }"
        :data-wal-settings-row="view.row.id"
      >
        <div class="wm-wal-top">
          <input
            v-model="view.row.color"
            type="color"
            class="clr"
            title="لون المحفظة"
            :aria-label="`لون ${view.row.name}`"
            @change="saveWalletRow(view.row)"
          />
          <input
            v-model="view.row.name"
            class="wm-wal-name"
            :aria-label="`اسم ${view.row.name}`"
            :data-wal-set-name="view.row.id"
            @change="saveWalletRow(view.row)"
          />
          <span class="wm-wal-bal num">
            الرصيد دلوقتي: <b>{{ money(view.row.balanceMinor) }}</b>
          </span>
          <button
            type="button"
            class="icon-btn sm"
            title="طلّع لفوق"
            :disabled="idx === 0 || busy"
            @click="moveWalletRow(view.row, -1)"
          >
            <Icon name="arrow-up" />
          </button>
          <button
            type="button"
            class="icon-btn sm"
            title="نزّل لتحت"
            :disabled="idx === walletRows.length - 1 || busy"
            @click="moveWalletRow(view.row, 1)"
          >
            <Icon name="arrow-down" />
          </button>
          <label
            class="switch"
            :title="view.row.hidden ? 'مخفية' : 'ظاهرة'"
          >
            <input
              type="checkbox"
              :checked="!view.row.hidden"
              :data-wal-set-visible="view.row.id"
              @change="
                view.row.hidden = !($event.target as HTMLInputElement).checked;
                saveWalletRow(
                  view.row,
                  view.row.hidden ? 'اتخفت المحفظة' : 'اتظهرت المحفظة'
                );
              "
            />
            <span />
          </label>
          <button
            v-if="view.row.isCustom"
            type="button"
            class="icon-btn sm"
            title="حذف المحفظة"
            :data-wal-set-del="view.row.id"
            @click="removeWalletRow(view.row)"
          >
            <Icon name="trash-2" />
          </button>
        </div>

        <div class="wm-wal-grid">
          <div class="field">
            <label class="lbl">رقم محفظة المحل</label>
            <input
              v-model="view.row.number"
              class="in mono"
              dir="ltr"
              placeholder="0100... أو user@instapay"
              :data-wal-set-number="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">الشركة (لتجميع الأرقام)</label>
            <input
              v-model="view.row.company"
              class="in"
              list="wal-companies"
              placeholder="مثلاً: فودافون كاش"
              :data-wal-set-company="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">الرصيد الافتتاحي (ج.م)</label>
            <input
              v-model="view.row.openingEgp"
              class="in mono"
              dir="ltr"
              inputmode="numeric"
              :data-wal-set-open="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">نبّهني لما تقل عن</label>
            <input
              v-model="view.row.minAlertEgp"
              class="in mono"
              dir="ltr"
              inputmode="numeric"
              placeholder="0 = من غير تنبيه"
              :data-wal-set-min="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">أقصى رصيد للمحفظة</label>
            <input
              v-model="view.row.maxLimitEgp"
              class="in mono"
              dir="ltr"
              inputmode="numeric"
              placeholder="0 = من غير سقف"
              :data-wal-set-max="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">الحد اليومي للتحويلات</label>
            <input
              v-model="view.row.dailyLimitEgp"
              class="in mono"
              dir="ltr"
              inputmode="numeric"
              placeholder="0 = من غير حد"
              :data-wal-set-daily="view.row.id"
              @change="saveWalletRow(view.row)"
            />
          </div>
          <div class="field">
            <label class="lbl">فلوس البيع بتنزل فيها؟</label>
            <select
              v-model="view.row.payMethod"
              class="in"
              :data-wal-set-pay="view.row.id"
              @change="saveWalletRow(view.row)"
            >
              <option
                v-for="opt in WALLET_PAY_OPTIONS"
                :key="opt.id"
                :value="opt.id"
              >
                {{ opt.name }}
              </option>
            </select>
          </div>
        </div>
      </div>
      </div>
    </div>

    <div
      style="
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid var(--border);
      "
    >
      <b style="display: block; margin-bottom: 8px">ضيف محفظة تانية</b>
      <div class="chips" style="margin-bottom: 10px">
        <button
          v-for="preset in WALLET_PRESETS"
          :key="preset.name"
          type="button"
          class="chip"
          :data-wal-preset="preset.name"
          @click="pickWalletPreset(preset)"
        >
          <span
            class="wl-dot"
            :style="{ background: preset.color }"
          ></span>
          <span>{{ preset.name }}</span>
        </button>
      </div>
      <div class="cat-add">
        <div class="field">
          <label class="lbl" for="wal-new-name">اسم المحفظة</label>
          <input
            id="wal-new-name"
            v-model="newWalName"
            class="in"
            placeholder="مثلاً: فودافون كاش ٢"
            data-wal-new-name
          />
        </div>
        <div class="field">
          <label class="lbl" for="wal-new-num">الرقم (اختياري)</label>
          <input
            id="wal-new-num"
            v-model="newWalNumber"
            class="in mono"
            dir="ltr"
            placeholder="0100..."
            data-wal-new-number
          />
        </div>
        <div class="field">
          <label class="lbl" for="wal-new-company">الشركة (اختياري)</label>
          <input
            id="wal-new-company"
            v-model="newWalCompany"
            class="in"
            list="wal-companies"
            placeholder="مثلاً: فودافون كاش"
            data-wal-new-company
          />
          <datalist id="wal-companies">
            <option
              v-for="c in knownCompanies"
              :key="c"
              :value="c"
            />
          </datalist>
        </div>
        <div class="row" style="gap: 8px; align-items: end">
          <input
            v-model="newWalColor"
            type="color"
            class="clr"
            title="لون المحفظة"
            aria-label="لون المحفظة الجديدة"
          />
          <button
            type="button"
            class="btn primary"
            :disabled="busy"
            data-wal-add-submit
            @click="submitNewWallet"
          >
            <Icon name="plus" />
            <span>ضيف محفظة</span>
          </button>
        </div>
      </div>
    </div>
  </section>

  <!-- Card 2: Service Commissions -->
  <section class="card" data-card="service-fees">
    <h3>عمولات الخدمات</h3>
    <div class="s-row">
      <div class="t">
        <b>طريقة كتابة العمولة</b>
        <small>في التحويل والسحب ودفع الفواتير من «خدمات سريعة»</small>
      </div>
      <div class="seg" role="group" aria-label="طريقة كتابة العمولة">
        <button
          type="button"
          :class="{ on: appearance.serviceFeeMode === 'manual' }"
          data-fee-mode="manual"
          @click="selectFeeMode('manual')"
        >
          تتكتب في كل عملية
        </button>
        <button
          type="button"
          :class="{ on: appearance.serviceFeeMode === 'auto' }"
          data-fee-mode="auto"
          @click="selectFeeMode('auto')"
        >
          محسوبة تلقائي
        </button>
      </div>
    </div>

    <div v-if="appearance.serviceFeeMode === 'manual'" class="note">
      <Icon name="info" />
      <span>
        الخانة بتاعت العمولة هتفضل فاضية في كل عملية تكتبها بإيدك حسب الاتفاق مع العميل (ولو مفيش عمولة اكتب 0).
      </span>
    </div>

    <div v-else class="g3" style="margin-top: 10px">
      <div class="field">
        <label class="lbl" for="set-feePct">عمولة التحويل والسحب %</label>
        <input
          id="set-feePct"
          v-model="feePctInput"
          class="in mono"
          dir="ltr"
          inputmode="numeric"
          data-set-fee-pct
          @change="saveAutoFeeSettings"
        />
      </div>
      <div class="field">
        <label class="lbl" for="set-feeMin">أقل عمولة (ج.م)</label>
        <input
          id="set-feeMin"
          v-model="feeMinInput"
          class="in mono"
          dir="ltr"
          inputmode="numeric"
          data-set-fee-min
          @change="saveAutoFeeSettings"
        />
      </div>
      <div class="field">
        <label class="lbl" for="set-billFee">رسوم دفع الفواتير (ج.م)</label>
        <input
          id="set-billFee"
          v-model="billFeeInput"
          class="in mono"
          dir="ltr"
          inputmode="numeric"
          data-set-bill-fee
          @change="saveAutoFeeSettings"
        />
      </div>
    </div>
  </section>
</template>
