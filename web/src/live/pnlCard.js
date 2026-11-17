import { explorerTx } from './wagmi.js';

function usd(value) {
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const cents = absolute / 10_000n;
  const whole = cents / 100n;
  const fraction = (cents % 100n).toString().padStart(2, '0');
  return `$${whole.toLocaleString('en-US')}.${fraction}`;
}

function signedUsd(value) {
  const amount = BigInt(value);
  return `${amount > 0n ? '+' : amount < 0n ? '−' : ''}${usd(amount)}`;
}

function short(value, left = 8, right = 6) {
  return value.length > left + right + 3 ? `${value.slice(0, left)}…${value.slice(-right)}` : value;
}

function dateLabel(timestamp) {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  });
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function drawPnlCard(trade, wallet) {
  const realized = BigInt(trade.realizedPnlUsdg);
  const fee = BigInt(trade.feeUsdg);
  const net = realized - fee;
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not create the share card.');

  ctx.fillStyle = '#0a1012';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const glow = ctx.createRadialGradient(1020, 30, 0, 1020, 30, 700);
  glow.addColorStop(0, '#8ac6a51f');
  glow.addColorStop(1, '#8ac6a500');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  roundedRect(ctx, 28, 28, 1144, 574, 20);
  ctx.strokeStyle = '#ffffff24';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#d8e8df';
  ctx.font = '600 24px system-ui, sans-serif';
  ctx.fillText('PLANKTON', 72, 92);
  ctx.fillStyle = '#81908a';
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillText('REALIZED TRADE', 72, 124);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#84918d';
  ctx.font = '500 16px system-ui, sans-serif';
  ctx.fillText('ROBINHOOD CHAIN · USDG', 1128, 92);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#f0f4f1';
  ctx.font = '600 72px system-ui, sans-serif';
  ctx.fillText(trade.symbol, 72, 242);
  ctx.fillStyle = '#aebbb4';
  ctx.font = '500 20px system-ui, sans-serif';
  const event = trade.liquidation ? 'LIQUIDATION' : trade.path.toUpperCase();
  ctx.fillText(`${trade.side.toUpperCase()} FILL  ·  ${event}`, 74, 282);

  ctx.fillStyle = '#81908a';
  ctx.font = '500 15px system-ui, sans-serif';
  ctx.fillText('REALIZED P&L AFTER RECORDED FEE', 74, 354);
  ctx.fillStyle = net >= 0n ? '#a8dbba' : '#f0a4a4';
  ctx.font = '600 70px system-ui, sans-serif';
  ctx.fillText(`${signedUsd(net)} USDG`, 72, 440);

  ctx.fillStyle = '#8b9993';
  ctx.font = '500 18px system-ui, sans-serif';
  ctx.fillText(`Realized ${signedUsd(realized)}  ·  Fee ${usd(fee)}  ·  ${dateLabel(trade.at)}`, 74, 490);

  ctx.strokeStyle = '#ffffff1c';
  ctx.beginPath();
  ctx.moveTo(72, 520);
  ctx.lineTo(1128, 520);
  ctx.stroke();

  ctx.fillStyle = '#c0ccc5';
  ctx.font = '500 16px system-ui, sans-serif';
  ctx.fillText(`WALLET  ${short(wallet, 10, 8)}`, 74, 557);
  ctx.fillStyle = '#92b8a0';
  ctx.fillText(`ON-CHAIN PROOF  ${short(trade.txHash, 13, 10)}  ↗`, 74, 583);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#708078';
  ctx.font = '400 13px system-ui, sans-serif';
  ctx.fillText('Single indexed fill · borrow and other fills excluded', 1128, 557);
  ctx.textAlign = 'left';
  return canvas;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not export the share card.')), 'image/png');
  });
}

export function pnlShareCaption(trade, wallet) {
  const realized = BigInt(trade.realizedPnlUsdg);
  const fee = BigInt(trade.feeUsdg);
  const net = realized - fee;
  return `${trade.symbol} ${trade.side.toUpperCase()} · ${signedUsd(net)} USDG realized after recorded fee\n${short(wallet, 10, 8)} · ${dateLabel(trade.at)}\nOn-chain execution record: ${explorerTx(trade.txHash)}\nSingle indexed fill; borrow and other account activity excluded.`;
}

export async function sharePnlCard(trade, wallet) {
  const blob = await canvasBlob(drawPnlCard(trade, wallet));
  const file = new File([blob], `plankton-${trade.symbol.toLowerCase()}-pnl.png`, { type: 'image/png' });
  const caption = pnlShareCaption(trade, wallet);
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title: `${trade.symbol} realized P&L`, text: caption, files: [file] });
    return 'Shared card with its transaction proof link.';
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  try {
    await navigator.clipboard.writeText(caption);
    return 'Card downloaded and proof link copied.';
  } catch {
    return 'Card downloaded. The transaction proof link is beside the trade.';
  }
}

export function hasRealizedPnl(trade) {
  return BigInt(trade.realizedPnlUsdg) !== 0n;
}
