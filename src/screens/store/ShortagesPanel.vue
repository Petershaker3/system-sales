<script setup lang="ts">
// Shortages tab inside the Store screen («المخزن ← النواقص», Plan item 1.15,
// `ADR-030`, `docs/ui/SALES-SHORTAGES.md`, `docs/ui/mockup-v1/views/shortages.js`).

import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import type { Session } from '../../api/identity';
import { posCatalog, type PosProduct } from '../../api/pos';
import {
  addAllSuggestedShortages,
  addShortage,
  deleteShortage,
  resolveShortage,
  setShortageStatus,
  shortagesOverview,
  type ShortageEntry,
  type ShortageStatus,
  type ShortageSuggestion,
} from '../../api/shortages';
import { dg, num, parseCount, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import {
  defaultMinQty,
  formatArrivedToast,
  formatShortageWhen,
  normalizeShortageSearch,
  parseWaitingCustomer,
  suggestedQty,
} from './shortages';

const props = defineProps<{
  session?: Session | null;
}>();

const emit = defineEmits<{
  changed: [activeCount: number];
}>();

const items = ref<readonly ShortageEntry[]>([]);
const suggestions = ref<readonly ShortageSuggestion[]>([]);
const catalogProducts = ref<readonly PosProduct[]>([]);
const categoryMap = ref<Map<string, { name: string; kind: string }>>(new Map());
const busy = ref(false);
const statusFilter = ref<'all' | ShortageStatus>('all');

// Manual add draft
const draftName = ref('');
const draftQty = ref('1');
const draftCust = ref('');
const draftNote = ref('');
const linkedProductId = ref<string | null>(null);

const linkedProduct = computed<PosProduct | null>(() => {
  if (!linkedProductId.value) return null;
  return catalogProducts.value.find((p) => p.id === linkedProductId.value) ?? null;
});

const matchingProducts = computed<
  Array<{
    id: string;
    name: string;
    categoryName: string;
    onHand: number;
    minQty: number;
  }>
>(() => {
  if (linkedProductId.value) return [];
  const q = normalizeShortageSearch(draftName.value);
  if (!q) return [];
  const matches: Array<{
    id: string;
    name: string;
    categoryName: string;
    onHand: number;
    minQty: number;
  }> = [];
  for (const p of catalogProducts.value) {
    if (normalizeShortageSearch(p.name).includes(q)) {
      const cat = p.categoryId ? categoryMap.value.get(p.categoryId) : undefined;
      const isSerial =
        p.tracking === 'serial_optional' ||
        p.tracking === 'serial_required' ||
        p.brandId !== null;
      const minQty = defaultMinQty(isSerial, cat?.kind ?? null);
      matches.push({
        id: p.id,
        name: p.name,
        categoryName: cat?.name ?? '',
        onHand: p.onHand,
        minQty,
      });
      if (matches.length >= 6) break;
    }
  }
  return matches;
});

const openItems = computed(() => items.value.filter((x) => x.status === 'open'));
const orderedItems = computed(() => items.value.filter((x) => x.status === 'ordered'));

const shownItems = computed(() => {
  if (statusFilter.value === 'open') return openItems.value;
  if (statusFilter.value === 'ordered') return orderedItems.value;
  return items.value;
});

function canDelete(item: ShortageEntry): boolean {
  if (!props.session) return true;
  return props.session.role === 'manager' || item.createdBy === props.session.userId;
}

async function refresh(): Promise<void> {
  try {
    const [ov, cat] = await Promise.all([
      shortagesOverview(),
      posCatalog().catch(() => null),
    ]);
    items.value = ov.items;
    suggestions.value = ov.suggestions;
    if (cat) {
      catalogProducts.value = cat.products;
      const map = new Map<string, { name: string; kind: string }>();
      for (const c of cat.categories) {
        map.set(c.id, { name: c.name, kind: c.kind });
      }
      categoryMap.value = map;
    }
    emit('changed', ov.items.length);
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

defineExpose({ refresh });

onMounted(() => {
  void refresh();
});

function onNameInput(): void {
  if (linkedProductId.value) {
    const p = linkedProduct.value;
    if (!p || draftName.value.trim() !== p.name) {
      linkedProductId.value = null;
    }
  }
}

function pickProduct(p: {
  id: string;
  name: string;
  onHand: number;
  minQty: number;
}): void {
  linkedProductId.value = p.id;
  draftName.value = p.name;
  draftQty.value = String(suggestedQty(p.onHand, p.minQty));
}

function unlinkProduct(): void {
  linkedProductId.value = null;
}

async function submitManualAdd(): Promise<void> {
  const name = draftName.value.trim();
  if (!name && !linkedProductId.value) {
    toast('اكتب اسم الصنف الأول', 'err');
    return;
  }
  const qty = Math.max(1, parseCount(draftQty.value) ?? 1);
  const { customerName, customerPhone } = parseWaitingCustomer(draftCust.value);
  busy.value = true;
  try {
    const outcome = await addShortage({
      productId: linkedProductId.value,
      name: name || (linkedProduct.value?.name ?? ''),
      qty,
      note: draftNote.value.trim() || null,
      customerName,
      customerPhone,
    });
    if (outcome.merged) {
      toast(
        `«${outcome.entry.name}» موجود في النواقص، زوّدنا الكمية المطلوبة لـ ${pcsWord(outcome.entry.qty)}`,
        'ok'
      );
    } else {
      toast(`اتضاف «${outcome.entry.name}» للنواقص (${pcsWord(outcome.entry.qty)})`, 'ok');
    }
    draftName.value = '';
    draftQty.value = '1';
    draftCust.value = '';
    draftNote.value = '';
    linkedProductId.value = null;
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function onAddSuggested(s: ShortageSuggestion): Promise<void> {
  busy.value = true;
  try {
    const outcome = await addShortage({
      productId: s.productId,
      name: s.name,
      qty: s.suggestedQty,
    });
    toast(`اتضاف «${outcome.entry.name}» للنواقص (${pcsWord(outcome.entry.qty)})`, 'ok');
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function onAddAllSuggested(): Promise<void> {
  if (suggestions.value.length === 0) return;
  busy.value = true;
  try {
    const added = await addAllSuggestedShortages();
    toast(`اتضافوا ${pcsWord(added.length)} للنواقص`, 'ok');
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function onToggleStatus(item: ShortageEntry, nextStatus: ShortageStatus): Promise<void> {
  busy.value = true;
  try {
    const updated = await setShortageStatus(item.id, nextStatus);
    if (nextStatus === 'ordered') {
      toast(`اتعلّم «${updated.name}» إنه اتطلب من المورد`, 'ok');
    }
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function onResolve(item: ShortageEntry): Promise<void> {
  busy.value = true;
  try {
    const resolved = await resolveShortage(item.id);
    toast(formatArrivedToast(resolved), 'ok');
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function onDelete(item: ShortageEntry): Promise<void> {
  busy.value = true;
  try {
    const deleted = await deleteShortage(item.id);
    toast(`اتشال «${deleted.name}» من النواقص`, 'ok');
    await refresh();
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="shortages-panel" data-shortages-panel>
    <div class="card pad sh-add-card" data-sh-add-card>
      <div class="card-h" style="padding: 0 0 var(--s-3) 0; border: 0">
        <h3>إضافة للنواقص</h3>
        <span class="muted">حاجة العميل سأل عليها ومش موجودة، أو صنف خلص وعايزين نجيبه</span>
      </div>
      <div class="sh-add-row">
        <div class="field" style="flex: 2; min-width: 220px">
          <label for="sh-name">الصنف</label>
          <div class="sh-pick">
            <input
              id="sh-name"
              v-model="draftName"
              data-sh-name-input
              autocomplete="off"
              placeholder="اكتب اسم الصنف، أو اختار من المخزن..."
              @input="onNameInput"
              @keydown.enter.prevent="submitManualAdd"
            />
            <span v-if="linkedProduct" class="sh-linked" data-sh-linked>
              من المخزن · الموجود {{ num(linkedProduct.onHand) }}
              <button
                type="button"
                data-sh-unlink
                title="إلغاء الربط"
                @click="unlinkProduct"
              >
                <Icon name="x" />
              </button>
            </span>
            <div v-if="!linkedProduct && matchingProducts.length > 0" class="sh-dd" data-sh-dd>
              <button
                v-for="p in matchingProducts"
                :key="p.id"
                type="button"
                class="sh-dd-item"
                :data-sh-pick-product="p.id"
                @click="pickProduct(p)"
              >
                <span class="n">
                  <bdi dir="auto">{{ p.name }}</bdi>
                  <small v-if="p.categoryName" class="muted">{{ p.categoryName }}</small>
                </span>
                <span
                  class="s"
                  :class="p.onHand === 0 ? 'bad' : p.onHand <= p.minQty ? 'warn' : ''"
                >
                  الموجود: <b class="num">{{ num(p.onHand) }}</b>
                </span>
              </button>
            </div>
          </div>
        </div>

        <div class="field" style="width: 110px">
          <label for="sh-qty">الكمية المطلوبة</label>
          <input
            id="sh-qty"
            v-model="draftQty"
            data-sh-qty-input
            class="num"
            @keydown.enter.prevent="submitManualAdd"
          />
        </div>

        <div class="field" style="flex: 1.3; min-width: 170px">
          <label for="sh-cust">عميل مستني <small class="muted">(اختياري)</small></label>
          <input
            id="sh-cust"
            v-model="draftCust"
            data-sh-cust-input
            placeholder="اسم أو رقم، لو حد سأل عليه"
            @keydown.enter.prevent="submitManualAdd"
          />
        </div>

        <div class="field" style="flex: 1.3; min-width: 170px">
          <label for="sh-note">ملاحظة <small class="muted">(اختياري)</small></label>
          <input
            id="sh-note"
            v-model="draftNote"
            data-sh-note-input
            placeholder="لون، مقاس، عميل مستعجل..."
            @keydown.enter.prevent="submitManualAdd"
          />
        </div>

        <button
          type="button"
          class="btn primary sh-add-btn"
          data-sh-add-submit
          :disabled="busy"
          @click="submitManualAdd"
        >
          <Icon name="plus" /> ضيف للنواقص
        </button>
      </div>
    </div>

    <div class="sh-grid">
      <div class="card" data-sh-list-card>
        <div class="card-h">
          <h3>
            قايمة النواقص
            <span class="muted">
              ({{
                items.length
                  ? `${num(openItems.length)} ناقص · ${num(orderedItems.length)} اتطلب`
                  : 'فاضية'
              }})
            </span>
          </h3>
          <div v-if="items.length > 0" class="pills">
            <button
              type="button"
              class="pill"
              :class="{ active: statusFilter === 'all' }"
              data-sh-filter="all"
              @click="statusFilter = 'all'"
            >
              الكل ({{ num(items.length) }})
            </button>
            <button
              type="button"
              class="pill"
              :class="{ active: statusFilter === 'open' }"
              data-sh-filter="open"
              @click="statusFilter = 'open'"
            >
              ناقص ({{ num(openItems.length) }})
            </button>
            <button
              type="button"
              class="pill"
              :class="{ active: statusFilter === 'ordered' }"
              data-sh-filter="ordered"
              @click="statusFilter = 'ordered'"
            >
              اتطلب ({{ num(orderedItems.length) }})
            </button>
          </div>
        </div>

        <div v-if="shownItems.length === 0" class="empty-state" data-sh-empty>
          <Icon name="clipboard-list" />
          <p>{{ items.length ? 'مفيش نواقص في الفلتر ده' : 'قايمة النواقص فاضية' }}</p>
          <small class="muted">
            أي صنف العميل سأل عليه ومش موجود، أو قرب يخلص، سجّله هنا عشان مايتنسيش وقت الشراء
          </small>
        </div>

        <div v-else class="sh-list" data-sh-list>
          <div
            v-for="item in shownItems"
            :key="item.id"
            class="sh-row"
            :class="{ ordered: item.status === 'ordered' }"
            :data-sh-row="item.id"
            :data-sh-status="item.status"
          >
            <div class="sh-main">
              <div class="sh-title">
                <b><bdi dir="auto">{{ item.name }}</bdi></b>
                <span class="tag" :class="item.productId ? 'info' : 'warn'">
                  {{ item.productId ? 'في المخزن' : 'صنف جديد' }}
                </span>
                <span v-if="item.onHand !== null" class="muted">
                  الموجود:
                  <b
                    class="num"
                    :class="{ 't-err': item.onHand === 0, 't-warn': item.onHand > 0 }"
                  >
                    {{ num(item.onHand) }}
                  </b>
                </span>
              </div>
              <div class="sh-meta">
                <span v-if="item.note" class="sh-note" data-sh-row-note>
                  <Icon name="file-text" /> {{ item.note }}
                </span>
                <span
                  v-if="item.customerName || item.customerPhone"
                  class="sh-cust"
                  data-sh-row-cust
                >
                  <Icon name="user" /> مستنيه: <b>{{ item.customerName || 'عميل' }}</b>
                  <template v-if="item.customerPhone">
                    · <span class="mono" dir="ltr">{{ dg(item.customerPhone) }}</span>
                  </template>
                </span>
                <span class="muted">
                  سجّله {{ item.createdByName || 'المالك' }} ·
                  {{ formatShortageWhen(item.createdAt) }}
                </span>
              </div>
            </div>

            <div class="sh-qty">
              <small class="muted">المطلوب</small>
              <b class="num" data-sh-row-qty>{{ pcsWord(item.qty) }}</b>
            </div>

            <div class="sh-actions">
              <button
                v-if="item.status === 'open'"
                type="button"
                class="btn sm"
                data-sh-status-toggle="ordered"
                title="علّم إنه اتطلب من المورد"
                :disabled="busy"
                @click="onToggleStatus(item, 'ordered')"
              >
                <Icon name="send" /> اتطلب
              </button>
              <button
                v-else
                type="button"
                class="btn sm ok-soft"
                data-sh-status-toggle="open"
                title="تم الطلب، اضغط لإلغاء العلامة"
                :disabled="busy"
                @click="onToggleStatus(item, 'open')"
              >
                <Icon name="check" /> اتطلب
              </button>
              <button
                type="button"
                class="btn sm primary"
                data-sh-resolve
                title="وصل المحل"
                :disabled="busy"
                @click="onResolve(item)"
              >
                <Icon name="package-plus" /> وصل
              </button>
              <button
                v-if="canDelete(item)"
                type="button"
                class="icon-btn sm danger"
                data-sh-delete
                title="حذف من النواقص"
                :disabled="busy"
                @click="onDelete(item)"
              >
                <Icon name="trash-2" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="card sh-suggest" data-sh-suggest-card>
        <div class="card-h">
          <div>
            <h3>مقترح من المخزن</h3>
            <span class="muted">أصناف خلصت أو وصلت لأقل حد ومش متسجلة في النواقص</span>
          </div>
          <button
            v-if="suggestions.length > 0"
            type="button"
            class="btn sm"
            data-sh-add-all-suggested
            :disabled="busy"
            @click="onAddAllSuggested"
          >
            <Icon name="plus" /> ضيف الكل ({{ num(suggestions.length) }})
          </button>
        </div>

        <div v-if="suggestions.length === 0" class="empty-state sm" data-sh-suggest-empty>
          <Icon name="check" />
          <p>مفيش أصناف تانية ناقصة في المخزن دلوقتي</p>
        </div>

        <div v-else class="sh-sug-list" data-sh-suggest-list>
          <div
            v-for="s in suggestions"
            :key="s.productId"
            class="sh-sug-row"
            :data-sh-suggest-row="s.productId"
          >
            <div class="sh-sug-info">
              <b><bdi dir="auto">{{ s.name }}</bdi></b>
              <small class="muted">
                {{ s.categoryName || 'بدون فئة' }} · أقل حد {{ num(s.minQty) }} · مقترح طلب
                {{ pcsWord(s.suggestedQty) }}
              </small>
            </div>
            <span class="tag" :class="s.onHand === 0 ? 'err' : 'warn'">
              {{ s.onHand === 0 ? 'خلصان' : `باقي ${num(s.onHand)}` }}
            </span>
            <button
              type="button"
              class="btn sm"
              data-sh-add-suggested
              :disabled="busy"
              @click="onAddSuggested(s)"
            >
              <Icon name="plus" /> ضيفه للنواقص
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
