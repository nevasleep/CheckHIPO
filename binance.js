// ─── Shared Binance helpers ──────────────────────────────────────────────────
// Extracted from server.js so lark-bot.js can reuse them.

const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://api.binance.com';
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const STABLECOINS = ['USDT', 'BUSD', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP'];

// ─── Member config from env ───────────────────────────────────────────────────
function getMembers() {
  return LETTERS.map((l, i) => ({
    id: i,
    letter: l,
    name: process.env[`MEMBER_${l}_NAME`] || l,
    apiKey: process.env[`MEMBER_${l}_API_KEY`] || '',
    secretKey: process.env[`MEMBER_${l}_SECRET_KEY`] || '',
  }));
}

function isConfigured(m) {
  return m.apiKey && m.apiKey !== 'your_api_key_here';
}

// ─── Binance helpers ──────────────────────────────────────────────────────────
function sign(qs, secret) {
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function bGet(endpoint, params, apiKey, secretKey) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const url = `${BASE_URL}${endpoint}?${qs}&signature=${sign(qs, secretKey)}`;
  return (await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } })).data;
}

async function bPost(endpoint, params, apiKey, secretKey) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const url = `${BASE_URL}${endpoint}?${qs}&signature=${sign(qs, secretKey)}`;
  return (await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } })).data;
}

function usdPrice(asset, pm) {
  if (STABLECOINS.includes(asset)) return 1;
  return pm[`${asset}USDT`] || pm[`${asset}BUSD`] || pm[`${asset}USDC`] || null;
}

// ─── Fetch one member's portfolio ─────────────────────────────────────────────
async function fetchMember(member, priceMap) {
  if (!isConfigured(member)) {
    return { ...member, status: 'not_configured', totalUsd: 0, balances: [], walletsFound: [], fetchedAt: Date.now() };
  }
  try {
    const [account, funding] = await Promise.all([
      bGet('/api/v3/account', {}, member.apiKey, member.secretKey),
      bPost('/sapi/v1/asset/get-funding-asset', {}, member.apiKey, member.secretKey).catch(() => []),
    ]);

    const merged = {};
    const add = (b, wallet) => {
      const free = parseFloat(b.free || 0);
      const locked = parseFloat(b.locked || b.freeze || 0);
      if (free + locked === 0) return;
      if (!merged[b.asset]) merged[b.asset] = { asset: b.asset, free: 0, locked: 0, total: 0, wallets: [] };
      merged[b.asset].free += free;
      merged[b.asset].locked += locked;
      merged[b.asset].total += free + locked;
      if (!merged[b.asset].wallets.includes(wallet)) merged[b.asset].wallets.push(wallet);
    };

    account.balances.forEach((b) => add(b, 'Spot'));
    (Array.isArray(funding) ? funding : []).forEach((b) => add(b, 'Funding'));

    const balances = Object.values(merged).map((b) => {
      const price = usdPrice(b.asset, priceMap);
      return { ...b, usdPrice: price, usdValue: price !== null ? b.total * price : null };
    }).sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

    const totalUsd = balances.reduce((s, b) => s + (b.usdValue ?? 0), 0);
    return { ...member, status: 'ok', totalUsd, balances, walletsFound: [...new Set(balances.flatMap((b) => b.wallets))], fetchedAt: Date.now() };
  } catch (err) {
    console.error(`[${member.name}]`, err.response?.data?.msg || err.message);
    return { ...member, status: 'error', error: err.response?.data?.msg || err.message, totalUsd: 0, balances: [], walletsFound: [], fetchedAt: Date.now() };
  }
}

// ─── Fetch full team data (prices + all members) ─────────────────────────────
async function fetchTeamData() {
  const pm = {};
  (await axios.get(`${BASE_URL}/api/v3/ticker/price`)).data.forEach((t) => { pm[t.symbol] = parseFloat(t.price); });
  const members = await Promise.all(getMembers().map((m) => fetchMember(m, pm)));
  const teamTotal = members.reduce((s, m) => s + (m.totalUsd || 0), 0);
  const activeCount = members.filter((m) => m.status === 'ok').length;
  return { members, teamTotal, activeCount, fetchedAt: Date.now() };
}

