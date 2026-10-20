// All money and prices are integer paise. These helpers keep arithmetic in integers
// (BigInt for intermediate products) and round half away from zero only where a division is unavoidable.

export const RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Integer division of a/b rounded half away from zero, computed exactly with BigInt. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error('division by zero');
  const neg = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const q = (absA * 2n + absB) / (absB * 2n);
  return neg ? -q : q;
}

/**
 * Notional value in paise for `qtyG` grams at `pricePaise` per price unit (`unitGrams` grams).
 * Gold is quoted per 10 g (unitGrams=10), silver per kg (unitGrams=1000).
 */
export function notional(qtyG: number, pricePaise: number, unitGrams: number): number {
  return Number(divRound(BigInt(qtyG) * BigInt(pricePaise), BigInt(unitGrams)));
}

/** Gross P&L in paise. LONG profits when exit > entry, SHORT when exit < entry. */
export function pnl(direction: 'LONG' | 'SHORT', qtyG: number, entryPaise: number, exitPaise: number, unitGrams: number): number {
  const diff = BigInt(exitPaise - entryPaise) * (direction === 'LONG' ? 1n : -1n);
  return Number(divRound(diff * BigInt(qtyG), BigInt(unitGrams)));
}

/** Proportional share of `total` for `part` out of `whole` (used to release reservations on partial closes). */
export function proRata(total: number, part: number, whole: number): number {
  if (part === whole) return total;
  return Number(divRound(BigInt(total) * BigInt(part), BigInt(whole)));
}

export function formatPoints(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${(abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
