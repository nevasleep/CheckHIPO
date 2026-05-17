const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

async function getSheetsClient() {
  const credsPath = path.resolve(process.cwd(), process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json');
  if (!fs.existsSync(credsPath)) {
    throw new Error(`Google credentials file not found at ${credsPath}`);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function appendBalanceRow(teamData) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

  if (!sheetId || sheetId === 'your_sheet_id_here') {
    throw new Error('GOOGLE_SHEET_ID is not configured in .env');
  }

  const sheets = await getSheetsClient();
  const { members, teamTotal, fetchedAt } = teamData;

  // Format date/time
  const timestamp = new Date(fetchedAt).toLocaleString('en-US', {
    timeZone: 'Asia/Bangkok',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });

  // Prepare values: Timestamp, Total, Member A ... Member F
  const values = [timestamp, teamTotal];
  members.forEach(m => {
    values.push(m.status === 'ok' ? m.totalUsd : (m.status === 'error' ? 'Error' : 'Not configured'));
  });

  const range = `${sheetName}!A:H`; // A to H (Timestamp + Total + 6 members)

  // Check if sheet is empty and needs headers
  try {
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1:H1`,
    });

    if (!getRes.data.values || getRes.data.values.length === 0) {
      // Append headers first
      const headers = ['Timestamp', 'Total USD', ...members.map(m => m.name)];
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [headers],
        },
      });
    }
  } catch (err) {
    if (err.message.includes('Unable to parse range')) {
        throw new Error(`Sheet tab named "${sheetName}" not found. Please create it or update GOOGLE_SHEET_NAME.`);
    }
    throw err;
  }

  // Append data row
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [values],
    },
  });

  return res.data;
}

// ─── Sheet 2: Transaction History ────────────────────────────────────────────

// In-memory set of known transaction unique IDs (for fast deduplication)
const knownTxIds = new Set();
let txIdsBootstrapped = false;

/**
 * Bootstrap the in-memory set by reading existing TX IDs from Sheet 2.
 * Column G (index 6) holds the unique ID. Called once on first sync.
 */
async function bootstrapKnownTxIds(sheets, sheetId, sheetName) {
  if (txIdsBootstrapped) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!G:G`, // uniqueId column
    });
    if (res.data.values) {
      res.data.values.forEach((row) => {
        if (row[0] && row[0] !== 'TX ID') knownTxIds.add(row[0]);
      });
    }
    console.log(`[Sheets] Bootstrapped ${knownTxIds.size} existing TX IDs from ${sheetName}`);
  } catch (err) {
    // Sheet might not exist yet or be empty — that's fine
    if (!err.message.includes('Unable to parse range')) {
      console.warn('[Sheets] Bootstrap warning:', err.message);
    }
  }
  txIdsBootstrapped = true;
}

/**
 * Append new transaction rows to Sheet 2.
 * Deduplicates using in-memory Set of unique IDs.
 * Auto-creates headers if sheet is empty.
 *
 * @param {Array} transactions - Array of normalized transaction objects from fetchAllTransactions()
 * @returns {{ appended: number, skipped: number }}
 */
async function appendTransactionRows(transactions) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET2_NAME || 'Sheet2';

  if (!sheetId || sheetId === 'your_sheet_id_here') {
    throw new Error('GOOGLE_SHEET_ID is not configured in .env');
  }

  const sheets = await getSheetsClient();

  // Bootstrap known IDs from sheet on first run
  await bootstrapKnownTxIds(sheets, sheetId, sheetName);

  // Filter out already-known transactions
  const newTxs = transactions.filter((tx) => !knownTxIds.has(tx.uniqueId));

  if (newTxs.length === 0) {
    return { appended: 0, skipped: transactions.length };
  }

  const range = `${sheetName}!A:G`;

  // Check if headers exist
  try {
    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${sheetName}!A1:G1`,
    });

    if (!getRes.data.values || getRes.data.values.length === 0) {
      // Write headers
      const headers = ['Date', 'Time', 'Employee Name', 'Sending/Receiving Address', 'Amount', 'Transaction Status', 'TX ID'];
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] },
      });
    }
  } catch (err) {
    if (err.message.includes('Unable to parse range')) {
      throw new Error(`Sheet tab named "${sheetName}" not found. Please create it in your Google Spreadsheet.`);
    }
    throw err;
  }

  // Build rows: Date, Time, Employee Name, Address, Amount, Status, TX ID
  const rows = newTxs.map((tx) => [
    tx.date,
    tx.time,
    tx.employeeName,
    tx.address,
    tx.amount,
    tx.status,
    tx.uniqueId,
  ]);

  // Append all new rows in one batch
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });

  // Add to in-memory set so we don't re-add them on next poll
  newTxs.forEach((tx) => knownTxIds.add(tx.uniqueId));

  return { appended: newTxs.length, skipped: transactions.length - newTxs.length };
}

module.exports = { appendBalanceRow, appendTransactionRows };
