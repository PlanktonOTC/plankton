import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, query } from './api.js';

// Everything the terminal reads, polled from the PlanktonOTC API. Prices and limits refresh every few seconds; slower
// facts (the ledger, payout claims) less often. A failed poll keeps showing the last good data and flags the error.

const noRetryOn = (codes) => (count, err) => !(err instanceof ApiError && codes.includes(err.status)) && count < 1;

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => apiGet('/v1/config'), staleTime: 30_000, retry: noRetryOn([503]) });
export const useMarkets = () => useQuery({ queryKey: ['markets'], queryFn: () => apiGet('/v1/markets'), refetchInterval: 4_000 });
export const useCounter = () => useQuery({ queryKey: ['counter'], queryFn: () => apiGet('/v1/counter'), refetchInterval: 8_000, retry: noRetryOn([503]) });
export const useLedger = () => useQuery({ queryKey: ['ledger'], queryFn: () => apiGet('/v1/ledger'), refetchInterval: 15_000, retry: noRetryOn([503]) });

export const useAccountState = (address) =>
  useQuery({ queryKey: ['account-state', address], queryFn: () => apiGet(`/v1/accounts/${address}/state`), enabled: Boolean(address), refetchInterval: 5_000, placeholderData: keepPreviousData });

/** Orders and trade history come from the database. When none is configured the API answers 503 and the tables say so. */
export const useAccountHistory = (address) =>
  useQuery({ queryKey: ['account-history', address], queryFn: () => apiGet(`/v1/accounts/${address}`), enabled: Boolean(address), refetchInterval: 8_000, retry: noRetryOn([503]), placeholderData: keepPreviousData });

export const useClaims = (address) =>
  useQuery({ queryKey: ['claims', address], queryFn: () => apiGet(`/v1/accounts/${address}/claims`), enabled: Boolean(address), refetchInterval: 20_000, retry: noRetryOn([503]) });

export const useSources = (symbol, enabled) =>
  useQuery({ queryKey: ['sources', symbol], queryFn: () => apiGet(`/v1/markets/${symbol}/sources`), enabled: Boolean(symbol && enabled), staleTime: 3_000, retry: false });

/** The ticket's estimate: execution price, fee, liquidation. `params` is null while the form is incomplete. */
export const usePreview = (params) =>
  useQuery({
    queryKey: ['preview', params],
    queryFn: ({ signal }) => apiGet(`/v1/quote/preview${query(params)}`, { signal }),
    enabled: Boolean(params),
    placeholderData: keepPreviousData,
    staleTime: 2_000,
    refetchInterval: 6_000,
    retry: false,
  });

/** A value that follows `value` after it has stopped changing for `ms`. Keeps typing from firing a request per keystroke. */
export function useDebounced(value, ms = 350) {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}
