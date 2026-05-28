/**
 * replay-missed-txs.js
 * ─────────────────────────────────────────────────────────────
 * One-off script: fetches missed Ethereum USDC transactions
 * and sends them through the same Telegram + Lark alert pipeline.
 * Run once, then delete.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { sendWalletAlertToLark } = require('./lark');
const { uploadTransactionToBase } = require('./lark-base');

// ─── Proxy ────────────────────────────────────────────────────
const _proxyUrl = process.env.HTTPS_PROXY || '';
const PROXY_CONFIG = _proxyUrl
  ? { httpsAgent: new HttpsProxyAgent(_proxyUrl), proxy: false }
  : {};

// ─── Wallet definition (same as telegram-wallet-bot.js) ──────
const wallet = {
  id:       'eth-usdc',
  chain:    'Ethereum',
  token:    'USDC',
  decimals: 6,
  address:  '0x4E8f62a9FbcaAd5ab8984e0fC00Ffb134735C54C',
  contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  explorer: 'https://etherscan.io',
  apiUrl:   'https://eth.blockscout.com/api',
  type:     'evm',
};

// ─── Telegram helpers ─────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '';
const TIMEZONE_OFFSET    = parseInt(process.env.TIMEZONE_OFFSET_HOURS || '7', 10);

function formatAmount(raw, decimals) {
  const val = Number(raw) / Math.pow(10, decimals);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDate(unixSec) {
  const d     = new Date(Number(unixSec) * 1000);
  const local = new Date(d.getTime() + TIMEZONE_OFFSET * 3600 * 1000);
  const pad   = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())} ` +
         `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} (UTC+${TIMEZONE_OFFSET})`;
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function buildTelegramMessage(tx) {
  const isIn     = tx.direction === 'in';
  const emoji    = isIn ? '🟢' : '🔴';
  const dirLabel = isIn ? 'Incoming' : 'Outgoing';
  const sign     = isIn ? '+' : '-';
  const arrow    = isIn ? '⬆️' : '⬇️';
  const fromLabel = isIn
    ? `📤 <b>From:</b> <code>${shortAddr(tx.from)}</code>`
    : `📤 <b>From:</b> <code>${shortAddr(wallet.address)}</code>`;
  const toLabel   = isIn
    ? `📬 <b>To:</b>   <code>${shortAddr(wallet.address)}</code>`
    : `📬 <b>To:</b>   <code>${shortAddr(tx.to)}</code>`;
  const txLink = `${wallet.explorer}/tx/${tx.hash}`;

  return [
    `${emoji} <b>${dirLabel} Transaction</b>`,
    ``,
    `📌 <b>Chain:</b>  ${wallet.chain}`,
    `🪙 <b>Token:</b>  ${wallet.token}`,
    ``,
    `${arrow} <b>${sign}${formatAmount(tx.rawAmount, wallet.decimals)} ${wallet.token}</b>`,
    ``,
    fromLabel,
    toLabel,
    ``,
    `🔗 <a href="${txLink}">View on Explorer</a>`,
    `⏰ ${formatDate(tx.timestamp)}`,
  ].join('\n');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] Not configured — skipping.');
    return;
  }
  await axios.post(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true },
    { timeout: 10000 }
  );
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('Fetching missed Ethereum USDC transactions...\n');

  const params = {
    module: 'account', action: 'tokentx',
    address:         wallet.address,
    contractaddress: wallet.contract,
    startblock:      25138520,
    endblock:        'latest',
    sort:            'asc',   // oldest first → alert in chronological order
    page: 1, offset: 20,
  };

  const { data } = await axios.get(wallet.apiUrl, {
    ...PROXY_CONFIG, params, timeout: 20000,
  });

  const allTxs = (data.result || [])
    .filter((tx) => {
      const amt = parseInt(tx.value, 10);
      const isIn = tx.to.toLowerCase() === wallet.address.toLowerCase();
      return amt > 0 && isIn; // only real incoming transfers
    })
    .map((tx) => ({
      hash:      tx.hash,
      block:     parseInt(tx.blockNumber, 10),
      timestamp: parseInt(tx.timeStamp, 10),
      from:      tx.from,
      to:        tx.to,
      rawAmount: tx.value,
      direction: 'in',
    }));

  if (allTxs.length === 0) {
    console.log('No missed transactions found to replay.');
    return;
  }

  console.log(`Found ${allTxs.length} missed transaction(s) to send:\n`);
  allTxs.forEach((tx, i) => {
    const amt = (parseInt(tx.rawAmount) / 1e6).toFixed(2);
    console.log(`  [${i+1}] +${amt} USDC | ${formatDate(tx.timestamp)} | ${tx.hash.slice(0, 20)}...`);
  });
  console.log('');

  for (const tx of allTxs) {
    const amt = (parseInt(tx.rawAmount) / 1e6).toFixed(2);
    console.log(`Sending alert for +${amt} USDC (${tx.hash.slice(0, 18)})...`);

    // Telegram
    try {
      await sendTelegram(buildTelegramMessage(tx));
      console.log('  ✅ Telegram sent');
    } catch (e) {
      console.error('  ❌ Telegram failed:', e.response?.data?.description || e.message);
    }

    // Lark (all configured wallet webhook groups)
    try {
      await sendWalletAlertToLark(wallet, tx);
      console.log('  ✅ Lark sent');
    } catch (e) {
      console.error('  ❌ Lark failed:', e.message);
    }
    
    // Lark Base
    try {
      await uploadTransactionToBase(wallet, tx);
      console.log('  ✅ Lark Base uploaded');
    } catch (e) {
      console.error('  ❌ Lark Base failed:', e.message);
    }

    // Small delay between messages
    await new Promise((r) => setTimeout(r, 1000));
    console.log('');
  }

  console.log('Done! All missed transactions have been sent to the groups.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
