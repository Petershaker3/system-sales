// Report totals must not masquerade as complete when a source failed or a
// bounded sales result may have omitted rows. `null` costs are unavailable,
// not zero. This guard does not establish that accounting formulas are correct.
export type SourceState = 'loading' | 'ready' | 'failed';

/** A half-open window covering every period used by a displayed report. */
export interface ReportWindow { readonly from: number; readonly to: number }
export interface ReportHistoryEvidence {
  readonly occurredAt: number;
  readonly isCancelled: boolean;
  readonly alreadyRefundedMinor: number;
  readonly returnCount?: number | null | undefined;
}

/** A later reversal can change the legacy representation of an earlier sale. */
export function affectedHistoryInWindow(history: readonly ReportHistoryEvidence[], window: ReportWindow): boolean {
  return history.some(s => s.returnCount == null ||
    (s.occurredAt >= window.from && s.occurredAt < window.to &&
      (s.isCancelled || s.alreadyRefundedMinor > 0 || s.returnCount > 0)));
}

/** Event totals cover actual event times, even when the original sale is outside the window. */
export async function reportWindowHasReversals(
  window: ReportWindow,
  load: (from: number, to: number) => Promise<{ readonly returnCount: number; readonly cancellationCount: number }>,
): Promise<boolean> {
  const events = await load(window.from, window.to);
  if (!Number.isSafeInteger(events.returnCount) || events.returnCount < 0 ||
      !Number.isSafeInteger(events.cancellationCount) || events.cancellationCount < 0) {
    throw new Error('SALES_REPORT_UNSAFE_OR_MISSING_DATA');
  }
  return events.returnCount > 0 || events.cancellationCount > 0;
}
export interface ReportAvailabilityInput {
  base: SourceState;
  auxiliary: SourceState;
  historyLength: number;
  historyLimit: number;
  salesCostsAvailable: boolean;
  hasReturnsOrCancellations: boolean;
  repairHardwareProfit: number | null | undefined;
  repairSoftwareProfit: number | null | undefined;
}
export function reportAvailability(input: ReportAvailabilityInput): 'loading' | 'incomplete' | 'ready' {
  if (input.base === 'loading' || input.auxiliary === 'loading') return 'loading';
  if (input.base !== 'ready' || input.auxiliary !== 'ready' || input.historyLength >= input.historyLimit || !input.salesCostsAvailable || input.hasReturnsOrCancellations ||
      input.repairHardwareProfit == null || input.repairSoftwareProfit == null) return 'incomplete';
  return 'ready';
}

export interface ReportSourceError { readonly source: string; readonly cause: unknown }
export async function reportSource<T>(source: string, request: Promise<T>): Promise<T> {
  try { return await request; } catch (cause) { throw { source, cause } satisfies ReportSourceError; }
}
export function sourceErrorParts(error: unknown): ReportSourceError {
  if (typeof error === 'object' && error !== null && 'source' in error && typeof error.source === 'string' && 'cause' in error) {
    return { source: error.source, cause: error.cause };
  }
  return { source: 'التقرير', cause: error };
}
