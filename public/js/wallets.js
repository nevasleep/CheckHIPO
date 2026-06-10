/**
 * wallets.js — On-Chain Wallet Monitor Dashboard
 * Connects to /api/wallets/stream (SSE) for live updates
 * and /api/wallets/transactions for the initial data load.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const CHAIN_META = {
  'eth-usdt':  { label: 'Ethereum',       token: 'USDT', dotClass: 'dot-eth',  explorer: 'https://etherscan.io/tx/',   decimals: 6  },
  'bsc-usdt':  { label: 'BNB Smart Chain',token: 'USDT', dotClass: 'dot-bsc',  explorer: 'https://bscscan.com/tx/',    decimals: 18 },
  'arb-usdc':  { label: 'Arbitrum',       token: 'USDC', dotClass: 'dot-arb',  explorer: 'https://arbiscan.io/tx/',    decimals: 6  },
  'tron-usdt': { label: 'Tron',           token: 'USDT', dotClass: 'dot-tron', explorer: 'https://tronscan.org/#/transaction/', decimals: 6 },
};

const BALANCE_APIS = {
  'eth-usdt':  { url: '/api/wallets/balance/eth-usdt'  },
  'bsc-usdt':  { url: '/api/wallets/balance/bsc-usdt'  },
  'arb-usdc':  { url: '/api/wallets/balance/arb-usdc'  },
  'tron-usdt': { url: '/api/wallets/balance/tron-usdt' },
};

// ─── State ────────────────────────────────────────────────────────────────────

let allTxs = [];          // flat array of all known txs (newest first)
let activeChain = 'all';
let activeDir   = 'all';
const todayCounts = { 'eth-usdt': 0, 'bsc-usdt': 0, 'arb-usdc': 0, 'tron-usdt': 0 };

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const tbody         = document.getElementById('wm-tbody');
const statusDot     = document.getElementById('wm-status');
const lastUpdateEl  = document.getElementById('wm-last-update');
const txCountEl     = document.getElementById('wm-tx-count');
const refreshBtn    = document.getElementById('wm-refresh-btn');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(rawAmount, decimals) {
  const val = Number(rawAmount) / Math.pow(10, decimals);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function fmtBalance(rawAmount, decimals) {
  const val = Number(rawAmount) / Math.pow(10, decimals);
  return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortAddr(addr) {
  if (!addr || addr.length < 14) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtTime(unixSec) {
  const d = new Date(Number(unixSec) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  // Offset to UTC+7
  const local = new Date(d.getTime() + 7 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth()+1)}-${pad(local.getUTCDate())} ` +
         `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

function isToday(unixSec) {
  const now   = new Date();
  const txDay = new Date(Number(unixSec) * 1000);
  return now.getUTCFullYear() === txDay.getUTCFullYear() &&
         now.getUTCMonth()    === txDay.getUTCMonth()    &&
         now.getUTCDate()     === txDay.getUTCDate();
}

function setStatus(state) {
  statusDot.className = 'wm-status-dot wm-status-' + state;
}

function setLastUpdate() {
  const now = new Date();
  const local = new Date(now.getTime() + 7 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  lastUpdateEl.textContent =
    `Updated ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function buildRow(tx, isNew = false) {
  const meta  = CHAIN_META[tx.walletId] || { label: tx.walletId, token: '?', dotClass: '', explorer: '', decimals: 6 };
  const isIn  = tx.direction === 'in';
  const sign  = isIn ? '+' : '−';
  const amtClass = isIn ? 'wm-amount-in' : 'wm-amount-out';
  const txUrl = meta.explorer + tx.hash;

  const tr = document.createElement('tr');
  if (isNew) tr.classList.add('wm-row-new');

  tr.innerHTML = `
    <td>
      <span class="wm-dir-badge ${isIn ? 'wm-dir-in' : 'wm-dir-out'}">
        ${isIn ? '▲ IN' : '▼ OUT'}
      </span>
    </td>
    <td>
      <span class="wm-chain-chip">
        <span class="wm-chain-dot ${meta.dotClass}"></span>
        ${meta.label}
        <span style="color:var(--text-muted);font-size:11px">${meta.token}</span>
      </span>
    </td>
    <td><span class="${amtClass}">${sign}${fmt(tx.rawAmount, meta.decimals)} ${meta.token}</span></td>
    <td><span class="wm-mono-addr" title="${tx.from}">${shortAddr(tx.from)}</span></td>
    <td><span class="wm-mono-addr" title="${tx.to}">${shortAddr(tx.to)}</span></td>
    <td><span class="wm-time">${fmtTime(tx.timestamp)}</span></td>
    <td><a class="wm-tx-link" href="${txUrl}" target="_blank" rel="noopener">${tx.hash.slice(0,10)}…</a></td>
  `;
  return tr;
}

function renderTable(isNewTx = false) {
  // Filter
  const filtered = allTxs.filter((tx) => {
    if (activeChain !== 'all' && tx.walletId !== activeChain) return false;
    if (activeDir   !== 'all' && tx.direction !== activeDir)  return false;
    return true;
  });

  txCountEl.textContent = `${filtered.length.toLocaleString()} transaction${filtered.length !== 1 ? 's' : ''}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr class="wm-empty-row">
        <td colspan="7">
          <div class="wm-empty">
            <span class="wm-empty-icon">🔍</span>
            <span>No transactions found</span>
          </div>
        </td>
      </tr>`;
    return;
  }

  // Only re-render top if it's a new-tx push (performance)
  if (isNewTx) {
    const newRows = filtered.slice(0, 3);
    newRows.forEach((tx) => {
      const tr = buildRow(tx, true);
      tbody.insertBefore(tr, tbody.firstChild);
    });
    // Trim excess rows from the DOM (keep max 100 in DOM)
    while (tbody.children.length > 100) tbody.removeChild(tbody.lastChild);
    return;
  }

  // Full render
  const fragment = document.createDocumentFragment();
  filtered.slice(0, 100).forEach((tx) => fragment.appendChild(buildRow(tx)));
  tbody.innerHTML = '';
  tbody.appendChild(fragment);
}

// ─── Today Counts ─────────────────────────────────────────────────────────────

function recalcTodayCounts() {
  Object.keys(todayCounts).forEach((k) => { todayCounts[k] = 0; });
  allTxs.forEach((tx) => {
    if (isToday(tx.timestamp) && todayCounts[tx.walletId] !== undefined) {
      todayCounts[tx.walletId]++;
    }
  });
  Object.keys(todayCounts).forEach((id) => {
    const el = document.getElementById(`cnt-${id}`);
    if (el) el.textContent = todayCounts[id];
  });
}

// ─── Balance Fetch ────────────────────────────────────────────────────────────

async function fetchBalances() {
  for (const [id] of Object.entries(BALANCE_APIS)) {
    try {
      const res = await fetch(`/api/wallets/balance/${id}`);
      if (!res.ok) continue;
      const data = await res.json();
      const el = document.getElementById(`bal-${id}`);
      const meta = CHAIN_META[id];
      if (el && data.balance !== undefined) {
        el.textContent = fmtBalance(data.balance, meta.decimals) + ' ' + meta.token;
      }
    } catch (_) { /* silently ignore */ }
  }
}

