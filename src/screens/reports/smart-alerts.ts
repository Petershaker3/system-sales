// Pure Smart Alerts & Daily WhatsApp Summary helpers (`docs/PLAN.md` §14 & §19,
// `ADR-036`: نواقص، وأصناف راكدة، وصيانة متأخرة فعلًا، وملخص يومي على واتساب).

import type { ProductUnit } from '../../api/inventory.ts';
import type { PosProduct } from '../../api/pos.ts';
import type { RepairTicket } from '../../api/repairs.ts';
import type { SaleHistoryEntry } from '../../api/sales.ts';
import type {
  ShortageEntry,
  ShortagesOverview,
  ShortageSuggestion,
} from '../../api/shortages.ts';
import { fmtDate, money, num, pcsWord } from '../../ui/format.ts';

export interface StagnantProductAlert {
  readonly productId: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly onHand: number;
  readonly lastSaleAt: number | null;
  readonly daysSinceLastSale: number | null;
  readonly frozenCostMinor: number;
  readonly frozenRetailMinor: number;
  readonly isSerializedPhone: boolean;
}

export interface OverdueRepairAlert {
  readonly ticket: RepairTicket;
  readonly kind: 'ready_unclaimed' | 'overdue_work';
  readonly ageHours: number;
  readonly ageDays: number;
  readonly reasonLabel: string;
  readonly remainingMinor: number;
}

export interface ShortageAlertsSummary {
  readonly openItems: readonly ShortageEntry[];
  readonly waitingCustomerItems: readonly ShortageEntry[];
  readonly orderedItems: readonly ShortageEntry[];
  readonly suggestions: readonly ShortageSuggestion[];
  readonly totalAttentionCount: number;
}

export interface SmartAlertsBundle {
  readonly shortages: ShortageAlertsSummary;
  readonly overdueRepairs: readonly OverdueRepairAlert[];
  readonly stagnantProducts: readonly StagnantProductAlert[];
  readonly totalStagnantCostMinor: number;
  readonly totalStagnantRetailMinor: number;
  readonly totalAlertCount: number;
}

export interface DailyWhatsAppSummaryInput {
  readonly shopName: string;
  readonly date: Date;
  readonly shiftNumber: number;
  readonly salesMinor: number;
  readonly invoicesCount: number;
  readonly goodsProfitMinor: number;
  readonly hardwareRevenueMinor: number;
  readonly softwareRevenueMinor: number;
  readonly walletFeesMinor: number;
  readonly expectedDrawerCashMinor: number;
  readonly alerts: SmartAlertsBundle;
}

/**
 * Identify stagnant products (`أصناف وأجهزة راكدة`) that are currently in stock (`onHand > 0`)
 * and have had zero sales within the last `stagnantWindowDays` days (default 30 days).
 */
