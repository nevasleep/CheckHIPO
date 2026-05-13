// ─── State ────────────────────────────────────────────────────────────────────
let allTransactions = [];   // full dataset (newest first)
let currentFilter   = 'all';
let sseSource       = null;

// ─── Number formatters ────────────────────────────────────────────────────────
function formatVnd(amount) {
  if (amount == null || isNaN(amount)) return '—';
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(amount);
}

function formatVndCompact(amount) {
  if (amount == null || isNaN(amount)) return '—';
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)} tỷ`;
  if (abs >= 1_000_000)     return `${sign}${(abs / 1_000_000).toFixed(2)} tr`;
  return `${sign}${new Intl.NumberFormat('vi-VN').format(abs)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}\n${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function bankAbbr(name) {
  if (!name) return '?';
  const map = {
    'Vietcombank': 'VCB', 'Techcombank': 'TCB', 'MB Bank': 'MB',
    'BIDV': 'BIDV', 'Vietinbank': 'VTB', 'Agribank': 'ARB',
    'ACB': 'ACB', 'VPBank': 'VPB', 'TPBank': 'TPB', 'SHB': 'SHB',
    'SeABank': 'SEA', 'OCB': 'OCB', 'HDBank': 'HDB', 'MSB': 'MSB',
    'Sacombank': 'STB', 'Eximbank': 'EIB', 'BacABank': 'BAB',
    'LienVietPostBank': 'LVB', 'NamABank': 'NAB',
  };
  for (const [key, abbr] of Object.entries(map)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return abbr;
  }
  return name.slice(0, 3).toUpperCase();
}

// ─── SSE — Real-time stream ───────────────────────────────────────────────────
function connectSSE() {
  if (sseSource) sseSource.close();

  sseSource = new EventSource('/api/bank/stream');

  sseSource.addEventListener('init', (e) => {
    const txs = JSON.parse(e.data);
    // Merge SSE init data with any already-fetched transactions (deduplicate by id)
    // This prevents a race condition where SSE init overwrites data from fetchTransactions()
    if (txs.length > 0) {
      const existingIds = new Set(allTransactions.map((t) => String(t.id)));
      const newTxs = txs.filter((t) => !existingIds.has(String(t.id)));
      allTransactions = [...allTransactions, ...newTxs]
        .sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));
    }
    renderTable();
    updateStats();
    setLiveBadge(true);
    setDot('live');
    document.getElementById('refresh-label').textContent = allTransactions.length > 0 ? 'Live' : 'Live';
  });

  sseSource.addEventListener('transaction', (e) => {
    const tx = JSON.parse(e.data);
    // Prepend to array (deduplicate)
    if (!allTransactions.some((t) => String(t.id) === String(tx.id))) {
      allTransactions.unshift(tx);
    }
    updateStats();
    // Prepend a flashing row to the table
    prependRow(tx);
    showToast(
      `${tx.transferType === 'in' ? '⬆️' : '⬇️'} ${formatVndCompact(tx.transferAmount)} — ${tx.gateway || ''}`,
      tx.transferType === 'in' ? 'success' : 'error'
    );
  });

  sseSource.onerror = () => {
    setLiveBadge(false);
    setDot('error');
    document.getElementById('refresh-label').textContent = 'Reconnecting…';
    // EventSource auto-reconnects, so just update UI
  };

  sseSource.onopen = () => {
    setLiveBadge(true);
  };
}

