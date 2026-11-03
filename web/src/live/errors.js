// Turns every failure a trader can meet into one plain sentence. Wallet errors, API refusals and contract reverts arrive in
// very different shapes; the screen should never show "execution reverted: 0x8baa579f".

const REVERTS = {
  Expired: 'The price quote expired before the transaction was sent. Try again for a fresh quote.',
  QuoteExpired: 'The price quote expired before the transaction was sent. Try again for a fresh quote.',
  LeverageTooHigh: 'That leverage is above the maximum for this market right now. Add margin or lower the leverage.',
  ExecDeviation: 'The fill price would be too far from the mark. Try a smaller size.',
  LowConfidence: 'The two price sources disagree too much to open a position right now.',
  BreakerSet: 'A price circuit-breaker is active. New positions are stopped.',
  SessionClosed: 'New positions cannot be opened in the current market state. Existing positions can still be closed.',
  Deleveraging: 'The Counter is deleveraging. New positions are stopped until withdrawals clear.',
  PositionTooLarge: 'That is above the single-position limit for this market.',
  WalletLimit: 'That is above the per-wallet allowance for the current market state.',
  GrossCap: 'The Counter has no room left in this market.',
  SkewCap: 'The Counter has no room left on that side of this market.',
  TotalNetCap: 'The Counter has no room left for more net exposure.',
  MarginRequired: 'Enter a margin above zero.',
  NotClaimable: 'This payout is not claimable yet.',
  OrderNotActive: 'That order has expired or no longer applies to this position.',
  DepositsAreFrozen: 'Counter deposits are paused.',
  InsufficientCash: 'The Counter does not have enough free cash for that right now.',
  StaleSequence: 'The market price moved on while you were confirming. Try again.',
  SequenceGap: 'The market price moved on while you were confirming. Try again.',
  Slippage: 'The price moved too far from the quote. Try again.',
  NonceUsed: 'This quote or order was already used.',
  BadSigner: 'The signature was not accepted. Reconnect your wallet and try again.',
  InsufficientCollateral: 'Not enough deposited USDG. Deposit more and try again.',
  NoPosition: 'You have no open position in this market.',
  NotReducing: 'That order would not reduce your position.',
  TriggerNotMet: 'The trigger price has not been reached.',
  SameBlockReduce: 'A position cannot be reduced in the same moment it was opened. Wait a few seconds.',
  TooSmall: 'That amount is below the minimum.',
  ZeroAmount: 'Enter an amount above zero.',
  NoMark: 'This market has no price yet.',
  StaleMark: 'The market price is too old to trade against right now.',
};

const API_CODES = {
  no_mark: 'This market has no price yet.',
  stale_mark: 'The market price is too old to open a position right now.',
  low_confidence: 'The two price sources disagree too much to open a position right now.',
  session_closed: 'New positions cannot be opened in the current market state. Existing positions can still be closed.',
  market_not_active: 'This market is close-only or paused. You can still close a position.',
  breaker_set: 'A price circuit-breaker is active. New positions are stopped.',
  deleveraging: 'The Counter is deleveraging. New positions are stopped until withdrawals clear.',
  leverage_exceeded: 'That leverage is above the maximum for this market right now. Add margin or lower the leverage.',
  position_too_large: 'That is above the single-position limit for this market.',
  wallet_limit: 'That is above the per-wallet allowance for the current market state.',
  no_capacity: 'The Counter has no room left on that side of this market.',
  exec_deviation: 'The fill price would be too far from the mark. Try a smaller size.',
  margin_required: 'Enter a margin above zero.',
  zero_size: 'Enter a size above zero.',
  no_position: 'You have no open position in this market.',
  quote_service_unavailable: 'The quote service is unavailable. If you have a position, you can still close it at the on-chain mark.',
};

/** Name of the custom error a contract call reverted with, when the wallet or node reports it. */
export function revertName(err) {
  const names = Object.keys(REVERTS);
  for (let e = err; e; e = e.cause) {
    if (e.data?.errorName) return e.data.errorName;
    if (e.errorName) return e.errorName;
    const text = String(e.message ?? '');
    const found = names.find((n) => new RegExp(`\\b${n}\\b`).test(text));
    if (found) return found;
  }
  return null;
}

export function isUserRejection(err) {
  for (let e = err; e; e = e.cause) {
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') return true;
    if (/user (rejected|denied)|rejected the request|request rejected|denied transaction/i.test(String(e.message ?? ''))) return true;
  }
  return false;
}

export function friendlyError(err) {
  if (!err) return 'Something went wrong. Please try again.';
  if (isUserRejection(err)) return 'Cancelled in your wallet. Nothing was sent.';
  if (err.name === 'ApiError') {
    const code = err.body?.code ?? err.body?.error;
    if (err.status === 0) return err.message;
    if (code && API_CODES[code]) return API_CODES[code];
    if (err.status === 429) return 'Too many requests. Wait a moment and try again.';
    if (err.status === 503) return err.message.includes('not deployed') ? 'The exchange contracts are not deployed on this network yet.' : API_CODES[err.message] ?? 'The service is temporarily unavailable. Try again shortly.';
    if (err.body?.message) return String(err.body.message);
    return err.message;
  }
  const name = revertName(err);
  if (name && REVERTS[name]) return REVERTS[name];
  if (/insufficient funds/i.test(String(err.message))) return 'Your wallet does not have enough gas (ETH) to send this transaction.';
  // The local test chain copies state from a public RPC that keeps only about an hour of history; after that, reads fail like this.
  if (/historical state|failed to get storage|state is not available/i.test(String(err.message))) return 'The test chain has lost the copy of live state it needs (it only lasts about an hour). Rebuild it with scripts/fork-up.ps1.';
  // viem puts the reason on the line after "reverted with the following reason:", so keep two lines, not one.
  const short = String(err.shortMessage ?? err.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ');
  return short.length > 160 ? `${short.slice(0, 157)}…` : short || 'Something went wrong. Please try again.';
}

export { API_CODES, REVERTS };