export function computeStagnantProducts(
  posProducts: readonly PosProduct[],
  units: readonly ProductUnit[],
  salesHistory: readonly SaleHistoryEntry[],
  now: Date = new Date(),
  stagnantWindowDays = 30,
): StagnantProductAlert[] {
  const nowMs = now.getTime();
  const windowCutoffMs = nowMs - stagnantWindowDays * 86_400_000;

  // Map productId -> latest sale timestamp
  const lastSaleByProduct = new Map<string, number>();
  for (const s of salesHistory) {
    if (s.isCancelled) continue;
    for (const l of s.lines) {
      if (!l.productId) continue;
      const prev = lastSaleByProduct.get(l.productId);
      if (prev === undefined || s.occurredAt > prev) {
        lastSaleByProduct.set(l.productId, s.occurredAt);
      }
    }
  }

  // Sum exact unit costs per product for registered in-stock IMEI units
  const unitsByProduct = new Map<string, ProductUnit[]>();
  for (const u of units) {
    const arr = unitsByProduct.get(u.productId) ?? [];
    arr.push(u);
    unitsByProduct.set(u.productId, arr);
  }

  const out: StagnantProductAlert[] = [];
  for (const p of posProducts) {
    if (p.onHand <= 0) continue;
    const lastSaleAt = lastSaleByProduct.get(p.id) ?? null;

    // Sold within the last `stagnantWindowDays` days -> not stagnant
    if (lastSaleAt !== null && lastSaleAt >= windowCutoffMs) {
      continue;
    }
    // Also skip if PosProduct reports recent 30-day sales (`soldRecently > 0`) and no history entry overrides it
    if (lastSaleAt === null && p.soldRecently > 0) {
      continue;
    }

    const daysSinceLastSale =
      lastSaleAt !== null
        ? Math.max(1, Math.floor((nowMs - lastSaleAt) / 86_400_000))
        : null;

    const prodUnits = unitsByProduct.get(p.id) ?? [];
    const retailPriceMinor = p.salePriceMinor ?? 0;
    const frozenRetailMinor = retailPriceMinor * p.onHand;

    let frozenCostMinor = 0;
    if (prodUnits.length > 0) {
      const knownUnitsCost = prodUnits.reduce(
        (sum, u) => sum + (u.unitCostMinor ?? Math.round(retailPriceMinor * 0.82)),
        0,
      );
      const extraQty = Math.max(0, p.onHand - prodUnits.length);
      const fallbackUnitCost =
        prodUnits[0]?.unitCostMinor ?? Math.round(retailPriceMinor * 0.82);
      frozenCostMinor = knownUnitsCost + extraQty * fallbackUnitCost;
    } else {
      frozenCostMinor = Math.round(retailPriceMinor * 0.7) * p.onHand;
    }

    const isSerializedPhone =
      prodUnits.length > 0 ||
      p.tracking === 'serial_optional' ||
      p.tracking === 'serial_required';

    out.push({
      productId: p.id,
      name: p.name,
      categoryId: p.categoryId,
      onHand: p.onHand,
      lastSaleAt,
      daysSinceLastSale,
      frozenCostMinor,
      frozenRetailMinor,
      isSerializedPhone,
    });
  }

  return out.sort(
    (a, b) =>
      b.frozenCostMinor - a.frozenCostMinor ||
      b.frozenRetailMinor - a.frozenRetailMinor ||
      b.onHand - a.onHand,
  );
}

/**
 * Identify genuinely overdue repair tickets (`صيانة متأخرة فعلاً`):
 * 1. `ready_unclaimed`: ticket is `ready` for pickup for >= 24h and the customer hasn't claimed it yet.
 * 2. `overdue_work`: ticket is still in `received` / `diagnosing` / `waiting` for >= 48h (or promised today/yesterday and >= 24h old).
 */
export function computeOverdueRepairs(
  tickets: readonly RepairTicket[],
  nowMs: number = Date.now(),
): OverdueRepairAlert[] {
  const out: OverdueRepairAlert[] = [];
  for (const t of tickets) {
    if (t.status === 'delivered' || t.status === 'cancelled') continue;
    const ageMs = Math.max(0, nowMs - t.createdAt);
    const ageHours = Math.floor(ageMs / 3_600_000);
    const ageDays = Math.max(1, Math.floor(ageHours / 24));
    const remainingMinor = Math.max(
      0,
      (t.finalPriceMinor > 0 ? t.finalPriceMinor : t.estimatedPriceMinor) -
        t.depositMinor,
    );

    if (t.status === 'ready' && ageHours >= 24) {
      out.push({
        ticket: t,
        kind: 'ready_unclaimed',
        ageHours,
        ageDays,
        reasonLabel: `جاهز للاستلام من ${num(ageDays)} يوم والعميل مااستلمش`,
        remainingMinor,
      });
      continue;
    }

    const promisedSoon =
      t.dueLabel.includes('النهارده') ||
      t.dueLabel.includes('اليوم') ||
      t.dueLabel.includes('أمس') ||
      t.dueLabel.includes('بكره') ||
      t.dueLabel.includes('بكرة');

    if (
      (t.status === 'received' ||
        t.status === 'diagnosing' ||
        t.status === 'waiting') &&
      (ageHours >= 48 || (promisedSoon && ageHours >= 24))
    ) {
      const stageAr =
        t.status === 'waiting'
          ? 'مستني قطع غيار'
          : t.status === 'diagnosing'
            ? 'تحت الفحص'
            : 'مستلم';
      out.push({
        ticket: t,
        kind: 'overdue_work',
        ageHours,
        ageDays,
        reasonLabel: `متأخر من ${num(ageDays)} يوم (${stageAr} · الميعاد: ${t.dueLabel || 'غير محدد'})`,
        remainingMinor,
      });
    }
  }

  return out.sort((a, b) => b.ageHours - a.ageHours);
}

