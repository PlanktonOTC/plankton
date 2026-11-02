import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { STEP_TEXT } from '../live/useTrader.js';
import { explorerTx } from '../live/wagmi.js';

/** Everything the terminal's panels share: live data, the wallet, and the action runner. Set up in Dashboard.jsx. */
export const Terminal = createContext(null);
export const useTerminal = () => useContext(Terminal);

export function Arrow({ down = false }) {
  return <span aria-hidden="true">{down ? '↘' : '↗'}</span>;
}

export function Modal({ title, children, onClose, busy = false }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    const frame = requestAnimationFrame(() => {
      dialog.current?.querySelector('[data-autofocus], input:not([disabled]), select:not([disabled])')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      previous?.focus?.({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      className="term-dialog"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !busy) onClose();
      }}
    >
      <div className="term-modal-heading">
        <h2>{title}</h2>
        <button className="term-icon-btn" aria-label="Close dialog" disabled={busy} onClick={onClose}>×</button>
      </div>
      {children}
    </dialog>
  );
}

/** Progress of a wallet action: what the wallet or network is being waited on, with a link once there is a transaction. */
export function TxProgress({ step, hash }) {
  if (!step) return null;
  return (
    <p className="term-tx-progress" role="status" aria-live="polite">
      <i aria-hidden="true" />
      {STEP_TEXT[step] ?? 'Working…'}
      {hash ? <> <a href={explorerTx(hash)} target="_blank" rel="noreferrer">View transaction <Arrow /></a></> : null}
    </p>
  );
}

/** useState backed by localStorage. Storage can be blocked or full: the screen must work without it. */
export function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage full: the value simply is not kept */
    }
  }, [key, value]);
  return [value, setValue];
}

export const TV_SYMBOLS = { USAR: 'NASDAQ:USAR', CLSK: 'NASDAQ:CLSK', RGTI: 'NASDAQ:RGTI' };

/** Fallback company tile for a market without a downloaded logo: its ticker in the terminal's own style. */
export function Monogram({ symbol, className = '' }) {
  return <span className={`market-company-mark market-monogram ${className}`} aria-hidden="true"><b>{symbol.slice(0, 2)}</b></span>;
}