// ─── Deposit status mapping ──────────────────────────────────────────────────
const DEPOSIT_STATUS = {
  0: 'Pending',
  1: 'Success',
  2: 'Rejected',
  6: 'Credited (cannot withdraw)',
  7: 'Wrong Deposit',
  8: 'Waiting User Confirm',
};

// ─── Withdrawal status mapping ───────────────────────────────────────────────
const WITHDRAW_STATUS = {
  0: 'Email Sent',
  1: 'Cancelled',
  2: 'Awaiting Approval',
  3: 'Rejected',
  4: 'Processing',
  5: 'Failure',
  6: 'Completed',
};

// ─── Fetch one member's transaction history (deposits + withdrawals) ─────────
async function fetchMemberTransactions(member, lookbackMs) {
  if (!isConfigured(member)) return [];

  const startTime = Date.now() - (lookbackMs || 24 * 60 * 60 * 1000); // default 24h

  try {
    const [deposits, withdrawals] = await Promise.all([
      bGet('/sapi/v1/capital/deposit/hisrec', { startTime, includeSource: true, limit: 1000 }, member.apiKey, member.secretKey)
        .catch((err) => { console.error(`[${member.name}] Deposit history error:`, err.response?.data?.msg || err.message); return []; }),
      bGet('/sapi/v1/capital/withdraw/history', { startTime, limit: 1000 }, member.apiKey, member.secretKey)
        .catch((err) => { console.error(`[${member.name}] Withdraw history error:`, err.response?.data?.msg || err.message); return []; }),
    ]);

    const txs = [];

    // Normalize deposits
    (Array.isArray(deposits) ? deposits : []).forEach((d) => {
      const dt = new Date(d.insertTime);
      txs.push({
        uniqueId: `dep_${member.letter}_${d.id || d.txId}`,
        date: dt.toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }),
        time: dt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        employeeName: member.name,
        type: 'Deposit',
        address: d.address || 'N/A',
        network: d.network || '',
        amount: `${parseFloat(d.amount)} ${d.coin}`,
        status: DEPOSIT_STATUS[d.status] || `Unknown (${d.status})`,
        txId: d.txId || '',
        timestamp: dt.getTime(),
      });
    });

    // Normalize withdrawals
    (Array.isArray(withdrawals) ? withdrawals : []).forEach((w) => {
      const dt = new Date(w.applyTime);
      txs.push({
        uniqueId: `wtd_${member.letter}_${w.id}`,
        date: dt.toLocaleDateString('en-GB', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric' }),
        time: dt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
        employeeName: member.name,
        type: 'Withdrawal',
        address: w.address || 'N/A',
        network: w.network || '',
        amount: `${parseFloat(w.amount)} ${w.coin}`,
        status: WITHDRAW_STATUS[w.status] || `Unknown (${w.status})`,
        txId: w.txId || w.id || '',
        timestamp: dt.getTime(),
      });
    });

    return txs;
  } catch (err) {
    console.error(`[${member.name}] Transaction fetch error:`, err.response?.data?.msg || err.message);
    return [];
  }
}

// ─── Fetch all members' transactions ─────────────────────────────────────────
async function fetchAllTransactions(lookbackMs) {
  const members = getMembers();
  const allTxArrays = await Promise.all(members.map((m) => fetchMemberTransactions(m, lookbackMs)));
  const allTxs = allTxArrays.flat();
  // Sort by timestamp ascending (oldest first → newest at bottom of sheet)
  allTxs.sort((a, b) => a.timestamp - b.timestamp);
  return allTxs;
}

module.exports = {
  BASE_URL, LETTERS, STABLECOINS,
  getMembers, isConfigured, sign, bGet, bPost, usdPrice,
  fetchMember, fetchTeamData,
  fetchMemberTransactions, fetchAllTransactions,
};
