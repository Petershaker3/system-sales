import test from 'node:test';
import assert from 'node:assert/strict';
import type { RepairTicket } from '../../api/repairs.ts';
import {
  buildRepairWhatsAppUrl,
  filterRepairTickets,
  nextKanbanStatus,
  payMethodLabel,
  repairPeriodRange,
  serviceKindLabel,
} from './repairs.ts';

function sampleTicket(overrides: Partial<RepairTicket> = {}): RepairTicket {
  return {
    id: 'rep-1',
    ticketNo: 'R-1091',
    serviceKind: 'hardware',
    customerName: 'أحمد عبد العزيز',
    customerPhone: '01012345678',
    deviceName: 'سامسونج A54',
    imei: '356789012345678',
    deviceLock: 'رمز 2580',
    issue: 'تغيير شاشة أصلية',
    accessories: 'جراب + شريحة',
    dueLabel: 'النهارده',
    status: 'received',
    estimatedPriceMinor: 320000,
    finalPriceMinor: 0,
    partsCostMinor: 210000,
    netProfitMinor: 0,
    depositMinor: 50000,
    collectedMinor: 50000,
    remainingMinor: 270000,
    payMethod: 'cash',
    technicianName: 'م. حسن',
    warrantyDays: 30,
    note: '',
    createdBy: 'u1',
    createdByName: 'بيتر',
    createdAt: 1_760_780_000_000,
    deliveredAt: null,
    ...overrides,
  };
}

test('nextKanbanStatus advances through open Kanban stages only', () => {
  assert.equal(nextKanbanStatus('received'), 'diagnosing');
  assert.equal(nextKanbanStatus('diagnosing'), 'waiting');
  assert.equal(nextKanbanStatus('waiting'), 'ready');
  assert.equal(nextKanbanStatus('ready'), null);
  assert.equal(nextKanbanStatus('delivered'), null);
});

test('filterRepairTickets separates hardware and software tracks and filters by technician and Arabic query', () => {
  const tickets: RepairTicket[] = [
    sampleTicket({
      id: 'rep-1',
      ticketNo: 'R-1091',
      serviceKind: 'hardware',
      deviceName: 'سامسونج A54',
      issue: 'تغيير شاشة أصلية',
      technicianName: 'م. حسن',
    }),
    sampleTicket({
      id: 'rep-2',
      ticketNo: 'R-1092',
      serviceKind: 'software',
      customerName: 'كريم سامي',
      deviceName: 'شاومي ريدمي نوت 13',
      issue: 'تخطي حساب جوجل FRP وتفليش',
      technicianName: 'يوسف',
    }),
  ];

  assert.equal(filterRepairTickets(tickets, '', 'all', 'all').length, 2);
  assert.deepEqual(
    filterRepairTickets(tickets, '', 'hardware', 'all').map((t) => t.id),
    ['rep-1']
  );
  assert.deepEqual(
    filterRepairTickets(tickets, '', 'software', 'all').map((t) => t.id),
    ['rep-2']
  );
  assert.deepEqual(
    filterRepairTickets(tickets, '', 'all', 'يوسف').map((t) => t.id),
    ['rep-2']
  );
  assert.deepEqual(
    filterRepairTickets(tickets, 'شاشه اصليه', 'all', 'all').map((t) => t.id),
    ['rep-1']
  );
});

test('buildRepairWhatsAppUrl generates intake, ready, and delivered WhatsApp links', () => {
  const readyTicket = sampleTicket({ status: 'ready' });
  const readyUrl = buildRepairWhatsAppUrl(readyTicket, 'محل النور', 'ready');
  assert.ok(readyUrl && readyUrl.startsWith('https://wa.me/201012345678?text='));
  const decoded = decodeURIComponent(readyUrl!.split('text=')[1] ?? '');
  assert.ok(decoded.includes('جاهز للاستلام'));
  assert.ok(decoded.includes('2700 ج.م'));

  const swDelivered = sampleTicket({
    serviceKind: 'software',
    status: 'delivered',
    finalPriceMinor: 25000,
    depositMinor: 0,
    warrantyDays: 7,
  });
  const delivUrl = buildRepairWhatsAppUrl(swDelivered, 'محل النور', 'delivered');
  assert.ok(delivUrl);
  const delivDecoded = decodeURIComponent(delivUrl!.split('text=')[1] ?? '');
  assert.ok(delivDecoded.includes('السوفت وير'));
  assert.ok(delivDecoded.includes('250 ج.م'));
});

test('repairPeriodRange returns null bounds for all and valid millisecond windows for today/week/month', () => {
  const all = repairPeriodRange('all', 1_760_780_000_000);
  assert.equal(all.fromTs, null);
  assert.equal(all.toTs, null);

  const today = repairPeriodRange('today', 1_760_780_000_000);
  assert.ok(today.fromTs !== null && today.toTs !== null);
  assert.ok(today.toTs! > today.fromTs!);

  assert.equal(serviceKindLabel('hardware'), 'صيانة هاردوير');
  assert.equal(serviceKindLabel('software'), 'سوفت وير');
  assert.equal(payMethodLabel('vf'), 'فودافون كاش');
});
