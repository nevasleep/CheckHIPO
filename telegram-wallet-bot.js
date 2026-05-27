/**
 * telegram-wallet-bot.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Monitors 4 on-chain wallets for new transactions and sends Telegram alerts.
 *
 * Chains monitored:
 *   • Ethereum  — USDT (ERC-20)
 *   • BNB Smart Chain — USDT (BEP-20)
 *   • Arbitrum  — USDC
 *   • Tron      — USDT (TRC-20)
 *
 * No private keys required — only wallet addresses (public data).
 * ──────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { sendWalletAlertToLark } = require('./lark');

// ─── Config ───────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID   || '';
const POLL_INTERVAL_SEC   = parseInt(process.env.WALLET_POLL_INTERVAL_SEC || '60', 10);
const TIMEZONE_OFFSET     = parseInt(process.env.TIMEZONE_OFFSET_HOURS   || '7',  10); // UTC+7
// Minimum token amount (USD) to trigger a notification across all chains
const MIN_NOTIFY_USD = parseFloat(process.env.MIN_NOTIFY_USD || '1');

// ─── Proxy (reuse the same HTTPS_PROXY as Binance) ───────────────────────────
const _proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const PROXY_CONFIG = _proxyUrl
  ? { httpsAgent: new HttpsProxyAgent(_proxyUrl), proxy: false }
  : {};
if (_proxyUrl) console.log('[WalletBot] Using proxy:', _proxyUrl.replace(/:[^:@]*@/, ':***@'));

const STATE_FILE = path.join(__dirname, 'wallet-state.json');

// ─── Wallet & Token Addresses ─────────────────────────────────────────────────

const EVM_ADDRESS  = '0x4E8f62a9FbcaAd5ab8984e0fC00Ffb134735C54C';
const TRON_ADDRESS = 'TB4jzXUFDV2b6HLq5qXPrxh6KtSLy8SmQ2';

const USDT_ETH  = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // USDT on Ethereum
const USDC_ETH  = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC on Ethereum
const USDT_BSC  = '0x55d398326f99059fF775485246999027B3197955'; // USDT on BSC
const USDC_ARB  = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // USDC on Arbitrum
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';        // USDT on Tron

/** All wallets to monitor */
const WALLETS = [
  {
    id:       'eth-usdt',
    chain:    'Ethereum',
    token:    'USDT',
    decimals: 6,
    address:  EVM_ADDRESS,
    contract: USDT_ETH,
    explorer: 'https://etherscan.io',
    apiUrl:   'https://eth.blockscout.com/api',   // no API key required
    type:     'evm',
  },
  {
    id:       'eth-usdc',
    chain:    'Ethereum',
    token:    'USDC',
    decimals: 6,
    address:  EVM_ADDRESS,
    contract: USDC_ETH,
    explorer: 'https://etherscan.io',
    apiUrl:   'https://eth.blockscout.com/api',   // no API key required
    type:     'evm',
  },
  {
    id:       'bsc-usdt',
    chain:    'BNB Smart Chain',
    token:    'USDT',
    decimals: 18,
    address:  EVM_ADDRESS,
    contract: USDT_BSC,
    explorer: 'https://bscscan.com',
    apiUrl:   'https://bsc.blockscout.com/api',   // fallback
    rpcUrl:   'https://bsc.publicnode.com',       // public RPC, more reliable for eth_getLogs
    type:     'bsc-rpc',
  },
  {
    id:       'arb-usdc',
    chain:    'Arbitrum',
    token:    'USDC',
    decimals: 6,
    address:  EVM_ADDRESS,
    contract: USDC_ARB,
    explorer: 'https://arbiscan.io',
    apiUrl:   'https://arbitrum.blockscout.com/api', // no API key required
    type:     'evm',
  },
  {
    id:       'tron-usdt',
    chain:    'Tron',
    token:    'USDT',
    decimals: 6,
    address:  TRON_ADDRESS,
    contract: USDT_TRON,
    explorer: 'https://tronscan.org',
    apiUrl:   'https://api.trongrid.io',
    type:     'tron',
  },
];

// ─── State Persistence ────────────────────────────────────────────────────────

