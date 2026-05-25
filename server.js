require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const { sendToLark } = require('./lark');
const { startLarkBot } = require('./lark-bot');
const { BASE_URL, getMembers, isConfigured, fetchMember, fetchTeamData, fetchAllTransactions, PROXY_CONFIG } = require('./binance');
const { appendBalanceRow, appendTransactionRows, deleteOldBalanceRows } = require('./google-sheets');
const { txLog, WALLETS } = require('./telegram-wallet-bot');

// ─── SePay in-memory store ────────────────────────────────────────────────────
const BANK_TX_MAX = 500;                 // keep last 500 transactions in memory
const bankTxStore = [];                  // newest first
const sseClients = new Set();           // connected SSE browser clients

function addBankTx(tx) {
  // Deduplicate by SePay transaction id
  if (bankTxStore.some((t) => String(t.id) === String(tx.id))) return false;
  bankTxStore.unshift(tx);
  if (bankTxStore.length > BANK_TX_MAX) bankTxStore.pop();
  return true;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── GET /api/team ────────────────────────────────────────────────────────────
app.get('/api/team', async (req, res) => {
  try {
    res.json(await fetchTeamData());
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch team data.' });
  }
});

// ─── GET /api/portfolio?member=0 ─────────────────────────────────────────────
app.get('/api/portfolio', async (req, res) => {
  const idx = parseInt(req.query.member ?? 0);
  const members = getMembers();
  if (idx < 0 || idx >= members.length) return res.status(400).json({ error: 'Invalid member index.' });
  const member = members[idx];
  if (!isConfigured(member)) return res.status(503).json({ error: `Member ${member.name} API keys not configured in .env` });
  try {
    const pm = {};
    (await axios.get(`${BASE_URL}/api/v3/ticker/price`, PROXY_CONFIG)).data.forEach((t) => { pm[t.symbol] = parseFloat(t.price); });
    res.json(await fetchMember(member, pm));
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.msg || 'Failed to fetch portfolio.' });
  }
});

