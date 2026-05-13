// ─── Lark App Bot — Interactive balance query via @mention ────────────────────
// Uses the Lark WebSocket (long connection) SDK to receive events on localhost
// without needing a public URL or ngrok.
//
// When someone @mentions the bot in a Lark group chat, it fetches:
//   1. Binance wallet balances for all 6 members
//   2. Vietnamese bank account total balance (via SePay API)
// Then replies with a formatted interactive card.

const Lark = require('@larksuiteoapi/node-sdk');
const axios = require('axios');
const { fetchTeamData } = require('./binance');

// ─── Format helpers ──────────────────────────────────────────────────────────
function fUsd(v) {
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v ?? 0);
}

function fVnd(v) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(v ?? 0);
}

// ─── Fetch Vietnamese bank balances from SePay ───────────────────────────────
async function fetchBankBalances() {
  const token = process.env.SEPAY_API_TOKEN;
  if (!token || token === 'your_sepay_api_token_here') {
    return { accounts: [], totalBalance: 0, error: 'SEPAY_API_TOKEN not configured' };
  }

  try {
    // Fetch recent transactions — the `accumulated` field gives the current balance
    const { data } = await axios.get('https://my.sepay.vn/userapi/transactions/list', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      params: { limit: 100 },
      timeout: 15000,
    });

    if (!Array.isArray(data.transactions) || data.transactions.length === 0) {
      return { accounts: [], totalBalance: 0, error: null };
    }

    // Group by account_number, take the latest accumulated balance per account
    const accountMap = {};
    for (const tx of data.transactions) {
      const accNum = tx.account_number;
      if (!accNum) continue;
      // Only keep the most recent transaction per account (list is newest-first)
      if (!accountMap[accNum]) {
        accountMap[accNum] = {
          accountNumber: accNum,
          bankName: tx.bank_brand_name || 'Unknown',
          balance: parseFloat(tx.accumulated) || 0,
          lastTransaction: tx.transaction_date,
        };
      }
    }

    const accounts = Object.values(accountMap);
    const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);

    return { accounts, totalBalance, error: null };
  } catch (err) {
    console.error('[SePay API]', err.response?.data || err.message);
    return { accounts: [], totalBalance: 0, error: err.message };
  }
}

// ─── Build the reply card ────────────────────────────────────────────────────
function buildReplyCard(teamData, bankData) {
  const { members, teamTotal, fetchedAt } = teamData;

  const time = new Date(fetchedAt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Bangkok',
  });

  // ── Binance section: one line per member ──
  const binanceLines = members.map((m) => {
    const emoji = m.status === 'ok' ? '🟢' : m.status === 'error' ? '🔴' : '⚫';
    const total = m.status === 'ok' ? `**$${fUsd(m.totalUsd)}**` : (m.status === 'error' ? '_Error_' : '_Not set_');
    return `${emoji}  ${m.name}　　${total}`;
  });

  // ── Bank section ──
  let bankLines = [];
  if (bankData.error && bankData.accounts.length === 0) {
    bankLines.push(`⚠️ ${bankData.error}`);
  } else if (bankData.accounts.length === 0) {
    bankLines.push('No bank accounts found');
  } else {
    bankData.accounts.forEach((a) => {
      bankLines.push(`🏦  ${a.bankName} (${a.accountNumber})　　**${fVnd(a.balance)}**`);
    });
  }

  const activeCount = members.filter((m) => m.status === 'ok').length;

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💰 Balance Report' },
      template: 'yellow',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `🕐 **${time}** (UTC+7)`,
        },
      },
      { tag: 'hr' },
      // ── Binance Wallet Section ──
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**💳 Binance Wallet**　　(${activeCount}/${members.length} active)`,
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: binanceLines.join('\n'),
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `──────────────────\n**Total: $${fUsd(teamTotal)} USD**`,
        },
      },
      { tag: 'hr' },
      // ── Vietnamese Bank Section ──
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**🏦 Vietnamese Bank**',
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: bankLines.join('\n'),
        },
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `──────────────────\n**Total balance: ${fVnd(bankData.totalBalance)}**`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: 'CheckBalance Bot  •  Binance API + SePay' }],
      },
    ],
  };
}

// ─── Handle the @mention event ───────────────────────────────────────────────
// Track processed message IDs to avoid duplicate replies (Lark may retry)
const processedMessages = new Set();
const MAX_PROCESSED = 500;

async function handleMention(data, client) {
  const messageId = data.message?.message_id;
  const chatId = data.message?.chat_id;

  if (!messageId || !chatId) {
    console.warn('[Lark Bot] Missing message_id or chat_id in event data');
    return;
  }

  // Deduplicate
  if (processedMessages.has(messageId)) {
    console.log('[Lark Bot] Duplicate event, skipping:', messageId);
    return;
  }
  processedMessages.add(messageId);
  if (processedMessages.size > MAX_PROCESSED) {
    const first = processedMessages.values().next().value;
    processedMessages.delete(first);
  }

  console.log('[Lark Bot] @mention received, fetching balances...');

  try {
    // Fetch both data sources in parallel
    const [teamData, bankData] = await Promise.all([
      fetchTeamData(),
      fetchBankBalances(),
    ]);

    const card = buildReplyCard(teamData, bankData);

    // Reply to the original message with the card
    const res = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });

    if (res.code === 0) {
      console.log('[Lark Bot] ✅ Balance reply sent successfully');
    } else {
      console.error('[Lark Bot] ❌ Reply failed:', res.code, res.msg);
    }
  } catch (err) {
    console.error('[Lark Bot] ❌ Error handling mention:', err.message);

    // Try to send a simple error reply
    try {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text: `❌ Error fetching balances: ${err.message}` }),
          msg_type: 'text',
        },
      });
    } catch { /* swallow error reply failure */ }
  }
}

// ─── Start the Lark WebSocket Bot ────────────────────────────────────────────
function startLarkBot() {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;

  if (!appId || !appSecret || appId === 'your_app_id_here') {
    console.log('   Lark App Bot: ⚫ Not configured (add LARK_APP_ID & LARK_APP_SECRET to .env)');
    return null;
  }

  // Create the API client (for sending replies)
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Lark,
  });

  // Create event dispatcher with message handler
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      // Process asynchronously so we don't block the 3s acknowledgement
      setImmediate(() => handleMention(data, client));
    },
  });

  // Start WebSocket connection (no public URL needed!)
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Lark,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  console.log('   Lark App Bot: ✅ WebSocket connected — @mention to query balances');

  return { client, wsClient };
}

module.exports = { startLarkBot };
