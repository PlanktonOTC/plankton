import React, { useCallback, useState } from 'react';
import { DEFAULT_PRESETS, LIMITS, loadPresets, marginPercent, savePresets, sanitizePresets } from '../live/presets.js';
import { useI18n } from '../i18n';

/** The saved take-profit / stop-loss defaults. Kept in this browser; every change is saved at once. */
export function usePresets() {
  const [presets, setPresets] = useState(loadPresets);
  const update = useCallback((patch) => {
    setPresets((prev) => {
      const next = sanitizePresets({ ...prev, ...patch });
      savePresets(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    savePresets(DEFAULT_PRESETS);
    setPresets({ ...DEFAULT_PRESETS });
  }, []);
  return { presets, update, reset };
}

/**
 * Shows the defaults in use and lets the trader apply them again or change them. `canEdit` is false in the protection dialog,
 * which only reminds and re-applies; the ticket also edits.
 */
export function PresetControls({ presets, update, reset, leverage, onApply, canEdit = true }) {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [tp, setTp] = useState(String(presets.tpPct));
  const [sl, setSl] = useState(String(presets.slPct));
  const commit = () => {
    const next = sanitizePresets({ ...presets, tpPct: tp, slPct: sl });
    setTp(String(next.tpPct));
    setSl(String(next.slPct));
    update({ tpPct: next.tpPct, slPct: next.slPct });
  };
  const onReset = () => {
    reset();
    setTp(String(DEFAULT_PRESETS.tpPct));
    setSl(String(DEFAULT_PRESETS.slPct));
  };
  return (
    <div className="term-presets">
      <div className="term-presets-row">
        <span>
          {tr('Defaults:')} <b>{tr('TP')} +{presets.tpPct}%</b> · <b>{tr('SL')} −{presets.slPct}%</b>
          {leverage ? <small> {tr('≈ {tp}% / {sl}% of margin at {lev}×', { tp: marginPercent(presets.tpPct, leverage), sl: marginPercent(presets.slPct, leverage), lev: leverage })}</small> : null}
        </span>
        <button type="button" onClick={onApply}>{tr('Use defaults')}</button>
        {canEdit && <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? tr('Done') : tr('Edit defaults')}</button>}
      </div>
      {canEdit && open && (
        <div className="term-presets-edit">
          <label>{tr('Take profit %')} <input type="number" inputMode="decimal" min={LIMITS.tpPct[0]} max={LIMITS.tpPct[1]} step="0.5" value={tp} onChange={(e) => setTp(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} aria-label={tr('Default take profit percent')} /></label>
          <label>{tr('Stop loss %')} <input type="number" inputMode="decimal" min={LIMITS.slPct[0]} max={LIMITS.slPct[1]} step="0.5" value={sl} onChange={(e) => setSl(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} aria-label={tr('Default stop loss percent')} /></label>
          <label className="term-checkbox"><input type="checkbox" checked={presets.auto} onChange={(e) => update({ auto: e.target.checked })} />{tr('Turn on TP / SL for every new market trade')}</label>
          <button type="button" className="term-presets-reset" onClick={onReset}>{tr('Reset to defaults')}</button>
          <p className="term-fineprint">{tr('Percent is the move in the price from your entry, not from your margin. Saved in this browser only.')}</p>
        </div>
      )}
    </div>
  );
}