// ─── Fetch (Pull API) ─────────────────────────────────────────────────────────
async function fetchTransactions() {
  setDot('loading');
  document.getElementById('refresh-label').textContent = 'Fetching…';
  document.getElementById('btn-refresh').classList.add('spinning');

  try {
    const res  = await fetch('/api/bank/transactions?limit=50');
    const data = await res.json();

    if (!res.ok || data.error) {
      if (data.error && data.error.includes('SEPAY_API_TOKEN')) {
        document.getElementById('config-warning').style.display = 'flex';
      }
      setDot('error');
      document.getElementById('refresh-label').textContent = 'Error';
      document.getElementById('btn-refresh').classList.remove('spinning');
      return;
    }

    document.getElementById('config-warning').style.display = 'none';
    allTransactions = data.transactions || [];
    renderTable();
    updateStats();
    setDot('live');
    document.getElementById('refresh-label').textContent = data.fromCache ? 'Cached' : 'Live';

    if (data.fetchedAt) {
      const t = new Date(data.fetchedAt);
      document.getElementById('footer-time').textContent =
        `Updated ${t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  } catch (err) {
    setDot('error');
    document.getElementById('refresh-label').textContent = 'Cannot reach server';
  }

  document.getElementById('btn-refresh').classList.remove('spinning');
}

// ─── Filter ───────────────────────────────────────────────────────────────────
function setFilter(f) {
  currentFilter = f;

  const pills = {
    all:  document.getElementById('filter-all'),
    in:   document.getElementById('filter-in'),
    out:  document.getElementById('filter-out'),
  };
  Object.entries(pills).forEach(([key, el]) => {
    el.className = 'filter-pill';
    if (key === f) {
      if (f === 'all') el.classList.add('active');
      else if (f === 'in')  el.classList.add('active-in');
      else if (f === 'out') el.classList.add('active-out');
    }
  });

  renderTable();
}

// ─── Render full table ────────────────────────────────────────────────────────
function renderTable() {
  const tbody = document.getElementById('tx-tbody');
  tbody.innerHTML = '';

  const visible = filtered();

  if (visible.length === 0) {
    tbody.innerHTML = `
      <tr><td colspan="7">
        <div class="bank-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-4 0v2M12 12v5M8 12v5"/></svg>
          <div class="bank-empty-title">${allTransactions.length === 0 ? 'No transactions yet' : 'No matching transactions'}</div>
          <div class="bank-empty-sub">${allTransactions.length === 0
            ? 'Transactions will appear here once SePay sends data.<br>Make sure your SEPAY_API_TOKEN is configured.'
            : 'Try changing the filter above.'}</div>
        </div>
      </td></tr>`;
    return;
  }

  visible.forEach((tx, i) => {
    tbody.appendChild(buildRow(tx, i + 1, false));
  });
}

// ─── Prepend a single new row (from SSE) ─────────────────────────────────────
function prependRow(tx) {
  const tbody = document.getElementById('tx-tbody');

  // Remove empty state if present
  const emptyRow = tbody.querySelector('.bank-empty');
  if (emptyRow) tbody.innerHTML = '';

  if (currentFilter !== 'all' && tx.transferType !== currentFilter) return;

  // Re-number existing rows
  tbody.querySelectorAll('td.row-index').forEach((td, i) => { td.textContent = i + 2; });

  const tr = buildRow(tx, 1, true);
  tbody.insertBefore(tr, tbody.firstChild);
}

// ─── Build a single <tr> ─────────────────────────────────────────────────────
function buildRow(tx, index, flash) {
  const tr = document.createElement('tr');
  if (flash) tr.classList.add('tx-flash');

  const isIn   = tx.transferType === 'in';
  const amount = Number(tx.transferAmount) || 0;
  const bal    = tx.accumulated != null ? Number(tx.accumulated) : null;
  const parts  = formatDate(tx.transactionDate).split('\n');
  const abbr   = bankAbbr(tx.gateway);

  tr.innerHTML = `
    <td class="row-index">${index}</td>
    <td class="tx-date">
      <div>${parts[0] || '—'}</div>
      <div style="color:var(--text-3);font-size:.72rem">${parts[1] || ''}</div>
    </td>
    <td>
      <div class="tx-bank">
        <div class="tx-bank-icon">${abbr}</div>
        <div>
          <div style="font-weight:600;font-size:.85rem">${tx.gateway || '—'}</div>
          <div class="tx-account">${tx.accountNumber || '—'}</div>
        </div>
      </div>
    </td>
    <td><span class="tx-type-badge ${isIn ? 'in' : 'out'}">${isIn ? '↑ IN' : '↓ OUT'}</span></td>
    <td>
      <div class="tx-amount ${isIn ? 'in' : 'out'}">${isIn ? '+' : '−'} ${formatVnd(amount)}</div>
    </td>
    <td class="tx-balance">${bal !== null ? formatVnd(bal) : '—'}</td>
    <td class="tx-content" title="${(tx.content || '').replace(/"/g, '&quot;')}">${tx.content || '—'}</td>`;

  return tr;
}

// ─── Update summary stats ─────────────────────────────────────────────────────
function updateStats() {
  // Filter to today (Vietnam timezone, UTC+7)
  const nowVN  = new Date(Date.now() + 7 * 3600 * 1000);
  const todayY = nowVN.getUTCFullYear();
  const todayM = nowVN.getUTCMonth();
  const todayD = nowVN.getUTCDate();

  function isToday(tx) {
    if (!tx.transactionDate) return false;
    const d = new Date(tx.transactionDate);
    const dVN = new Date(d.getTime() + 7 * 3600 * 1000);
    return dVN.getUTCFullYear() === todayY && dVN.getUTCMonth() === todayM && dVN.getUTCDate() === todayD;
  }

  const todayTxs = allTransactions.filter(isToday);
  const todayIn  = todayTxs.filter((t) => t.transferType === 'in');
  const todayOut = todayTxs.filter((t) => t.transferType === 'out');

  const sumIn  = todayIn.reduce((s, t)  => s + (Number(t.transferAmount) || 0), 0);
  const sumOut = todayOut.reduce((s, t) => s + (Number(t.transferAmount) || 0), 0);
  const net    = sumIn - sumOut;

  document.getElementById('stat-in').textContent       = formatVnd(sumIn);
  document.getElementById('stat-in-count').textContent  = `${todayIn.length} transaction${todayIn.length !== 1 ? 's' : ''}`;
  document.getElementById('stat-out').textContent      = formatVnd(sumOut);
  document.getElementById('stat-out-count').textContent = `${todayOut.length} transaction${todayOut.length !== 1 ? 's' : ''}`;

  const netEl   = document.getElementById('stat-net');
  const netCard = document.getElementById('stat-net-card');
  netEl.textContent = (net >= 0 ? '+' : '') + formatVnd(net);
  netEl.className   = `bsc-value ${net >= 0 ? 'green' : 'red'}`;
  netCard.className = `bank-stat-card ${net >= 0 ? 'net-pos' : 'net-neg'}`;

  document.getElementById('stat-total').textContent     = allTransactions.length;
  document.getElementById('stat-total-sub').textContent = `${todayTxs.length} today`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function filtered() {
  if (currentFilter === 'all') return allTransactions;
  return allTransactions.filter((tx) => tx.transferType === currentFilter);
}

function setDot(state) {
  document.getElementById('refresh-dot').className = `refresh-dot ${state}`;
}

function setLiveBadge(live) {
  const badge = document.getElementById('live-badge');
  const label = document.getElementById('live-label');
  if (live) {
    badge.classList.remove('inactive');
    label.textContent = 'Live';
  } else {
    badge.classList.add('inactive');
    label.textContent = 'Offline';
  }
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4500);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  fetchTransactions();   // initial pull from SePay API
  connectSSE();          // open SSE for real-time webhook events
});
