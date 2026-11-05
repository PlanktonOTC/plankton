import { useCallback, useMemo, useRef, useState } from 'react';
import { useConnect, useConnection, useDisconnect, usePublicClient, useSignMessage, useSignTypedData, useSwitchChain, useWriteContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost } from './api.js';
import { CHAIN_ID } from './env.js';
import { friendlyError } from './errors.js';

/** The connected wallet, the available wallets, and connect / disconnect / switch-network actions. */
export function useWallet() {
  const conn = useConnection();
  const { connectAsync, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  // Two entries can describe one wallet (an announced MetaMask and the generic injected connector): keep one per name.
  const choices = useMemo(() => {
    const seen = new Set();
    const hasInjected = typeof window !== 'undefined' && Boolean(window.ethereum);
    return connectors.filter((c) => {
      // The generic "Injected" fallback can only fail when no wallet put itself on the page.
      if (c.id === 'injected' && !hasInjected) return false;
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [connectors]);
  return {
    address: conn.address,
    isConnected: conn.isConnected,
    walletChainId: conn.chainId,
    wrongNetwork: conn.isConnected && conn.chainId !== CHAIN_ID,
    connectorName: conn.connector?.name,
    choices,
    connecting,
    switching,
    connectError,
    connect: (connector) => connectAsync({ connector }),
    disconnect: () => disconnectAsync(),
    switchNetwork: () => switchChainAsync({ chainId: CHAIN_ID }),
  };
}

const REFRESH = [['account-state'], ['account-history'], ['markets'], ['counter'], ['ledger'], ['claims'], ['preview']];

/**
 * Runs wallet actions. `ctx` gives the flows in trade.js the wallet's signing and sending, with a 25% gas margin (the
 * backend does the same: nested library calls make plain estimates run short on this chain).
 *
 *   const { busy, step, run } = useTrader(config);
 *   const result = await run((ctx) => openTrade(ctx, {...}));   // { ok, hash } or { ok: false, message }
 */
export function useTrader(config) {
  const { address, isConnected, chainId: walletChainId, connector } = useConnection();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const switchNetwork = useCallback(() => switchChainAsync({ chainId: CHAIN_ID }), [switchChainAsync]);
  const publicClient = usePublicClient();
  const { signTypedDataAsync } = useSignTypedData();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(null);
  const [hash, setHash] = useState(null);
  const lock = useRef(false);

  const run = useCallback(
    async (work) => {
      if (lock.current) return { ok: false, message: 'Another action is still in progress.' };
      if (!isConnected || !address) return { ok: false, message: 'Connect a wallet first.' };
      if (!config?.contracts) return { ok: false, message: 'The exchange contracts are not available yet.' };
      // Wagmi can retain a connection after an injected wallet silently signs out. That leaves a connector-shaped
      // object in state without the methods its write hooks need, producing the opaque
      // "connector.getChainId is not a function" error. Clear that unusable session before signing anything.
      if (typeof connector?.getChainId !== 'function') {
        await disconnectAsync().catch(() => {});
        return { ok: false, message: 'Your wallet session went stale. Reconnect your wallet, then try again.' };
      }
      lock.current = true;
      setBusy(true);
      setStep('wallet');
      setHash(null);
      try {
        if (walletChainId !== CHAIN_ID) {
          setStep('network');
          await switchNetwork();
        }
        const ctx = {
          address,
          chainId: CHAIN_ID,
          contracts: config.contracts,
          api: { get: apiGet, post: apiPost, del: apiDelete },
          signTypedData: (typed) => signTypedDataAsync(typed),
          signMessage: (message) => signMessageAsync({ message }),
          sendTx: async (call) => {
            const gas = await publicClient.estimateContractGas({ ...call, account: address });
            return writeContractAsync({ ...call, gas: (gas * 125n) / 100n });
          },
          waitForReceipt: async (txHash) => {
            const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
            if (receipt.status !== 'success') throw new Error('The transaction was reverted on-chain.');
            return receipt;
          },
          onStep: (name, detail) => {
            setStep(name);
            if (name === 'confirming' || name === 'done') setHash(detail);
          },
        };
        const result = await work(ctx);
        await Promise.all(REFRESH.map((key) => queryClient.invalidateQueries({ queryKey: key })));
        return { ok: true, result, hash: typeof result === 'string' ? result : null };
      } catch (err) {
        if (/connector\.getChainId is not a function/.test(String(err?.message ?? err))) {
          await disconnectAsync().catch(() => {});
          return { ok: false, message: 'Your wallet session went stale. Reconnect your wallet, then try again.', error: err };
        }
        return { ok: false, message: friendlyError(err), error: err };
      } finally {
        lock.current = false;
        setBusy(false);
        setStep(null);
      }
    },
    [address, isConnected, walletChainId, connector, disconnectAsync, config, publicClient, signTypedDataAsync, signMessageAsync, writeContractAsync, switchNetwork, queryClient],
  );

  return { busy, step, hash, run };
}

/** Human labels for the progress steps trade.js reports. */
export const STEP_TEXT = {
  network: 'Switching network in your wallet…',
  quote: 'Requesting a price quote…',
  'sign-permit': 'Approve the USDG permit in your wallet…',
  'sign-order': 'Sign the order in your wallet…',
  'sign-cancel': 'Sign the cancellation in your wallet…',
  submit: 'Sending to the order book…',
  wallet: 'Confirm the transaction in your wallet…',
  confirming: 'Waiting for the network to confirm…',
  done: 'Confirmed.',
};
