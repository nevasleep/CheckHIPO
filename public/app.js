// ─── Constants ────────────────────────────────────────────────────────────────
const MEMBER_COLORS = ['#F0B90B','#3B82F6','#10B981','#8B5CF6','#F97316','#EC4899'];
const CHART_COLORS  = ['#F0B90B','#3B82F6','#10B981','#8B5CF6','#F97316','#EC4899','#00BCD4','#FF5722','#8BC34A','#E91E63','#FFC107','#474D57'];

// ─── Send to Lark (manual) ────────────────────────────────────────────────────
async function sendToLark() {
  const btn = document.getElementById('btn-lark');
  btn.disabled = true;
  btn.classList.add('sending');
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg> Sending…`;

  try {
    const res = await fetch('/api/lark/send', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ Balance report sent to Lark!', 'success');
    } else {
      showToast(`❌ ${data.error}`, 'error');
    }
  } catch {
    showToast('❌ Could not reach server', 'error');
  }

  btn.disabled = false;
  btn.classList.remove('sending');
  btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg> Send to Lark`;
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 4000);
}


// ─── State ────────────────────────────────────────────────────────────────────
let currentView        = 'team';
let currentMemberIndex = 0;
let teamData           = null;
let memberData         = null;
let currentSort        = 'usd';
let countdownTimer     = null;
let secondsLeft        = 30;

// ─── View Routing ─────────────────────────────────────────────────────────────
function showTeamView() {
  currentView = 'team';
  document.getElementById('view-team').classList.remove('hidden');
  document.getElementById('view-member').classList.add('hidden');
  document.getElementById('header-crumb').innerHTML = '<span class="crumb-item crumb-active">Team Overview</span>';
  document.getElementById('btn-refresh').onclick = fetchTeam;
  if (!teamData) { fetchTeam(); } else { renderTeamView(); resetCountdown(fetchTeam); }
}

function showMemberView(idx) {
  currentView = 'member';
  currentMemberIndex = idx;
  document.getElementById('view-team').classList.add('hidden');
  document.getElementById('view-member').classList.remove('hidden');

  // If we already have team data, get the member name
  const name = teamData?.members?.[idx]?.name || `Member ${idx + 1}`;
  const color = MEMBER_COLORS[idx];
  document.getElementById('header-crumb').innerHTML =
    `<span class="crumb-item" onclick="showTeamView()" style="cursor:pointer">Team Overview</span>
     <span class="crumb-sep">›</span>
     <span class="crumb-item crumb-active" style="color:${color}">${name}</span>`;

  document.getElementById('btn-refresh').onclick = () => fetchMember(currentMemberIndex);

  // Use cached data if available from team fetch
  const cached = teamData?.members?.[idx];
  if (cached && cached.status === 'ok') {
    memberData = cached;
    renderMemberDetail();
    resetCountdown(() => fetchMember(currentMemberIndex));
  } else {
    fetchMember(idx);
  }
}

// ─── Fetch Team ───────────────────────────────────────────────────────────────
async function fetchTeam() {
  setDotState('loading');
  document.getElementById('refresh-label').textContent = 'Fetching…';
  document.getElementById('btn-refresh').classList.add('spinning');

  try {
    const res = await fetch('/api/team');
    const data = await res.json();
    if (!res.ok || data.error) { setDotState('error'); document.getElementById('refresh-label').textContent = 'Error'; return; }
    teamData = data;
    renderTeamView();
    resetCountdown(fetchTeam);
  } catch {
    setDotState('error');
    document.getElementById('refresh-label').textContent = 'Cannot reach server';
  }
  document.getElementById('btn-refresh').classList.remove('spinning');
}