// ─── POST /api/lark/send — Manual trigger ─────────────────────────────────────
app.post('/api/lark/send', async (req, res) => {
  try {
    const teamData = await fetchTeamData();
    await sendToLark(teamData);
    res.json({ ok: true, message: 'Balance report sent to Lark successfully!' });
  } catch (err) {
    console.error('[Lark Send Error]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helper: fetch team data and post to Lark ─────────────────────────────────
async function postTeamToLark() {
  try {
    console.log('[Lark] Fetching team data...');
    const teamData = await fetchTeamData();
    await sendToLark(teamData);
    console.log('[Lark] ✅ Balance report sent successfully.');
  } catch (err) {
    console.error('[Lark] ❌ Failed to send:', err.message);
  }
}

// ─── Helper: fetch team data and export to Sheets ─────────────────────────────
async function exportToSheets() {
  try {
    console.log('[Sheets] Fetching team data for export...');
    const teamData = await fetchTeamData();
    await appendBalanceRow(teamData);
    console.log('[Sheets] ✅ Balance appended to Google Sheets successfully.');
  } catch (err) {
    console.error('[Sheets] ❌ Failed to export:', err.message);
  }
}

// ─── Helper: sync Binance transactions to Sheet 2 (real-time) ────────────────
let txSyncRunning = false;
async function syncTransactionsToSheets() {
  if (txSyncRunning) return; // prevent overlapping runs
  txSyncRunning = true;
  try {
    const txs = await fetchAllTransactions(24 * 60 * 60 * 1000); // last 24h
    if (txs.length === 0) {
      txSyncRunning = false;
      return;
    }
    const result = await appendTransactionRows(txs);
    if (result.appended > 0) {
      console.log(`[Sheets TX] ✅ Appended ${result.appended} new transactions to Sheet 2 (skipped ${result.skipped} duplicates)`);
    }
  } catch (err) {
    console.error('[Sheets TX] ❌ Failed to sync transactions:', err.message);
  }
  txSyncRunning = false;
}

// ─── POST /api/sheets/export — Manual trigger (Sheet 1: Balances) ─────────────
app.post('/api/sheets/export', async (req, res) => {
  try {
    const teamData = await fetchTeamData();
    await appendBalanceRow(teamData);
    res.json({ ok: true, message: 'Balance appended to Google Sheets successfully!' });
  } catch (err) {
    console.error('[Sheets Export Error]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST /api/sheets/transactions — Manual trigger (Sheet 2: Transactions) ──
app.post('/api/sheets/transactions', async (req, res) => {
  try {
    const txs = await fetchAllTransactions(90 * 24 * 60 * 60 * 1000); // last 90 days for manual
    const result = await appendTransactionRows(txs);
    res.json({ ok: true, message: `Synced ${result.appended} new transactions (${result.skipped} already existed).` });
  } catch (err) {
    console.error('[Sheets TX Manual Error]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── SePay Routes ─────────────────────────────────────────────────────────────

// POST /api/bank/webhook — SePay pushes here on every new transaction
app.post('/api/bank/webhook', express.json(), (req, res) => {
  const tx = req.body;
  console.log('[SePay Webhook]', tx.transferType, tx.transferAmount, tx.gateway, tx.accountNumber);

  const isNew = addBankTx({
    id: tx.id,
    gateway: tx.gateway,
    transactionDate: tx.transactionDate,
    accountNumber: tx.accountNumber,
    code: tx.code || null,
    content: tx.content || '',
    transferType: tx.transferType,        // 'in' | 'out'
    transferAmount: tx.transferAmount,
    accumulated: tx.accumulated ?? null,
    referenceCode: tx.referenceCode || null,
    receivedAt: Date.now(),
  });

  if (isNew) broadcastSSE('transaction', bankTxStore[0]);

  // SePay requires this exact response to consider the webhook successful
  res.json({ success: true });
});

// GET /api/bank/stream — SSE stream for real-time browser updates
app.get('/api/bank/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);

  // Send current store immediately on connect so new tabs see existing data
  res.write(`event: init\ndata: ${JSON.stringify(bankTxStore)}\n\n`);

  // Keep-alive ping every 25s
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);

  req.on('close', () => { sseClients.delete(res); clearInterval(ping); });
});

// GET /api/bank/transactions — Pull from SePay API (on-demand fetch)
app.get('/api/bank/transactions', async (req, res) => {
  const token = process.env.SEPAY_API_TOKEN;
  if (!token || token === 'your_sepay_api_token_here') {
    return res.status(503).json({ error: 'SEPAY_API_TOKEN not configured in .env' });
  }

  const limit = Math.min(parseInt(req.query.limit ?? 50), 100);
  const account_number = req.query.account_number || undefined;
  const transaction_date_min = req.query.date_from || undefined;
  const transaction_date_max = req.query.date_to || undefined;

  const params = { limit, ...(account_number && { account_number }), ...(transaction_date_min && { transaction_date_min }), ...(transaction_date_max && { transaction_date_max }) };

  try {
    const { data } = await axios.get('https://my.sepay.vn/userapi/transactions/list', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params,
      timeout: 15000,
    });

    // Merge fetched transactions into our in-memory store
    if (Array.isArray(data.transactions)) {
      data.transactions.forEach((tx) => addBankTx({
        id: tx.id,
        gateway: tx.bank_brand_name,
        transactionDate: tx.transaction_date,
        accountNumber: tx.account_number,
        code: tx.code || null,
        content: tx.transaction_content || '',
        transferType: parseFloat(tx.amount_in) > 0 ? 'in' : 'out',
        transferAmount: parseFloat(tx.amount_in) > 0 ? parseFloat(tx.amount_in) : parseFloat(tx.amount_out),
        accumulated: parseFloat(tx.accumulated) || null,
        referenceCode: tx.reference_number || null,
        receivedAt: Date.now(),
      }));
    }

    res.json({ transactions: bankTxStore, fetchedAt: Date.now() });
  } catch (err) {
    console.error('[SePay API]', err.response?.data || err.message);
    // Return cached store even if API fails
    if (bankTxStore.length > 0) return res.json({ transactions: bankTxStore, fetchedAt: Date.now(), fromCache: true });
    res.status(502).json({ error: err.response?.data?.error || 'Failed to fetch from SePay API.' });
  }
});

// ─── Wallet Monitor API ──────────────────────────────────────────────────────

const walletSseClients = new Set();

function broadcastWalletSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of walletSseClients) {
    try { client.write(payload); } catch { walletSseClients.delete(client); }
  }
}

// Expose broadcastWalletSSE globally so telegram-wallet-bot.js can push live events
global.__broadcastWalletSSE = broadcastWalletSSE;

// GET /api/wallets/transactions — full tx log for all wallets
app.get('/api/wallets/transactions', (req, res) => {
  const transactions = {};
  for (const wallet of WALLETS) {
    transactions[wallet.id] = txLog[wallet.id] || [];
  }
  res.json({ transactions, fetchedAt: Date.now() });
});

// GET /api/wallets/balance/:walletId — current token balance for one wallet
app.get('/api/wallets/balance/:walletId', async (req, res) => {
  const wallet = WALLETS.find((w) => w.id === req.params.walletId);
  if (!wallet) return res.status(404).json({ error: 'Unknown wallet id' });

  try {
    let balance = '0';

    if (wallet.type === 'evm') {
      const params = {
        module: 'account', action: 'tokenbalance',
        contractaddress: wallet.contract,
        address: wallet.address,
        tag: 'latest',
      };
      const { data } = await axios.get(wallet.apiUrl, { ...PROXY_CONFIG, params, timeout: 10000 });
      balance = data.result || '0';
    } else {
      // Tron TRC-20 balance
      const url = `https://api.trongrid.io/v1/accounts/${wallet.address}`;
      const { data } = await axios.get(url, { ...PROXY_CONFIG, timeout: 10000 });
      const trc20 = data?.data?.[0]?.trc20 || [];
      const entry = trc20.find((t) => Object.keys(t)[0] === wallet.contract);
      balance = entry ? Object.values(entry)[0] : '0';
    }

    res.json({ walletId: wallet.id, balance, fetchedAt: Date.now() });
  } catch (err) {
    console.error(`[Wallet Balance] ${wallet.id}:`, err.message);
    res.status(502).json({ error: err.message });
  }
});

// GET /api/wallets/stream — SSE for real-time tx push to the dashboard
app.get('/api/wallets/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  walletSseClients.add(res);

  // Send current txLog on connect so fresh tabs see existing data immediately
  const transactions = {};
  for (const wallet of WALLETS) { transactions[wallet.id] = txLog[wallet.id] || []; }
  res.write(`event: init\ndata: ${JSON.stringify({ transactions })}\n\n`);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 25000);
  req.on('close', () => { walletSseClients.delete(res); clearInterval(ping); });
});

// ─── Start server + Lark cron ─────────────────────────────────────────────────
app.listen(PORT, () => {
  const members = getMembers();
  console.log(`\n✅ CheckBalance running at http://localhost:${PORT}`);
  console.log(`   Members: ${members.map((m) => m.name).join(', ')}`);

  const webhookUrl = process.env.LARK_WEBHOOK_URL;
  const cronExpr = process.env.LARK_CRON || '0 9 * * *';
  const sepayToken = process.env.SEPAY_API_TOKEN;
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (webhookUrl && webhookUrl !== 'your_webhook_url_here') {
    if (cron.validate(cronExpr)) {
      cron.schedule(cronExpr, postTeamToLark, { timezone: 'Asia/Bangkok' });
      console.log(`   Lark bot: ✅ Scheduled (${cronExpr}) — Asia/Bangkok`);
    } else {
      console.warn(`   Lark bot: ⚠️ Invalid LARK_CRON expression: "${cronExpr}"`);
    }
  } else {
    console.log(`   Lark bot: ⚫ Not configured (add LARK_WEBHOOK_URL to .env)`);
  }

  if (sepayToken && sepayToken !== 'your_sepay_api_token_here') {
    console.log(`   SePay:    ✅ Configured — Bank VN at http://localhost:${PORT}/bank.html`);
  } else {
    console.log(`   SePay:    ⚫ Not configured (add SEPAY_API_TOKEN to .env)`);
  }

  if (sheetId && sheetId !== 'your_sheet_id_here') {
    cron.schedule('*/5 * * * *', exportToSheets, { timezone: 'Asia/Bangkok' });
    console.log(`   Sheet 1:  ✅ Balance export scheduled (every 5 min)`);

    // Sheet 1: Daily cleanup — runs at 00:01 Asia/Bangkok every day
    // Deletes rows older than 2 days ago (keeps today + yesterday)
    cron.schedule('1 0 * * *', async () => {
      console.log('[Sheets Cleanup] Running daily old-row cleanup...');
      try {
        await deleteOldBalanceRows();
      } catch (err) {
        console.error('[Sheets Cleanup] ❌ Failed:', err.message);
      }
    }, { timezone: 'Asia/Bangkok' });
    console.log(`   Sheet 1:  ✅ Daily cleanup scheduled (00:01 Asia/Bangkok) — keeps today & yesterday`);

    // Sheet 2: Real-time transaction sync — every 1 minute
    cron.schedule('* * * * *', syncTransactionsToSheets, { timezone: 'Asia/Bangkok' });
    console.log(`   Sheet 2:  ✅ Transaction sync scheduled (every 1 min — real-time)`);

    // Also run immediately on startup to catch up
    setTimeout(syncTransactionsToSheets, 5000);
  } else {
    console.log(`   Sheets:   ⚫ Not configured (add GOOGLE_SHEET_ID to .env)`);
  }

  // Start Lark App Bot (WebSocket — for @mention queries)
  startLarkBot();

  // Wallet Monitor
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChat  = process.env.TELEGRAM_CHAT_ID;
  if (telegramToken && telegramToken !== 'your_telegram_bot_token_here') {
    console.log(`   Wallet Bot: ✅ Telegram configured — dashboard at http://localhost:${PORT}/wallets.html`);
  } else {
    console.log(`   Wallet Bot: ⚫ Telegram not configured (add TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID to .env)`);
    console.log(`               Dashboard still available at http://localhost:${PORT}/wallets.html`);
  }

  console.log();
});