/**
 * Summarize shortages & reorder suggestions (`النواقص والعملاء المنتظرين`).
 */
export function computeShortageAlerts(
  overview: ShortagesOverview | null,
): ShortageAlertsSummary {
  if (!overview) {
    return {
      openItems: [],
      waitingCustomerItems: [],
      orderedItems: [],
      suggestions: [],
      totalAttentionCount: 0,
    };
  }
  const openItems = overview.items.filter((i) => i.status === 'open');
  const orderedItems = overview.items.filter((i) => i.status === 'ordered');
  const waitingCustomerItems = overview.items.filter(
    (i) => Boolean(i.customerName || i.customerPhone),
  );
  return {
    openItems,
    waitingCustomerItems,
    orderedItems,
    suggestions: overview.suggestions,
    totalAttentionCount: openItems.length + overview.suggestions.length,
  };
}

/**
 * Build the complete Smart Alerts bundle.
 */
export function buildSmartAlertsBundle(params: {
  readonly shortages: ShortagesOverview | null;
  readonly repairTickets: readonly RepairTicket[];
  readonly posProducts: readonly PosProduct[];
  readonly units: readonly ProductUnit[];
  readonly salesHistory: readonly SaleHistoryEntry[];
  readonly now?: Date;
}): SmartAlertsBundle {
  const now = params.now ?? new Date();
  const shortages = computeShortageAlerts(params.shortages);
  const overdueRepairs = computeOverdueRepairs(
    params.repairTickets,
    now.getTime(),
  );
  const stagnantProducts = computeStagnantProducts(
    params.posProducts,
    params.units,
    params.salesHistory,
    now,
  );
  const totalStagnantCostMinor = stagnantProducts.reduce(
    (sum, p) => sum + p.frozenCostMinor,
    0,
  );
  const totalStagnantRetailMinor = stagnantProducts.reduce(
    (sum, p) => sum + p.frozenRetailMinor,
    0,
  );
  const totalAlertCount =
    shortages.openItems.length +
    overdueRepairs.length +
    stagnantProducts.length;

  return {
    shortages,
    overdueRepairs,
    stagnantProducts,
    totalStagnantCostMinor,
    totalStagnantRetailMinor,
    totalAlertCount,
  };
}

/**
 * Format the structured Daily WhatsApp Summary message for the shop owner (`ملخص يومي على واتساب`).
 */
export function formatDailyWhatsAppSummary(
  input: DailyWhatsAppSummaryInput,
): string {
  const titleShop = input.shopName.trim() || 'المحل';
  const dateStr = fmtDate(input.date);
  const lines: string[] = [
    `📊 *ملخص يوم ${dateStr} — ${titleShop}*`,
    `• المبيعات: ${money(input.salesMinor)} (${num(input.invoicesCount)} فاتورة)`,
    `• ربح البضاعة: ${money(input.goodsProfitMinor)}`,
    `• فلوس الصيانة لوحدها: ${money(input.hardwareRevenueMinor)}`,
    `• فلوس السوفت وير لوحدها: ${money(input.softwareRevenueMinor)}`,
    `• عمولات المحافظ والخدمات: ${money(input.walletFeesMinor)}`,
    `• المفروض في الدرج (وردية #${num(input.shiftNumber)}): ${money(input.expectedDrawerCashMinor)}`,
  ];

  const { shortages, overdueRepairs, stagnantProducts, totalStagnantCostMinor } =
    input.alerts;
  lines.push('');
  lines.push('🔔 *التنبيهات الذكية:*');
  lines.push(
    `• النواقص: ${pcsWord(shortages.openItems.length)} مطلوبة${
      shortages.waitingCustomerItems.length > 0
        ? ` (منهم ${num(shortages.waitingCustomerItems.length)} ليهم عميل منتظر)`
        : ''
    }`,
  );
  lines.push(
    `• صيانة متأخرة: ${num(overdueRepairs.length)} تذكرة${
      overdueRepairs.length > 0 && overdueRepairs[0]
        ? ` (أقدمها ${overdueRepairs[0].ticket.ticketNo} — ${overdueRepairs[0].ticket.deviceName})`
        : ''
    }`,
  );
  lines.push(
    `• أصناف راكدة (+30 يوم): ${num(stagnantProducts.length)} صنف (رأس مال مجمد ${money(totalStagnantCostMinor)})`,
  );

  return lines.join('\n');
}