// ─── Fetch Member ─────────────────────────────────────────────────────────────
async function fetchMember(idx) {
  setDotState('loading');
  document.getElementById('refresh-label').textContent = 'Fetching…';
  document.getElementById('btn-refresh').classList.add('spinning');
  hideError();

  try {
    const res = await fetch(`/api/portfolio?member=${idx}`);
    const data = await res.json();
    if (!res.ok || data.error) { showError(data.error || 'Failed to fetch.'); setDotState('error'); document.getElementById('btn-refresh').classList.remove('spinning'); return; }
    memberData = data;
    renderMemberDetail();
    resetCountdown(() => fetchMember(idx));
  } catch {
    showError('Cannot reach the local server.');
    setDotState('error');
  }
  document.getElementById('btn-refresh').classList.remove('spinning');
}

// ─── Render Team View ─────────────────────────────────────────────────────────
function renderTeamView() {
  if (!teamData) return;
  renderGrandTotal();
  renderMemberCards();
  setDotState('live');
  document.getElementById('refresh-label').textContent = `Next in ${secondsLeft}s`;
}

function renderGrandTotal() {
  const { teamTotal, members, activeCount, totalMembers } = teamData;
  document.getElementById('grand-value').textContent = formatUsd(teamTotal);
  document.getElementById('grand-sub').textContent = `${activeCount} of ${totalMembers ?? members.length} wallets active`;

  // Grand bar — each member's proportion
  const bar = document.getElementById('grand-bar');
  const legend = document.getElementById('grand-bar-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';

  if (teamTotal === 0) { bar.innerHTML = '<div style="flex:1;background:var(--bg-hover)"></div>'; return; }

  members.forEach((m, i) => {
    if (!m.totalUsd) return;
    const pct = (m.totalUsd / teamTotal) * 100;
    const seg = document.createElement('div');
    seg.className = 'grand-bar-segment';
    seg.style.flex = pct.toString();
    seg.style.background = MEMBER_COLORS[i];
    seg.setAttribute('data-tooltip', `${m.name}: ${formatUsd(m.totalUsd)} (${pct.toFixed(1)}%)`);
    bar.appendChild(seg);

    const li = document.createElement('div');
    li.className = 'grand-legend-item';
    li.innerHTML = `<div class="grand-legend-dot" style="background:${MEMBER_COLORS[i]}"></div><span>${m.name} <strong style="color:var(--text)">${pct.toFixed(1)}%</strong></span>`;
    legend.appendChild(li);
  });
}

function renderMemberCards() {
  const grid = document.getElementById('member-grid');
  grid.innerHTML = '';

  teamData.members.forEach((m, i) => {
    const color = MEMBER_COLORS[i];
    const card = document.createElement('div');
    card.className = 'member-card';
    card.style.borderTopColor = color;
    card.style.borderTopWidth = '3px';

    const statusClass = m.status === 'ok' ? 'live' : m.status === 'error' ? 'error' : 'unconfigured';
    const statusText  = m.status === 'ok' ? 'Live' : m.status === 'error' ? 'Error' : 'Not configured';
    const totalStr    = m.status === 'ok' ? formatUsd(m.totalUsd) : (m.status === 'error' ? 'Error' : '—');

    // Top 3 holdings
    let holdingsHtml = '';
    if (m.status === 'ok' && m.balances.length > 0) {
      m.balances.slice(0, 3).forEach((b) => {
        holdingsHtml += `
          <div class="member-holding-row">
            <span class="holding-asset">${b.asset}</span>
            <span class="holding-amount">${formatAmount(b.total)}</span>
            <span class="holding-usd">${b.usdValue !== null ? formatUsd(b.usdValue) : '—'}</span>
          </div>`;
      });
    }

    // Mini bar
    let miniBarHtml = '';
    if (m.status === 'ok' && m.totalUsd > 0) {
      m.balances.filter((b) => b.usdValue > 0).slice(0, 5).forEach((b, bi) => {
        const pct = (b.usdValue / m.totalUsd) * 100;
        miniBarHtml += `<div class="member-mini-segment" style="flex:${pct};background:${CHART_COLORS[bi]}"></div>`;
      });
    }

    // Body content
    let bodyContent = '';
    if (m.status === 'ok') {
      bodyContent = `
        <div class="member-mini-bar">${miniBarHtml || '<div style="flex:1;background:var(--bg-hover)"></div>'}</div>
        <div class="member-holdings">${holdingsHtml || '<div style="color:var(--text-3);font-size:.8rem">No holdings found</div>'}</div>`;
    } else if (m.status === 'error') {
      bodyContent = `<div class="member-unconfigured"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><div class="member-error-msg">${m.error || 'API error'}</div></div>`;
    } else {
      bodyContent = `<div class="member-unconfigured"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg><span>Add API keys to .env to activate</span></div>`;
    }

    card.innerHTML = `
      <div class="member-card-top">
        <div class="member-avatar" style="color:${color};border-color:${color}40;background:${color}15">${m.letter}</div>
        <div class="member-info">
          <div class="member-name">${m.name}</div>
          <div class="member-status-row">
            <div class="member-status-dot ${statusClass}"></div>
            <span class="member-status-text">${statusText}</span>
          </div>
        </div>
        <div class="member-total-value" style="color:${m.status === 'ok' ? color : 'var(--text-3)'}">${totalStr}</div>
      </div>
      <div class="member-card-body">${bodyContent}</div>
      <div class="member-card-footer">
        ${m.status !== 'not_configured'
          ? `<button class="btn-view-member" style="--hover-color:${color}" onclick="showMemberView(${i})">View Details <span>→</span></button>`
          : `<div style="font-size:.75rem;color:var(--text-3);text-align:center">Configure in .env to enable</div>`}
      </div>`;

    // Hover color on the view button
    const btn = card.querySelector('.btn-view-member');
    if (btn) {
      btn.addEventListener('mouseenter', () => { btn.style.borderColor = color; btn.style.color = color; });
      btn.addEventListener('mouseleave', () => { btn.style.borderColor = ''; btn.style.color = ''; });
    }

    grid.appendChild(card);
  });
}

// ─── Render Member Detail ─────────────────────────────────────────────────────
function renderMemberDetail() {
  if (!memberData) return;
  const { name, letter, totalUsd, balances, walletsFound, fetchedAt, status } = memberData;
  const color = MEMBER_COLORS[currentMemberIndex];

  // Header
  document.getElementById('member-detail-title').textContent = `${letter} — ${name}`;
  document.getElementById('member-detail-title').style.color = color;
  document.getElementById('member-detail-status').textContent = walletsFound?.length ? `Scanning: ${walletsFound.join(' + ')}` : '';

  // Stats
  document.getElementById('stat-total-usd').textContent = formatUsd(totalUsd);
  document.getElementById('stat-asset-count').textContent = balances.length;
  const top = balances.find((b) => b.usdValue !== null);
  if (top) {
    document.getElementById('stat-top-asset').textContent = top.asset;
    const pct = totalUsd > 0 ? ((top.usdValue / totalUsd) * 100).toFixed(1) : 0;
    document.getElementById('stat-top-pct').textContent = `${pct}% of portfolio`;
  }
  const ago = Math.round((Date.now() - fetchedAt) / 1000);
  document.getElementById('stat-update-time').textContent = ago < 5 ? 'Updated just now' : `Updated ${ago}s ago`;
  document.getElementById('stat-asset-sub').textContent = walletsFound?.length ? `From: ${walletsFound.join(' + ')}` : 'Non-zero balances';

  // Chart
  const bar = document.getElementById('chart-bar');
  const legend = document.getElementById('chart-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  if (totalUsd > 0) {
    const withVal = balances.filter((b) => b.usdValue > 0);
    const top11 = withVal.slice(0, 11);
    const restVal = withVal.slice(11).reduce((s, b) => s + b.usdValue, 0);
    const segs = [...top11.map((b, i) => ({ label: b.asset, value: b.usdValue, color: CHART_COLORS[i] }))];
    if (restVal > 0) segs.push({ label: 'Others', value: restVal, color: '#474D57' });
    segs.forEach((s) => {
      const pct = (s.value / totalUsd) * 100;
      if (pct < 0.5) return;
      const el = document.createElement('div');
      el.className = 'chart-segment';
      el.style.flex = pct.toString();
      el.style.background = s.color;
      el.setAttribute('data-tooltip', `${s.label}: ${formatUsd(s.value)} (${pct.toFixed(1)}%)`);
      bar.appendChild(el);
      const li = document.createElement('div');
      li.className = 'legend-item';
      li.innerHTML = `<div class="legend-dot" style="background:${s.color}"></div><span>${s.label} <strong style="color:var(--text)">${pct.toFixed(1)}%</strong></span>`;
      legend.appendChild(li);
    });
  } else {
    bar.innerHTML = '<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:.82rem">No USD value data</div>';
  }

  // Table
  renderTable();
  setDotState('live');
  document.getElementById('refresh-label').textContent = `Next in ${secondsLeft}s`;
}

function renderTable() {
  if (!memberData) return;
  let sorted = [...memberData.balances];
  if (currentSort === 'usd')    sorted.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
  if (currentSort === 'name')   sorted.sort((a, b) => a.asset.localeCompare(b.asset));
  if (currentSort === 'amount') sorted.sort((a, b) => b.total - a.total);

  const tbody = document.getElementById('balance-tbody');
  tbody.innerHTML = '';
  sorted.forEach((row, i) => {
    const color = CHART_COLORS[row.asset.charCodeAt(0) % CHART_COLORS.length];
    const badges = (row.wallets || ['Spot']).map((w) => `<span class="wallet-badge wallet-badge--${w.toLowerCase()}">${w}</span>`).join('');
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${i * 25}ms`;
    tr.innerHTML = `
      <td class="row-index">${i + 1}</td>
      <td><div class="asset-cell">
        <div class="asset-icon" style="color:${color};border-color:${color}30;background:${color}15">${row.asset.slice(0,3)}</div>
        <div><div class="asset-name">${row.asset}</div><div class="wallet-badges">${badges}</div></div>
      </div></td>
      <td class="amount">${formatAmount(row.free)}</td>
      <td class="amount amount-locked">${formatAmount(row.locked)}</td>
      <td class="amount"><strong>${formatAmount(row.total)}</strong></td>
      <td class="price">${row.usdPrice !== null ? '$' + formatPrice(row.usdPrice) : '—'}</td>
      <td>${row.usdValue !== null ? `<span class="usd-value">${formatUsd(row.usdValue)}</span>` : '<span class="usd-unknown">No pair</span>'}</td>`;
    tbody.appendChild(tr);
  });
}

// ─── Sort ─────────────────────────────────────────────────────────────────────
function sortBy(key) {
  currentSort = key;
  document.querySelectorAll('.sort-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById(`sort-${key}`).classList.add('active');
  renderTable();
}

// ─── Countdown ────────────────────────────────────────────────────────────────
function resetCountdown(fetchFn) {
  clearInterval(countdownTimer);
  secondsLeft = 30;
  countdownTimer = setInterval(() => {
    secondsLeft--;
    const lbl = document.getElementById('refresh-label');
    if (lbl) lbl.textContent = `Next in ${secondsLeft}s`;
    if (secondsLeft <= 0) { clearInterval(countdownTimer); fetchFn(); }
  }, 1000);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setDotState(state) {
  const dot = document.getElementById('refresh-dot');
  dot.className = `refresh-dot ${state}`;
}
function showError(msg) {
  const b = document.getElementById('error-banner');
  if (b) { document.getElementById('error-text').textContent = msg; b.style.display = 'flex'; }
}
function hideError() {
  const b = document.getElementById('error-banner');
  if (b) b.style.display = 'none';
}
function formatUsd(v) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v ?? 0);
}
function formatAmount(v) {
  if (!v || v === 0) return '0';
  if (v < 0.000001) return v.toExponential(4);
  if (v < 0.01) return v.toFixed(8);
  if (v < 1) return v.toFixed(6);
  if (v < 1000) return v.toFixed(4);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(v);
}
function formatPrice(v) {
  if (v >= 1000) return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(6);
  return v.toFixed(8);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-refresh').onclick = fetchTeam;
  showTeamView();
});
