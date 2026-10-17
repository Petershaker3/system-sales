<script setup lang="ts">
// «شركات الموبايلات» (ADR-018 §2), as in the mockup's settings
// (docs/ui/mockup-v1/views/settings.js, `setBrands`): the companies in the
// owner's order — rename by typing on the name, touch / keypad / both, move
// with the arrows, show or hide in «موبايل جديد», delete one he added that has
// no phone — and a form to add one. Every rule is the backend's.
import { computed, onMounted, ref } from 'vue';

import * as api from '../../api/brands';
import type { BrandDeviceType, BrandEntry } from '../../api/brands';
import { describeError } from '../../api/errors';
import { countWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { beep, toast } from '../../ui/toast';

const TYPES: readonly (readonly [BrandDeviceType, string])[] = [
  ['touch', 'تاتش'],
  ['keypad', 'زراير'],
  ['both', 'الاتنين'],
];

const list = ref<BrandEntry[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');
const newName = ref('');
const newType = ref<BrandDeviceType>('touch');

const count = computed(() => list.value.length);

function modelsWord(n: number): string {
  return n > 0 ? countWord(n, 'موديل', 'موديلين', 'موديلات') : 'مفيش موديلات';
}

async function load(): Promise<void> {
  try {
    list.value = await api.listBrands();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
}

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

async function rename(b: BrandEntry, event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const name = input.value.trim();
  if (name === b.name) return;
  if (name === '') {
    input.value = b.name;
    toast('اسم الشركة مايبقاش فاضي', 'err');
    beep();
    return;
  }
  const ok = await run(() => api.renameBrand(b.id, name), `«${b.name}» بقت «${name}»`);
  if (!ok) input.value = b.name;
}

function setType(b: BrandEntry, event: Event): void {
  const type = (event.target as HTMLSelectElement).value as BrandDeviceType;
  void run(() => api.setBrandType(b.id, type), '');
}

function setShown(b: BrandEntry, event: Event): void {
  const shown = (event.target as HTMLInputElement).checked;
  void run(
    () => api.setBrandHidden(b.id, !shown),
    shown ? `«${b.name}» هتظهر في «موبايل جديد»` : `«${b.name}» مش هتظهر في «موبايل جديد»، وموبايلاتها بتتباع عادي`
  );
}

function move(b: BrandEntry, direction: 'up' | 'down'): void {
  void run(() => api.moveBrand(b.id, direction), '');
}

function remove(b: BrandEntry): void {
  void run(() => api.deleteBrand(b.id), `اتمسحت «${b.name}»`);
}

async function add(): Promise<void> {
  const name = newName.value.trim();
  if (name === '') return;
  const ok = await run(() => api.createBrand(name, newType.value), `اتضافت «${name}»، وهتظهر في «موبايل جديد»`);
  if (ok) newName.value = '';
}

onMounted(load);
</script>

<template>
  <section class="card brands-card">
    <h3><Icon name="smartphone" /> شركات الموبايلات</h3>
    <div class="muted hint-line">
      بتظهر في «موبايل جديد»، وزراير الشركات تحت «موبايلات» في البيع. «زراير» يعني موبايل من غير رام ومساحة.
    </div>
    <p v-if="!loaded" class="muted">لحظة…</p>
    <div v-else class="cat-list">
      <div v-for="(b, at) in list" :key="b.id" class="cat-row br-row" :class="{ off: b.hidden }">
        <input
          :id="`br-n-${b.id}`"
          class="cat-name"
          :value="b.name"
          aria-label="اسم الشركة"
          autocomplete="off"
          :disabled="busy"
          @change="rename(b, $event)"
          @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
        />
        <select class="br-type" :value="b.deviceType" :aria-label="`نوع موبايلات «${b.name}»`" :disabled="busy" @change="setType(b, $event)">
          <option v-for="[v, l] in TYPES" :key="v" :value="v">{{ l }}</option>
        </select>
        <span class="muted num cat-n">{{ modelsWord(b.products) }}</span>
        <button
          type="button"
          class="icon-btn sm"
          title="لفوق"
          :aria-label="`«${b.name}» لفوق`"
          :disabled="busy || at === 0"
          @click="move(b, 'up')"
        >
          <Icon name="arrow-up" />
        </button>
        <button
          type="button"
          class="icon-btn sm"
          title="لتحت"
          :aria-label="`«${b.name}» لتحت`"
          :disabled="busy || at === count - 1"
          @click="move(b, 'down')"
        >
          <Icon name="arrow-down" />
        </button>
        <label class="switch" title="تظهر في «موبايل جديد»">
          <input
            type="checkbox"
            :checked="!b.hidden"
            :disabled="busy"
            :aria-label="`«${b.name}» تظهر في «موبايل جديد»`"
            @change="setShown(b, $event)"
          /><span></span>
        </label>
        <button
          v-if="b.deletable"
          type="button"
          class="icon-btn sm danger"
          title="امسح الشركة"
          :aria-label="`امسح «${b.name}»`"
          :disabled="busy"
          @click="remove(b)"
        >
          <Icon name="trash-2" />
        </button>
        <span v-else class="cat-del-sp"></span>
      </div>
    </div>
    <form class="cat-add br-add" @submit.prevent="add">
      <div class="field">
        <label for="br-new">شركة جديدة</label>
        <input id="br-new" v-model="newName" placeholder="مثلًا: Motorola" autocomplete="off" />
      </div>
      <div class="field">
        <label for="br-type-new">نوعها</label>
        <select id="br-type-new" v-model="newType">
          <option v-for="[v, l] in TYPES" :key="v" :value="v">{{ l }}</option>
        </select>
      </div>
      <button type="submit" class="btn soft" :disabled="busy || newName.trim() === ''">
        <Icon name="circle-plus" /> ضيف
      </button>
    </form>
    <p v-if="error" class="err-msg" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.hint-line {
  font-size: 0.85rem;
  margin-bottom: 8px;
}
/* The mockup's row: name, type, count, two arrows, the switch, delete. */
.br-row {
  grid-template-columns: minmax(0, 1fr) 110px auto auto auto auto 32px;
}
.br-type {
  height: 36px;
}
.cat-add.br-add {
  grid-template-columns: minmax(0, 1fr) 160px auto;
}
@media (max-width: 760px) {
  .cat-add.br-add {
    grid-template-columns: 1fr;
  }
}
</style>
