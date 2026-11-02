import React from 'react';
import './market-rail.css';

/** Company tile: the ticker's first letters in the terminal's steel style. (No third-party logos are bundled.) */
export function CompanyMark({symbol, name, className=''}) {
  return <span className={`market-company-mark market-monogram ${className}`} role="img" aria-label={name || symbol}><b>{symbol.slice(0,2)}</b></span>;
}

const Star=({filled=false})=><svg viewBox="0 0 20 20" aria-hidden="true" fill={filled?'currentColor':'none'}><path d="m10 2.7 2.14 4.34 4.79.7-3.47 3.38.82 4.77L10 13.64l-4.28 2.25.82-4.77-3.47-3.38 4.79-.7L10 2.7Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/></svg>;

/** Selection and watchlist are separate native controls, with no nested button. `market.change` is null when there is no reference close yet. */
export default function MarketTile({market, selected=false, favorite=false, onSelect, onFavorite}) {
  const price=Number(market.price);
  const hasChange=market.change!==null&&market.change!==undefined&&Number.isFinite(Number(market.change));
  const change=hasChange?Number(market.change):0;
  const digits=price>=100?2:price>=1?3:4;
  const priceLabel=Number.isFinite(price)&&price>0?price.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
  const direction=hasChange&&change<0?'down':'up';
  const changeLabel=hasChange?`${change>=0?'+':'−'}${Math.abs(change).toFixed(2)}%`:market.statusLabel||'—';
  return <div className={`market-tile ${selected?'is-selected':''}`}>
    <span className="market-steel-sheen" aria-hidden="true"/>
    <button type="button" className="market-tile-select" aria-pressed={selected} aria-label={`Select ${market.symbol} perpetual market, ${market.name}. Mark ${priceLabel} USDG, ${hasChange?`${changeLabel} versus the last close`:market.statusLabel}.`} onClick={()=>onSelect?.(market.symbol)}>
      <span className="market-tile-identity">
        <CompanyMark symbol={market.symbol} name={market.name}/>
        <span className="market-tile-name"><span className="market-tile-symbol">{market.symbol}<span className="market-perp-label">PERP</span></span><span className="market-company-name" title={market.name}>{market.name}</span></span>
      </span>
      <span className="market-tile-quote"><span className="market-price">{priceLabel}<span>USDG</span></span><span className={`market-change ${hasChange?direction:'flat'}`}>{hasChange&&<svg viewBox="0 0 12 12" aria-hidden="true"><path d={direction==='up'?'M2 8.5 8.5 2M3 2h5.5v5.5':'M2 3.5 8.5 10M3 10h5.5V4.5'}/></svg>}{changeLabel}</span></span>
      <span className="market-selected-line" aria-hidden="true"/>
    </button>
    <button type="button" className={`market-tile-favorite ${favorite?'is-favorite':''}`} aria-label={`${favorite?'Remove':'Add'} ${market.symbol} ${favorite?'from':'to'} watchlist`} aria-pressed={favorite} onClick={()=>onFavorite?.(market.symbol)}><Star filled={favorite}/></button>
  </div>;
}
