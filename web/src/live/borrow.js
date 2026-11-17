/** Estimate simple borrow charges from notional and the current on-chain hourly rate. */
export function borrowEstimate(notional, bpsPerHour, hours) {
  const n = Number(notional);
  const rate = Number(bpsPerHour);
  const duration = Number(hours);
  if (![n, rate, duration].every(Number.isFinite) || n <= 0 || rate < 0 || duration <= 0) return 0;
  return n * rate / 10_000 * duration;
}
