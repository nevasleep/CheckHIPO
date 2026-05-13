const axios = require('axios');

// ─── Format helpers (server-side) ────────────────────────────────────────────
function fUsd(v) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v ?? 0);
}
function fAmt(v) {
  if (!v || v === 0) return '0';
  if (v < 0.01) return v.toFixed(6);
  if (v < 1000) return v.toFixed(4);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(v);
}

// ─── Build Lark Interactive Card ──────────────────────────────────────────────
function buildCard(teamData) {
  const { members, teamTotal, fetchedAt } = teamData;

  const time = new Date(fetchedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });

  // Build one column per member
  function memberColumn(m) {
    const emoji   = m.status === 'ok' ? '🟢' : m.status === 'error' ? '🔴' : '⚫';
    const total   = m.status === 'ok' ? `**$${fUsd(m.totalUsd)}**` : (m.status === 'error' ? '_Error_' : '_Not set_');

    let lines = [`${emoji} **${m.name}**`, total];
    if (m.status === 'ok' && m.balances.length > 0) {
      m.balances.slice(0, 2).forEach((b) => {
        const val = b.usdValue !== null ? `$${fUsd(b.usdValue)}` : fAmt(b.total);
        lines.push(`${b.asset}: ${val}`);
      });
    }

    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top',
      elements: [{
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') },
      }],
    };
  }

  const cols = members.map(memberColumn);
  const row1 = cols.slice(0, 3); // A B C
  const row2 = cols.slice(3, 6); // D E F

  const activeCount = members.filter((m) => m.status === 'ok').length;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💰 Team Balance Report' },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `🕐 **${time}**　　Team Total: **$${fUsd(teamTotal)} USD**　　${activeCount}/6 wallets active`,
        },
      },
      { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'none', background_style: 'grey', columns: row1 },
      { tag: 'hr' },
      { tag: 'column_set', flex_mode: 'none', background_style: 'grey', columns: row2 },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: 'Sent by CheckBalance Bot  •  Data from Binance API' }],
      },
    ],
  };
}

// ─── Send card to Lark webhook ────────────────────────────────────────────────
async function sendToLark(teamData) {
  const webhookUrl = process.env.LARK_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl === 'your_webhook_url_here') {
    throw new Error('LARK_WEBHOOK_URL is not configured in .env');
  }

  const payload = { msg_type: 'interactive', card: buildCard(teamData) };
  const res = await axios.post(webhookUrl, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });

  if (res.data?.code !== 0 && res.data?.StatusCode !== 0) {
    throw new Error(`Lark returned error: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

module.exports = { sendToLark };
