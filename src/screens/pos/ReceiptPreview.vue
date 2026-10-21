<script setup lang="ts">
// Arabic receipt preview (`docs/ui/mockup-v1/pos.js` `receiptHTML`, `ADR-022`).
// Used in «تم البيع» (PayModal) and in Settings («بيانات المحل» & «الإيصال والواتساب»).
import { appearance, shopLogo } from '../../ui/appearance';
import { dg, fmtDate, fmtTime, money, monthsTxt, num } from '../../ui/format';
import { methodLabel } from './payments';
import { addMonthsDate, type ReceiptData } from './receipt';

defineProps<{
  sale: ReceiptData;
}>();
</script>

<template>
  <div
    class="receipt"
    :class="{ w58: appearance.receiptPaper === '58' }"
    data-receipt-preview
  >
    <div class="c">
      <div v-if="shopLogo" class="rc-logo">
        <img :src="shopLogo" alt="" />
      </div>
      <div class="rc-name">{{ appearance.shopName }}</div>
      <div v-if="appearance.shopAddress" class="s">{{ appearance.shopAddress }}</div>
      <div v-if="appearance.shopPhone" class="s">
        تليفون: <bdi dir="ltr">{{ appearance.shopPhone }}</bdi>
      </div>
    </div>
    <hr />
    <div class="r s">
      <span>فاتورة رقم <bdi dir="ltr">{{ dg(sale.reference) }}</bdi></span>
      <span>{{ fmtDate(sale.occurredAt) }} الساعة {{ fmtTime(sale.occurredAt) }}</span>
    </div>
    <div class="r s">
      <span>البيّاع: {{ sale.sellerName }}</span>
      <span>{{ sale.customerName ? `العميل: ${sale.customerName}` : 'عميل نقدي' }}</span>
    </div>
    <hr />
    <div
      v-for="(line, idx) in sale.lines"
      :key="idx"
      class="it"
      data-receipt-line
    >
      <div class="r">
        <span>
          <bdi dir="rtl">{{ line.name }}</bdi>
          <bdi v-if="line.quantity > 1" dir="ltr"> ×{{ num(line.quantity) }}</bdi>
        </span>
        <span class="num">{{ money(line.lineTotalMinor) }}</span>
      </div>
      <div v-if="(line.discountMinor ?? 0) > 0" class="r s">
        <span>خصم على الصنف</span>
        <span class="num">− {{ money(line.discountMinor ?? 0) }}</span>
      </div>
      <div v-if="line.imei" class="s">
        IMEI: <bdi dir="ltr">{{ line.imei }}</bdi>
      </div>
      <div v-if="line.warrantyMonths && line.warrantyMonths > 0" class="s">
        ضمان {{ monthsTxt(line.warrantyMonths) }} لحد {{ fmtDate(addMonthsDate(sale.occurredAt, line.warrantyMonths)) }}
      </div>
      <div v-else-if="line.warrantyEnd" class="s">
        ضمان لحد {{ line.warrantyEnd }}
      </div>
    </div>
    <hr />
    <div class="r">
      <span>الإجمالي</span>
      <span class="num">{{ money(sale.grossSubtotalMinor) }}</span>
    </div>
    <div v-if="sale.discountMinor > 0" class="r">
      <span>خصم</span>
      <span class="num">− {{ money(sale.discountMinor) }}</span>
    </div>
    <div class="r tot">
      <span>المطلوب</span>
      <span class="num">{{ money(sale.totalMinor) }}</span>
    </div>
    <div
      v-for="(p, pIdx) in sale.payments"
      :key="pIdx"
      class="r s"
    >
      <span>{{ methodLabel(p.method, p.reference) }}</span>
      <span class="num">{{ money(p.amountMinor) }}</span>
    </div>
    <div v-if="sale.changeMinor > 0" class="r s">
      <span>الباقي للعميل</span>
      <span class="num">{{ money(sale.changeMinor) }}</span>
    </div>
    <hr />
    <div class="rc-foot">
      <div class="s">{{ appearance.receiptFooter }}</div>
    </div>
  </div>
</template>
