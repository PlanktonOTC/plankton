import React from 'react';
import { encodeFunctionData, zeroAddress } from 'viem';
import { useAccount, useReadContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi';
import { useBellStatus } from '../live/queries.js';
import { explorerAddress, explorerTx } from '../live/wagmi.js';
import { shortAddress, usdgNum, money } from '../live/units.js';
import { useI18n } from '../i18n';
import { vaultAbi } from '../live/abis.js';
import './bell-options.css';

export default function BellOptionsView({ contracts }) {
  const { t: tr } = useI18n();
  const query = useBellStatus();
  const status = query.data;
  const ready = Boolean(status?.tradeReady);
  const account = useAccount();
  const vault = contracts?.vault ?? zeroAddress;
  const ownerQuery = useReadContract({ address: vault, abi: vaultAbi, functionName: 'owner', query: { enabled: vault !== zeroAddress } });
  const pendingQuery = useReadContract({ address: vault, abi: vaultAbi, functionName: 'pendingImplementation', query: { enabled: vault !== zeroAddress, refetchInterval: 10_000 } });
  const etaQuery = useReadContract({ address: vault, abi: vaultAbi, functionName: 'upgradeEta', query: { enabled: vault !== zeroAddress, refetchInterval: 10_000 } });
  const optionsBookQuery = useReadContract({ address: vault, abi: vaultAbi, functionName: 'optionsBook', query: { enabled: vault !== zeroAddress, refetchInterval: 10_000 } });
  const upgradeWrite = useWriteContract();
  const upgradeReceipt = useWaitForTransactionReceipt({ hash: upgradeWrite.data });
  const isOwner = Boolean(account.address && ownerQuery.data && account.address.toLowerCase() === ownerQuery.data.toLowerCase());
  const pendingImplementation = pendingQuery.data;
  const upgradeEta = etaQuery.data;
  const linked = Boolean(optionsBookQuery.data && status?.optionsBook && optionsBookQuery.data.toLowerCase() === status.optionsBook.toLowerCase());
  const scheduleMatches = Boolean(pendingImplementation && status?.counterImplementation && pendingImplementation.toLowerCase() === status.counterImplementation.toLowerCase());
  const canExecuteUpgrade = Boolean(isOwner && scheduleMatches && upgradeEta && status?.chainTimeSec && BigInt(status.chainTimeSec) >= upgradeEta && !linked);
  const scheduleUpgrade = () => upgradeWrite.writeContract({ address: vault, abi: vaultAbi, functionName: 'scheduleUpgrade', args: [status.counterImplementation] });
  const executeUpgradeAndLink = () => {
    const linkData = encodeFunctionData({ abi: vaultAbi, functionName: 'linkOptionsBook', args: [status.optionsBook] });
    upgradeWrite.writeContract({ address: vault, abi: vaultAbi, functionName: 'upgradeToAndCall', args: [status.counterImplementation, linkData] });
  };
  const addressRows = [
    ['Options book', status?.optionsBook],
    ['Settlement oracle', status?.settlementOracle],
    ['Counter implementation', status?.counterImplementation],
  ].filter((row) => row[1]);
  const eta = status?.counterUpgradeEta ? new Date(Number(status.counterUpgradeEta) * 1000).toLocaleString() : null;

  return (
    <main className="bell-options-page">
      <header className="bell-options-heading">
        <div><span className="term-kicker">{tr('DEFINED-RISK CONTRACTS')}</span><h1>{tr('Bell options')}</h1></div>
        <span className={`bell-options-state ${ready ? 'is-ready' : 'is-pending'}`}>{tr(ready ? 'Available' : 'Not open')}</span>
      </header>

      {query.isError && <div className="term-info-banner" role="status">{tr('Bell status could not be read from the API. It will retry automatically.')}</div>}
      {query.isLoading && <div className="term-empty">{tr('Reading Bell contract status…')}</div>}
      {status && !status.deployed && <div className="term-info-banner">{tr('Bell contracts have not been deployed on this network.')}</div>}
      {status?.deployed && !status.linked && (
        <div className="term-info-banner" role="status">
          {tr('The Bell book is deployed, but it is not linked to the Counter yet. The Counter owner must schedule the implementation upgrade and wait 48 hours before linking it.')}
          {eta && <small>{tr('Current scheduled upgrade ETA')}: {eta}</small>}
        </div>
      )}
      {status?.deployed && isOwner && !linked && (
        <section className="bell-options-admin" aria-label={tr('Counter upgrade controls')}>
          <h2>{tr('Counter upgrade')}</h2>
          <p>{tr('This schedules the Counter implementation upgrade. It cannot be executed for 48 hours. After the delay, the second action upgrades Counter and links the Bell book in the same transaction.')}</p>
          {scheduleMatches
            ? <button disabled={upgradeWrite.isPending || upgradeReceipt.isLoading || !canExecuteUpgrade} onClick={executeUpgradeAndLink}>
                {tr(canExecuteUpgrade ? 'Upgrade Counter and link Bell' : 'Upgrade available after the 48-hour delay')}
              </button>
            : <button disabled={upgradeWrite.isPending || upgradeReceipt.isLoading || !isOwner || Boolean(pendingImplementation && pendingImplementation !== zeroAddress)} onClick={scheduleUpgrade}>
                {tr(pendingImplementation && pendingImplementation !== zeroAddress ? 'A different upgrade is already pending' : 'Schedule Counter upgrade')}
              </button>}
          {!isOwner && <small>{tr('Connect the current Counter owner wallet')} ({ownerQuery.data ? shortAddress(ownerQuery.data) : '—'}).</small>}
          {upgradeWrite.error && <small role="alert">{tr(upgradeWrite.error.message || 'The wallet rejected the request.')}</small>}
          {upgradeWrite.data && <small role="status">{tr(upgradeReceipt.isSuccess ? 'Transaction confirmed' : 'Waiting for transaction confirmation')}: <a href={explorerTx(upgradeWrite.data)} target="_blank" rel="noreferrer">{shortAddress(upgradeWrite.data)}</a></small>}
        </section>
      )}
      {status?.linked && !status.opensEnabled && (
        <div className="term-info-banner" role="status">{tr('New options are disabled while quote and settlement operations are being configured.')}</div>
      )}
      {ready && <div className="bell-options-ready">{tr('The Counter is linked and the options book accepts new contracts.')}</div>}

      <section className="bell-options-grid" aria-label={tr('Bell options system status')}>
        <article className="bell-options-card">
          <span>{tr('Counter link')}</span>
          <strong>{status?.linked ? tr('Linked') : tr('Waiting for owner upgrade')}</strong>
          <small>{contracts?.vault ? shortAddress(contracts.vault) : '—'}</small>
        </article>
        <article className="bell-options-card">
          <span>{tr('New contracts')}</span>
          <strong>{status?.opensEnabled ? tr('Enabled') : tr('Disabled')}</strong>
          <small>{tr('The on-chain book enforces this switch.')}</small>
        </article>
        <article className="bell-options-card">
          <span>{tr('Reserved payouts')}</span>
          <strong>{status?.optionReserveUsdg === null || status?.optionReserveUsdg === undefined ? '—' : `$${money(usdgNum(status.optionReserveUsdg))}`}</strong>
          <small>{tr('USDG held aside by the Counter')}</small>
        </article>
        <article className="bell-options-card">
          <span>{tr('Open payout exposure')}</span>
          <strong>{status?.totalExposureUsdg === undefined ? '—' : `$${money(usdgNum(status.totalExposureUsdg))}`}</strong>
          <small>{tr('USDG maximum payout across unresolved contracts')}</small>
        </article>
      </section>

      {addressRows.length > 0 && (
        <section className="bell-options-contracts">
          <h2>{tr('On-chain contracts')}</h2>
          {addressRows.map(([label, address]) => <a key={label} href={explorerAddress(address)} target="_blank" rel="noreferrer"><span>{tr(label)}</span><code>{address}</code><b>↗</b></a>)}
        </section>
      )}
      {status?.deployed && <p className="bell-options-footnote">{tr('The contracts are deployed, but the options flow is not available until the Counter upgrade is complete and quote and settlement services are ready.')}</p>}
    </main>
  );
}