// ─── Data Load ────────────────────────────────────────────────────────────────

async function loadTransactions() {
  try {
    setStatus('loading');
    const res = await fetch('/api/wallets/transactions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // data: { transactions: { [walletId]: Transaction[] } }
    allTxs = [];
    if (data.transactions) {
      for (const [walletId, txs] of Object.entries(data.transactions)) {
        txs.forEach((tx) => allTxs.push({ ...tx, walletId }));
      }
      // sort newest first
      allTxs.sort((a, b) => b.timestamp - a.timestamp);
    }

    renderTable();
    recalcTodayCounts();
    setStatus('live');
    setLastUpdate();
  } catch (err) {
    console.error('[Wallets] Failed to load transactions:', err);
    setStatus('error');
    tbody.innerHTML = `
      <tr class="wm-empty-row">
        <td colspan="7">
          <div class="wm-empty">
            <span class="wm-empty-icon">❌</span>
            <span>Failed to load transactions — bot may still be starting up</span>
          </div>
        </td>
      </tr>`;
  }
}

// ─── SSE Live Updates ─────────────────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource('/api/wallets/stream');

  es.addEventListener('init', (e) => {
    const data = JSON.parse(e.data);
    // Merge incoming data into allTxs (dedup by hash)
    const existingHashes = new Set(allTxs.map((t) => t.hash));
    let added = 0;
    for (const [walletId, txs] of Object.entries(data.transactions || {})) {
      txs.forEach((tx) => {
        if (!existingHashes.has(tx.hash)) {
          allTxs.push({ ...tx, walletId });
          existingHashes.add(tx.hash);
          added++;
        }
      });
    }
    if (added > 0) {
      allTxs.sort((a, b) => b.timestamp - a.timestamp);
      renderTable();
      recalcTodayCounts();
    }
    setStatus('live');
  });

  es.addEventListener('transaction', (e) => {
    const { walletId, tx } = JSON.parse(e.data);
    // Dedup
    if (allTxs.some((t) => t.hash === tx.hash)) return;
    allTxs.unshift({ ...tx, walletId });
    renderTable(true);
    recalcTodayCounts();
    setLastUpdate();
    // Flash balance card
    const card = document.getElementById(`card-${walletId}`);
    if (card) {
      card.style.transition = 'box-shadow 0.3s ease';
      card.style.boxShadow  = tx.direction === 'in' ? '0 0 20px rgba(0,214,143,0.4)' : '0 0 20px rgba(255,85,114,0.4)';
      setTimeout(() => { card.style.boxShadow = ''; }, 2000);
    }
    // Re-fetch balances on any new transaction
    fetchBalances();
  });

  es.onerror = () => { setStatus('error'); };
  es.onopen  = () => { setStatus('live'); };
}

// ─── Filter Pills ─────────────────────────────────────────────────────────────

document.getElementById('filter-chain').addEventListener('click', (e) => {
  const pill = e.target.closest('.wm-pill');
  if (!pill) return;
  document.querySelectorAll('#filter-chain .wm-pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  activeChain = pill.dataset.chain;
  renderTable();
});

document.getElementById('filter-dir').addEventListener('click', (e) => {
  const pill = e.target.closest('.wm-pill');
  if (!pill) return;
  document.querySelectorAll('#filter-dir .wm-pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  activeDir = pill.dataset.dir;
  renderTable();
});

// ─── Refresh Button ───────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', async () => {
  refreshBtn.style.transform = 'rotate(360deg)';
  await loadTransactions();
  await fetchBalances();
  setTimeout(() => { refreshBtn.style.transform = ''; }, 400);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async () => {
  await loadTransactions();
  fetchBalances();  // non-blocking
  connectSSE();
})();
