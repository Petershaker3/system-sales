export type CancellationPartsCostInput =
  | { readonly ok: true; readonly amountMinor: number }
  | { readonly ok: false };

export function parseCancellationPartsCostInput(raw: string): CancellationPartsCostInput {
  const value = raw.trim();
  if (!value) return { ok: false };

  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return { ok: false };

  const amountMinor = Math.round(amount * 100);
  if (!Number.isSafeInteger(amountMinor)) return { ok: false };

  return { ok: true, amountMinor };
}
