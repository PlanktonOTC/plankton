import React, { useMemo, useState } from 'react';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { useReadContract } from 'wagmi';
import { exchangeAbi, feeRouterAbi } from '../live/abis.js';
import { explorerAddress, explorerTx } from '../live/wagmi.js';
import { bindReferrer } from '../live/trade.js';
import { shortAddress } from '../live/units.js';
import { Arrow, TxProgress, useTerminal } from './shared.jsx';
import { useI18n } from '../i18n';

export default function Referrals({ contracts, inviteAddress }) {
  const terminal = useTerminal();
  const { t: tr } = useI18n();
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState('');
  const [txHash, setTxHash] = useState('');
  const wallet = terminal.wallet;
  const inviter = useMemo(() => isAddress(inviteAddress || '') ? getAddress(inviteAddress) : '', [inviteAddress]);
  const canRead = Boolean(wallet.isConnected && wallet.address && contracts?.exchange);
  const referrerQuery = useReadContract({
    address: contracts?.exchange || zeroAddress,
    abi: exchangeAbi,
    functionName: 'referrerOf',
    args: [wallet.address || zeroAddress],
    query: { enabled: canRead, refetchInterval: 15_000 },
  });
  const rebateQuery = useReadContract({
    address: contracts?.feeRouter || zeroAddress,
    abi: feeRouterAbi,
    functionName: 'referralBps',
    query: { enabled: Boolean(contracts?.feeRouter), refetchInterval: 30_000 },
  });
  const currentReferrer = referrerQuery.data && referrerQuery.data.toLowerCase() !== zeroAddress.toLowerCase() ? referrerQuery.data : '';
  const ownInvite = Boolean(inviter && wallet.address && inviter.toLowerCase() === wallet.address.toLowerCase());
  const inviteLink = useMemo(() => {
    if (!wallet.address) return '';
    const url = new URL('/trade', window.location.origin);
    url.searchParams.set('view', 'referrals');
    url.searchParams.set('ref', wallet.address);
    return url.toString();
  }, [wallet.address]);
  const rebate = rebateQuery.data === undefined ? null : Number(rebateQuery.data) / 100;

  async function copyInvite() {
    if (!inviteLink) return terminal.openWallet();
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setMessage('Referral link copied.');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setMessage('Could not copy the link. Copy it from the field above.');
    }
  }

  async function acceptInvite() {
    setMessage('');
    setTxHash('');
    if (!wallet.isConnected) return terminal.openWallet();
    if (!inviter) return setMessage('This referral link has an invalid wallet address.');
    if (ownInvite) return setMessage('You cannot use your own referral link.');
    if (currentReferrer) return setMessage('A referrer is already set for this wallet.');
    const result = await terminal.trader.run((ctx) => bindReferrer(ctx, inviter));
    if (!result.ok) return setMessage(result.message);
    setTxHash(result.hash || '');
    setMessage('Referral confirmed on-chain.');
    await referrerQuery.refetch();
  }

  return (
    <section className="term-secondary-view term-referrals">
      <div className="term-view-title">
        <div><p className="term-overline">{tr('GROW THE PLANKTON NETWORK')}</p><h1>{tr('Invite traders. Earn a fee rebate.')}</h1><p>{tr('Share your link. When a trader joins through it, their referral is recorded on Robinhood Chain and your rebate is paid automatically in USDG as they trade.')}</p></div>
        <span className={`term-small-badge ${rebate === null ? 'is-off' : ''}`}>{rebate === null ? tr('LOADING') : `${rebate.toFixed(2)}% ${tr('REBATE')}`}</span>
      </div>

      <div className="term-referral-stats">
        <div className="term-large-panel">
          <span className="term-overline">{tr('CURRENT ON-CHAIN REBATE')}</span>
          <strong>{rebate === null ? '—' : `${rebate.toFixed(2)}%`}</strong>
          <p>{tr('This share of each referred trader’s trading fee is sent directly to your wallet in USDG.')}</p>
        </div>
        <div className="term-large-panel">
          <span className="term-overline">{tr('HOW IT WORKS')}</span>
          <ol>
            <li>{tr('Copy your personal referral link and share it.')}</li>
            <li>{tr('Your invitee connects a wallet and confirms the referral transaction.')}</li>
            <li>{tr('The contract pays your rebate automatically when their trading fees are routed.')}</li>
          </ol>
        </div>
      </div>

      <div className="term-large-panel term-referral-link-panel">
        <div>
          <h2>{tr('Your referral link')}</h2>
          <p>{tr('Connect your wallet to create a link tied to your address.')}</p>
        </div>
        {wallet.isConnected ? (
          <>
            <code className="term-referral-url">{inviteLink}</code>
            <button className="term-secondary" onClick={copyInvite}>{copied ? tr('Copied') : tr('Copy referral link')}</button>
          </>
        ) : <button className="term-secondary" onClick={terminal.openWallet}>{tr('Connect wallet')}</button>}
      </div>

      <div className="term-large-panel term-referral-status">
        <div className="term-referral-invite">
          <div><span className="term-overline">{tr('INVITATION')}</span><h2>{tr(inviter ? 'Referral invitation' : 'Your referral status')}</h2></div>
          {inviter ? <a className="term-leaderboard-wallet" href={explorerAddress(inviter)} target="_blank" rel="noreferrer">{shortAddress(inviter)} ↗</a> : null}
        </div>
        {inviter ? (
          currentReferrer ? (
            <p>{tr('Your referrer is')} <a className="term-leaderboard-wallet" href={explorerAddress(currentReferrer)} target="_blank" rel="noreferrer">{shortAddress(currentReferrer)} ↗</a>. {tr('Referral binding cannot be changed.')}</p>
          ) : ownInvite ? (
            <p>{tr('This is your own referral link. Share it with another trader.')}</p>
          ) : (
            <>
              <p>{tr('Your wallet has not been linked to this referrer. Binding is permanent and can only be done once.')}</p>
              <button className="term-primary" disabled={terminal.trader.busy || referrerQuery.isLoading} onClick={acceptInvite}>{terminal.trader.busy ? tr('Confirming…') : tr('Accept referral')}</button>
            </>
          )
        ) : currentReferrer ? (
          <p>{tr('Your referrer is')} <a className="term-leaderboard-wallet" href={explorerAddress(currentReferrer)} target="_blank" rel="noreferrer">{shortAddress(currentReferrer)} ↗</a></p>
        ) : wallet.isConnected ? (
          <p>{tr('No referrer is set. Open someone’s referral link to connect their address to your wallet.')}</p>
        ) : (
          <p>{tr('Connect a wallet to see whether a referrer is set.')}</p>
        )}
        {referrerQuery.isError && wallet.isConnected && <p className="term-negative">{tr('Could not read referral status from the exchange.')}</p>}
        {rebateQuery.isError && <p className="term-negative">{tr('Could not read the referral rate from the fee router.')}</p>}
        {message && <p className="term-history-export-status" role="status">{tr(message)}</p>}
        {txHash && <a className="term-text-link" href={explorerTx(txHash)} target="_blank" rel="noreferrer">{tr('View referral transaction')} <Arrow /></a>}
        {terminal.trader.step && <TxProgress step={terminal.trader.step} hash={terminal.trader.hash} />}
      </div>
    </section>
  );
}
