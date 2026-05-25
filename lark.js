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

// ─── Wallet Transaction Alert → Lark ─────────────────────────────────────────

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function buildWalletAlertCard(wallet, tx) {
  const isIn      = tx.direction === 'in';
  const colour    = isIn ? 'green' : 'red';
  const dirLabel  = isIn ? '🟢 Incoming Transaction' : '🔴 Outgoing Transaction';
  const sign      = isIn ? '+' : '-';
  const decimals  = wallet.decimals;
  const amount    = (Number(tx.rawAmount) / Math.pow(10, decimals))
    .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

  const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET_HOURS || '7', 10);
  const d     = new Date(Number(tx.timestamp) * 1000);
  const local = new Date(d.getTime() + TIMEZONE_OFFSET * 3600 * 1000);
  const pad   = (n) => String(n).padStart(2, '0');
  const time  = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
                `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} (UTC+${TIMEZONE_OFFSET})`;

  const txLink = wallet.type === 'tron'
    ? `https://tronscan.org/#/transaction/${tx.hash}`
    : `${wallet.explorer}/tx/${tx.hash}`;

  const fromAddr = isIn ? shortAddr(tx.from) : shortAddr(wallet.address);
  const toAddr   = isIn ? shortAddr(wallet.address) : shortAddr(tx.to);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: dirLabel },
      template: colour,
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `📌 **Chain:** ${wallet.chain}`,
            `🪙 **Token:** ${wallet.token}`,
          ].join('\n'),
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${sign}${amount} ${wallet.token}**`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            `📤 **From:** \`${fromAddr}\``,
            `📬 **To:**   \`${toAddr}\``,
          ].join('\n'),
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 View on Explorer' },
            type: 'url',
            url: txLink,
          },
        ],
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `⏰ ${time}  •  CheckBalance Wallet Monitor` }],
      },
    ],
  };
}

/**
 * Send a wallet transaction alert to the dedicated Lark wallet-alerts group.
 * Uses LARK_WALLET_WEBHOOK_URL (separate from the daily balance report webhook).
 */
async function sendWalletAlertToLark(wallet, tx) {
  // Collect all configured wallet webhook URLs (LARK_WALLET_WEBHOOK_URL, LARK_WALLET2_WEBHOOK_URL, …)
  const urls = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('LARK_WALLET') && k.endsWith('_WEBHOOK_URL') && v && !v.includes('your_wallet'))
    .map(([, v]) => v);

  if (urls.length === 0) return; // none configured — silently skip

  const payload = { msg_type: 'interactive', card: buildWalletAlertCard(wallet, tx) };

  // Fire all webhooks in parallel; collect results so one failure doesn't block others
  const results = await Promise.allSettled(
    urls.map((url) =>
      axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      })
    )
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[Lark Wallet Alert] Webhook #${i + 1} failed:`, r.reason?.message);
    } else if (r.value.data?.code !== 0 && r.value.data?.StatusCode !== 0) {
      console.error(`[Lark Wallet Alert] Webhook #${i + 1} non-zero response:`, JSON.stringify(r.value.data));
    }
  });
}

module.exports = { sendToLark, sendWalletAlertToLark };
