// «استبدال مستعمل» بقى بيتفتح من «الهواتف» (طلب صاحب المحل، 2026-11-05).
//
// الجهاز المستعمل بيتسجّل في المخزن من شاشة الهواتف، لكن قيمته بتتخصم من فاتورة
// البيع — والفاتورة دي مش موجودة على شاشة الهواتف. فالاستلام بيسيب «رصيد استبدال
// مستني» هنا، وشاشة البيع بتاخده أول ما تفتح وتحطه على الفاتورة اللي في إيد
// الكاشير، بنفس السطر اللي كان بيظهر لما الزرار كان في البيع (`#pos-tradein-row`).
//
// وحدة صغيرة ومقصودة: الشاشات بتتمسح وتتبني من جديد مع كل تنقّل (v-if في
// `AppShell`)، فأي حالة لازم تعدّي بينهم لازم تعيش بره الشاشتين.
import { ref } from 'vue';

export interface PendingTradeIn {
  readonly unitId: string;
  readonly productName: string;
  readonly imei: string;
  readonly conditionGrade: string;
  readonly creditMinor: number;
}

/** الرصيد المستني — واحد بس، لأن الاستبدال بيخص البيعة اللي جاية. */
export const pendingTradeIn = ref<PendingTradeIn | null>(null);

/** يستنى رصيد استبدال على فاتورة البيع الجاية. */
export function holdPendingTradeIn(value: PendingTradeIn): void {
  pendingTradeIn.value = value;
}

/** شاشة البيع بتاخد الرصيد مرة واحدة: بعد كده هو مسؤولية الفاتورة نفسها. */
export function takePendingTradeIn(): PendingTradeIn | null {
  const value = pendingTradeIn.value;
  pendingTradeIn.value = null;
  return value;
}

/** للاختبارات وللقراءة في «الهواتف» (عرض الرصيد المستني). */
export function peekPendingTradeIn(): PendingTradeIn | null {
  return pendingTradeIn.value;
}
