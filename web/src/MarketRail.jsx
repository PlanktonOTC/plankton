import React, {useEffect, useState} from 'react';
import './market-rail.css';

// Original official company icons, downloaded from each company's own homepage.
// CSS changes their presentation only; attribution: docs/company-logos.md.
const companyMarks = {
  RCAT: {file:'rcat.jpg'},
  NNE: {file:'nne.png', treatment:'lift'},
  POET: {file:'poet.png'},
  QUBT: {file:'qubt.png', treatment:'invert'},
  RUN: {file:'run.ico', treatment:'invert'},
  INOD: {file:'inod.webp', treatment:'lift-strong'},
  TE: {file:'te.png', treatment:'invert'},
  WYFI: {file:'wyfi.png'},
};

export function CompanyMark({symbol, name, className=''}) {
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[symbol]);
  const mark=companyMarks[symbol];
  return <span className={`market-company-mark ${mark?.treatment || ''} ${className}`} aria-hidden="true">
    {mark&&!failed ? <img src={`/assets/companies/${mark.file}`} alt="" width="32" height="32" decoding="async" onError={()=>setFailed(true)}/> : <span className="market-logo-unavailable" title={`${name || symbol} logo unavailable`}>—</span>}
  </span>;
}

const Star=({filled=false})=><svg viewBox="0 0 20 20" aria-hidden="true" fill={filled?'currentColor':'none'}><path d="m10 2.7 2.14 4.34 4.79.7-3.47 3.38.82 4.77L10 13.64l-4.28 2.25.82-4.77-3.47-3.38 4.79-.7L10 2.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>;

/** Selection and watchlist are separate native controls, with no nested button. */
export default function MarketTile({market, selected=false, favorite=false, onSelect, onFavorite}) {
  const price=Number(market.price);
  const change=Number(market.change);
  const priceLabel=Number.isFinite(price)?price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}):'—';
  const direction=Number.isFinite(change)&&change<0?'down':'up';
  const changeLabel=Number.isFinite(change)?`${change>=0?'+':'−'}${Math.abs(change).toFixed(2)}%`:'—';
  return <div className={`market-tile ${selected?'is-selected':''}`}>
    <span className="market-steel-sheen" aria-hidden="true"/>
    <button type="button" className="market-tile-select" aria-pressed={selected} aria-label={`Select ${market.symbol} perpetual market, ${market.name}. Sample price ${priceLabel} USDG, change ${changeLabel}.`} onClick={()=>onSelect?.(market.symbol)}>
      <span className="market-tile-identity">
        <CompanyMark symbol={market.symbol} name={market.name}/>
        <span className="market-tile-name"><span className="market-tile-symbol">{market.symbol}<span className="market-perp-label">PERP</span></span><span className="market-company-name" title={market.name}>{market.name}</span></span>
      </span>
      <span className="market-tile-quote"><span className="market-price">{priceLabel}<span>USDG</span></span><span className={`market-change ${direction}`}><svg viewBox="0 0 12 12" aria-hidden="true"><path d={direction==='up'?'M2 8.5 8.5 2M3 2h5.5v5.5':'M2 3.5 8.5 10M3 10h5.5V4.5'}/></svg>{changeLabel}</span></span>
      <span className="market-selected-line" aria-hidden="true"/>
    </button>
    <button type="button" className={`market-tile-favorite ${favorite?'is-favorite':''}`} aria-label={`${favorite?'Remove':'Add'} ${market.symbol} ${favorite?'from':'to'} watchlist`} aria-pressed={favorite} onClick={()=>onFavorite?.(market.symbol)}><Star filled={favorite}/></button>
  </div>;
}