/**
 * Load persisted state (last seen tx hash per wallet).
 * Shape: { [walletId]: { lastTxHash: string, lastTimestamp: number } }
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('[State] Could not load state file, starting fresh.', e.message);
  }
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[State] Could not save state file:', e.message);
  }
}

// In-memory transaction log (newest first, max 1000 per wallet)
const TX_MAX = 200;
const txLog = {}; // { [walletId]: Transaction[] }
WALLETS.forEach((w) => { txLog[w.id] = []; });

function addToLog(walletId, txs) {
  txLog[walletId] = [...txs, ...txLog[walletId]].slice(0, TX_MAX);
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function formatAmount(raw, decimals) {
  const val = Number(raw) / Math.pow(10, decimals);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDate(unixSec) {
  const d = new Date((Number(unixSec) * 1000));
  // shift to local timezone
  const local = new Date(d.getTime() + TIMEZONE_OFFSET * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
         `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} (UTC+${TIMEZONE_OFFSET})`;
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[Telegram] Not configured — skipping notification.');
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id:    TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error('[Telegram] Failed to send message:', err.response?.data?.description || err.message);
  }
}

function buildTelegramMessage(wallet, tx) {
  const isIn     = tx.direction === 'in';
  const emoji    = isIn ? '🟢' : '🔴';
  const dirLabel = isIn ? 'Incoming' : 'Outgoing';
  const sign     = isIn ? '+' : '-';
  const arrow    = isIn ? '⬆️' : '⬇️';

  const fromLabel = isIn ? `📤 <b>From:</b> <code>${shortAddr(tx.from)}</code>` : `📤 <b>From:</b> <code>${shortAddr(wallet.address)}</code>`;
  const toLabel   = isIn ? `📬 <b>To:</b>   <code>${shortAddr(wallet.address)}</code>` : `📬 <b>To:</b>   <code>${shortAddr(tx.to)}</code>`;

  const txLink = wallet.type === 'tron'
    ? `https://tronscan.org/#/transaction/${tx.hash}`
    : `${wallet.explorer}/tx/${tx.hash}`;

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

// ─── EVM Chain Fetcher (via Blockscout — no API key required) ───────────────

async function fetchEvmTransactions(wallet, afterBlock) {
  const params = {
    module:          'account',
    action:          'tokentx',
    address:         wallet.address,
    contractaddress: wallet.contract,
    startblock:      afterBlock || 0,
    endblock:        'latest',
    sort:            'desc',
    page:            1,
    offset:          20, // last 20 txs per poll
  };

  const { data } = await axios.get(wallet.apiUrl, { ...PROXY_CONFIG, params, timeout: 20000 });

  if (data.status === '0') {
    // Empty result is not an error
    const msg = (data.message || '').toLowerCase();
    if (msg.includes('no transactions') || msg.includes('no token transfers') || msg === 'no data found' || msg === 'ok') return [];
    throw new Error(data.message || 'API error');
  }

  return (data.result || []).map((tx) => ({
    hash:      tx.hash,
    block:     parseInt(tx.blockNumber, 10),
    timestamp: parseInt(tx.timeStamp, 10),
    from:      tx.from,
    to:        tx.to,
    rawAmount: tx.value,
    direction: tx.to.toLowerCase() === wallet.address.toLowerCase() ? 'in' : 'out',
  }));
}

// ─── BSC Fetcher (direct RPC via eth_getLogs — no API key or explorer needed) ────

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function padAddr(addr) {
  return '0x' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

async function fetchBscTransactions(wallet, afterBlock) {
  // Get current block number first
  const blockRes = await axios.post(wallet.rpcUrl, {
    jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1,
  }, { ...PROXY_CONFIG, timeout: 10000 });
  const latestBlock = parseInt(blockRes.data.result, 16);

  // Search last ~400 blocks (~20 min) if no state, to avoid limit exceeded errors
  const fromBlock = afterBlock ? Math.max(afterBlock + 1, latestBlock - 400) : latestBlock - 400;
  const fromHex   = '0x' + Math.max(fromBlock, 0).toString(16);
  const paddedAddr = padAddr(wallet.address);

  // Fetch incoming + outgoing Transfer events in parallel
  const [inRes, outRes] = await Promise.all([
    axios.post(wallet.rpcUrl, {
      jsonrpc: '2.0', method: 'eth_getLogs',
      params: [{ address: wallet.contract, topics: [TRANSFER_TOPIC, null, paddedAddr], fromBlock: fromHex, toBlock: 'latest' }],
      id: 2,
    }, { ...PROXY_CONFIG, timeout: 15000 }),
    axios.post(wallet.rpcUrl, {
      jsonrpc: '2.0', method: 'eth_getLogs',
      params: [{ address: wallet.contract, topics: [TRANSFER_TOPIC, paddedAddr], fromBlock: fromHex, toBlock: 'latest' }],
      id: 3,
    }, { ...PROXY_CONFIG, timeout: 15000 }),
  ]);

  if (inRes.data.error) throw new Error(`eth_getLogs in error: ${inRes.data.error.message}`);
  if (outRes.data.error) throw new Error(`eth_getLogs out error: ${outRes.data.error.message}`);

  const parseLogs = (logs, dir) => (logs || []).map((log) => ({
    hash:      log.transactionHash,
    block:     parseInt(log.blockNumber, 16),
    logIndex:  parseInt(log.logIndex, 16),
    timestamp: 0, // will resolve below
    from:      '0x' + log.topics[1].slice(26),
    to:        '0x' + log.topics[2].slice(26),
    rawAmount: BigInt(log.data).toString(),
    direction: dir,
  }));

  const allLogs = [
    ...parseLogs(inRes.data.result,  'in'),
    ...parseLogs(outRes.data.result, 'out'),
  ].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);

  if (allLogs.length === 0) return [];

  // Resolve timestamps: fetch unique block headers (batch, max 5 blocks)
  const uniqueBlocks = [...new Set(allLogs.slice(0, 10).map((l) => l.block))];
  const blockTimes = {};
  await Promise.all(uniqueBlocks.map(async (bn) => {
    try {
      const r = await axios.post(wallet.rpcUrl, {
        jsonrpc: '2.0', method: 'eth_getBlockByNumber',
        params: ['0x' + bn.toString(16), false], id: bn,
      }, { ...PROXY_CONFIG, timeout: 8000 });
      blockTimes[bn] = parseInt(r.data.result?.timestamp || '0', 16);
    } catch { blockTimes[bn] = 0; }
  }));

  return allLogs.map((l) => ({ ...l, timestamp: blockTimes[l.block] || 0 }));
}

// ─── Tron Fetcher ─────────────────────────────────────────────────────────────

async function fetchTronTransactions(wallet, afterTimestampMs) {
  const minMs = afterTimestampMs || (Date.now() - 7 * 24 * 3600 * 1000); // default: last 7 days

  const url = `${wallet.apiUrl}/v1/accounts/${wallet.address}/transactions/trc20`;
  const { data } = await axios.get(url, {
    ...PROXY_CONFIG,
    params: {
      contract_address: wallet.contract,
      limit:            20,
      min_timestamp:    minMs,
    },
    headers: { Accept: 'application/json' },
    timeout: 15000,
  });

  if (!data || !Array.isArray(data.data)) return [];

  return data.data.map((tx) => ({
    hash:      tx.transaction_id,
    block:     tx.block_timestamp, // used as sort key
    timestamp: Math.floor(tx.block_timestamp / 1000),
    from:      tx.from,
    to:        tx.to,
    rawAmount: tx.value,
    direction: tx.to === wallet.address ? 'in' : 'out',
  }));
}

// ─── Per-Wallet Poll ──────────────────────────────────────────────────────────

async function pollWallet(wallet, state) {
  try {
    let rawTxs = [];

    if (wallet.type === 'evm') {
      const afterBlock = state[wallet.id]?.lastBlock || 0;
      rawTxs = await fetchEvmTransactions(wallet, afterBlock);
    } else if (wallet.type === 'bsc-rpc') {
      const afterBlock = state[wallet.id]?.lastBlock || 0;
      rawTxs = await fetchBscTransactions(wallet, afterBlock);
    } else {
      const afterMs = state[wallet.id]?.lastTimestampMs || 0;
      rawTxs = await fetchTronTransactions(wallet, afterMs);
    }

    if (!rawTxs.length) return { newTxs: [] };

    // Filter to only truly new transactions
    const lastSeenHash = state[wallet.id]?.lastTxHash;
    let newTxs = [];

    if (!lastSeenHash) {
      // First run — alert on all fetched txs (user wants to know about every transaction)
      console.log(`[${wallet.id}] First run — found ${rawTxs.length} recent tx(s), will alert on all.`);
      newTxs = [...rawTxs].reverse(); // oldest first
    } else {
      // Find all txs newer than the last seen hash
      const seenIdx = rawTxs.findIndex((t) => t.hash === lastSeenHash);
      if (seenIdx === -1) {
        // All fetched txs are new (burst of activity)
        newTxs = [...rawTxs].reverse();
      } else {
        newTxs = rawTxs.slice(0, seenIdx).reverse();
      }
    }

    // Update state to latest tx
    const latestTx = rawTxs[0];
    state[wallet.id] = {
      lastTxHash:      latestTx.hash,
      lastBlock:       latestTx.block || 0,
      lastTimestampMs: (latestTx.timestamp * 1000) || Date.now(),
    };

    // Add to in-memory log
    if (newTxs.length > 0) addToLog(wallet.id, newTxs);

    return { newTxs };
  } catch (err) {
    console.error(`[${wallet.id}] Poll error:`, err.message);
    return { newTxs: [] };
  }
}

// ─── Main Poll Loop ───────────────────────────────────────────────────────────

let state = loadState();
let pollRunning = false;

async function runPoll() {
  if (pollRunning) return;
  pollRunning = true;

  console.log(`[Bot] Polling ${WALLETS.length} wallets at ${new Date().toISOString()}`);

  for (const wallet of WALLETS) {
    const { newTxs } = await pollWallet(wallet, state);

    for (const tx of newTxs) {
      const txAmount = Number(tx.rawAmount) / Math.pow(10, wallet.decimals);

      // ── Skip dust / gas-fee transactions on all chains ───────────────────
      if (txAmount < MIN_NOTIFY_USD) {
        console.log(`[${wallet.id}] ⏭ Skipped small tx (${txAmount.toFixed(4)} ${wallet.token} < $${MIN_NOTIFY_USD} threshold): ${tx.hash.slice(0, 12)}…`);
        continue;
      }

      console.log(`[${wallet.id}] 🔔 New ${tx.direction.toUpperCase()} tx: ${tx.hash.slice(0, 12)}… ${formatAmount(tx.rawAmount, wallet.decimals)} ${wallet.token}`);

      // Send Telegram + Lark + SSE push for every transaction
      const msg = buildTelegramMessage(wallet, tx);
      await sendTelegram(msg);

      // Send to Lark wallet-alerts group (independent — failure won't block Telegram)
      sendWalletAlertToLark(wallet, tx).catch((err) =>
        console.error(`[Lark Wallet Alert] Failed for ${wallet.id}:`, err.message)
      );

      if (typeof global.__broadcastWalletSSE === 'function') {
        global.__broadcastWalletSSE('transaction', { walletId: wallet.id, tx });
      }

      await new Promise((r) => setTimeout(r, 300));
    }
  }

  saveState(state);
  pollRunning = false;
}

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log('\n🤖 Telegram Wallet Monitor Bot starting...');
console.log(`   Wallets   : ${WALLETS.map((w) => `${w.chain} ${w.token}`).join(' | ')}`);
console.log(`   Interval  : every ${POLL_INTERVAL_SEC}s`);
console.log(`   Telegram  : ${TELEGRAM_BOT_TOKEN ? '✅ Configured' : '⚫ Not configured (add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .env)'}`);
console.log(`   State file: ${STATE_FILE}`);
console.log('');

// Run immediately, then on interval
runPoll();
setInterval(runPoll, POLL_INTERVAL_SEC * 1000);

// ─── Exports (for server.js integration) ─────────────────────────────────────

module.exports = { txLog, WALLETS };
