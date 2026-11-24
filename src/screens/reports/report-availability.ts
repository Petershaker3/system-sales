// Report totals must not masquerade as complete when a source failed or a
// bounded sales result may have omitted rows. `null` costs are unavailable,
// not zero. This guard does not establish that accounting formulas are correct.
export type SourceState = 'loading' | 'ready' | 'failed';
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
