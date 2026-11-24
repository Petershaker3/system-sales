<script setup lang="ts">
// «التصنيفات في شاشة البيع» (ADR-018 §1), as in the mockup's settings
// (docs/ui/mockup-v1/views/settings.js, `setCatalog`): the tree in the owner's
// order — rename by typing on the name, move with the arrows, show or hide with
// the switch, delete an empty one the owner made — and a form to add one, main
// or under a main. Every rule is the backend's; this card only asks.
import { computed, onMounted, ref } from 'vue';

import * as api from '../../api/categories';
import type { CategoryEntry, CategoryKind } from '../../api/categories';
import { describeError } from '../../api/errors';
import { countWord, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { beep, toast } from '../../ui/toast';
import { asIconName } from '../pos/icons';

const list = ref<CategoryEntry[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');

const newName = ref('');
/** '' for a main category, otherwise the main category it goes under. */
const newParent = ref('');
const newKind = ref<CategoryKind>('item');
const newIcon = ref<string>('tag');

const mains = computed(() => list.value.filter((c) => c.parentId === null));

function subsOf(id: string): CategoryEntry[] {
  return list.value.filter((c) => c.parentId === id);
}

/** Each main category followed by its sub-categories, with the siblings it moves among. */
const rows = computed(() =>
  mains.value.flatMap((main) => {
    const subs = subsOf(main.id);
    return [
      { c: main, at: mains.value.indexOf(main), of: mains.value.length },
      ...subs.map((sub, at) => ({ c: sub, at, of: subs.length })),
    ];
  })
);

/** The kind the form shows: a sub-category's is its parent's. */
const shownKind = computed<CategoryKind>(() => {
  if (newParent.value === '') return newKind.value;
  return list.value.find((c) => c.id === newParent.value)?.kind ?? 'item';
});

function itemsWord(n: number): string {
  return countWord(n, 'صنف', 'صنفين', 'أصناف');
}

/** A main category counts its sub-categories' products too, as on the sales screen. */
function countLabel(c: CategoryEntry): string {
  const n = c.parentId === null ? subsOf(c.id).reduce((sum, s) => sum + s.products, c.products) : c.products;
  return n > 0 ? itemsWord(n) : 'فاضي';
}

function iconOf(name: string) {
  return asIconName(name) ?? 'tag';
}

async function load(): Promise<void> {
  try {
    list.value = await api.listCategories();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
}

/** Ask the backend, show what it said, and read the list again either way. */
async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  try {
    await action();
    if (done !== '') toast(done, 'ok');
    return true;
  } catch (err) {
    toast(describeError(err), 'err');
    beep();
    return false;
  } finally {
    busy.value = false;
    await load();
  }
}

async function rename(c: CategoryEntry, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const name = input.value.trim();
  if (name === c.name) return;
  if (name === '') {
    input.value = c.name;
    toast('اسم التصنيف مايبقاش فاضي', 'err');
    beep();
    return;
  }
  const ok = await run(() => api.renameCategory(c.id, name), `«${c.name}» بقى «${name}»`);
  if (!ok) input.value = c.name;
}

function move(c: CategoryEntry, direction: 'up' | 'down'): void {
  void run(() => api.moveCategory(c.id, direction), '');
}

function setShown(c: CategoryEntry, event: Event): void {
  const shown = (event.target as HTMLInputElement).checked;
  void run(
    () => api.setCategoryHidden(c.id, !shown),
    shown ? `«${c.name}» هيظهر في شاشة البيع` : `«${c.name}» مش هيظهر في شاشة البيع، وأصنافه في «الكل» والبحث`
  );
}

function remove(c: CategoryEntry): void {
  void run(() => api.deleteCategory(c.id), `اتمسح التصنيف «${c.name}»`);
}

async function add(): Promise<void> {
  const name = newName.value.trim();
  if (name === '') return;
  const parent = newParent.value === '' ? null : newParent.value;
  const parentName = list.value.find((c) => c.id === parent)?.name;
  const ok = await run(
    () => api.createCategory({ name, parentId: parent, kind: parent === null ? newKind.value : null, icon: newIcon.value }),
    parentName === undefined ? `اتضاف «${name}»، وهيظهر في شاشة البيع` : `اتضاف «${name}» تحت «${parentName}»`
  );
  if (ok) {
    newName.value = '';
    newIcon.value = 'tag';
  }
}

onMounted(load);
</script>

<template>
  <section class="card categories-card">
    <h3><Icon name="tags" /> التصنيفات في شاشة البيع</h3>
    <div class="muted hint-line">
      «الأكثر مبيعًا» و«الكل» ثابتين في الأول. غيّر الاسم بالكتابة عليه، ورتّب بالأسهم، واقفل اللي مش عايزه يظهر.
    </div>
    <p v-if="!loaded" class="muted">لحظة…</p>
    <div v-else class="cat-list">
      <div v-for="r in rows" :key="r.c.id" class="cat-row" :class="{ sub: r.c.parentId !== null, off: r.c.hidden }">
        <span class="t-ico"><Icon :name="iconOf(r.c.icon)" /></span>
        <input
          :id="`cat-n-${r.c.id}`"
          class="cat-name"
          :value="r.c.name"
          aria-label="اسم التصنيف"
          autocomplete="off"
          :disabled="busy"
          @change="rename(r.c, $event)"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        />
        <span class="muted num cat-n">{{ countLabel(r.c) }}</span>
        <button
          type="button"
          class="icon-btn sm"
          title="لفوق"
          :aria-label="`«${r.c.name}» لفوق`"
          :disabled="busy || r.at === 0"
          @click="move(r.c, 'up')"
        >
          <Icon name="arrow-up" />
        </button>
        <button
          type="button"
          class="icon-btn sm"
          title="لتحت"
          :aria-label="`«${r.c.name}» لتحت`"
          :disabled="busy || r.at === r.of - 1"
          @click="move(r.c, 'down')"
        >
          <Icon name="arrow-down" />
        </button>
        <label class="switch" title="يظهر في شاشة البيع">
          <input
            type="checkbox"
            :checked="!r.c.hidden"
            :disabled="busy"
            :aria-label="`«${r.c.name}» يظهر في شاشة البيع`"
            @change="setShown(r.c, $event)"
          /><span></span>
        </label>
        <button
          v-if="r.c.deletable"
          type="button"
          class="icon-btn sm danger"
          title="امسح التصنيف"
          :aria-label="`امسح «${r.c.name}»`"
          :disabled="busy"
          @click="remove(r.c)"
        >
          <Icon name="trash-2" />
        </button>
        <span v-else class="cat-del-sp"></span>
      </div>
    </div>

    <form class="cat-add kinds" @submit.prevent="add">
      <div class="field">
        <label for="cat-new">تصنيف جديد</label>
        <input id="cat-new" v-model="newName" placeholder="مثلًا: خطوط، كروت شحن، قطع غيار" autocomplete="off" />
      </div>
      <div class="field">
        <label for="cat-parent">مكانه</label>
        <select id="cat-parent" v-model="newParent">
          <option value="">تصنيف رئيسي</option>
          <option v-for="m in mains" :key="m.id" :value="m.id">تحت «{{ m.name }}»</option>
        </select>
      </div>
      <div class="field">
        <label for="cat-kind">بيتسجّل إزاي</label>
        <select
          id="cat-kind"
          :value="shownKind"
          :disabled="newParent !== ''"
          :title="newParent !== '' ? 'زي التصنيف الرئيسي بتاعه' : undefined"
          @change="newKind = ($event.target as HTMLSelectElement).value as CategoryKind"
        >
          <option value="item">بالعدد، زي الإكسسوار</option>
          <option value="phone">جهاز جهاز بالـ IMEI</option>
          <option v-if="shownKind === 'used'" value="used">مستعمل</option>
        </select>
      </div>
      <button type="submit" class="btn soft" :disabled="busy || newName.trim() === ''">
        <Icon name="circle-plus" /> ضيف
      </button>
      <div class="icon-pick" role="radiogroup" aria-label="أيقونة التصنيف">
        <button
          v-for="ic in api.CATEGORY_ICONS"
          :key="ic"
          type="button"
          class="icon-btn sm"
          :class="{ on: newIcon === ic }"
          role="radio"
          :aria-checked="newIcon === ic"
          :title="ic"
          @click="newIcon = ic"
        >
          <Icon :name="iconOf(ic)" />
        </button>
      </div>
    </form>
    <p v-if="error" class="err-msg" role="alert">{{ error }}</p>
    <p v-if="loaded && list.length > 0" class="muted small total-line">
      {{ num(mains.length) }} رئيسي و{{ num(list.length - mains.length) }} فرعي
    </p>
  </section>
</template>

<style scoped>
.hint-line {
  font-size: 0.85rem;
  margin-bottom: 8px;
}
.cat-add.kinds {
  grid-template-columns: minmax(0, 1fr) 200px 200px auto;
}
.total-line {
  margin-top: 8px;
}
@media (max-width: 760px) {
  .cat-add.kinds {
    grid-template-columns: 1fr;
  }
}
</style>
