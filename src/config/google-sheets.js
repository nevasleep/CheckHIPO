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

// ─── Sheet 1: Delete old balance rows ───────────────────────────────────────

/**
 * Delete rows in GOOGLE_SHEET_NAME (So Du HIPO) whose timestamp is
 * 2 or more days before today.
 *
 * Rule: when this runs on Day N, delete rows from Day N-2 and earlier.
 * Example: runs May 23 → deletes May 21 and earlier, keeps May 22 & May 23.
 *
 * The timestamp column (A) is written by appendBalanceRow in the format:
 *   "May 22, 2026, 09:00:00 AM"  (en-US locale, Asia/Bangkok)
 * We parse the date part (first 3 tokens) to get the calendar day.
 */
async function deleteOldBalanceRows() {
  const sheetId   = process.env.GOOGLE_SHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

  if (!sheetId || sheetId === 'your_sheet_id_here') return;

  const sheets = await getSheetsClient();

  // Fetch all values from column A (timestamps)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!A:A`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return;

  // Cutoff: anything strictly before (today - 1 day) in Asia/Bangkok
  // i.e. keep today and yesterday, delete the day before yesterday and older.
  const nowBangkok = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' })
  );
  // Set to midnight of (today - 1 day) in Bangkok
  const cutoff = new Date(nowBangkok);
  cutoff.setDate(cutoff.getDate() - 1);
  cutoff.setHours(0, 0, 0, 0);

  // Get the spreadsheet metadata to find the sheet's numeric ID
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const sheetObj = meta.data.sheets.find(
    (s) => s.properties.title === sheetName
  );
  if (!sheetObj) {
    console.warn(`[Sheets Cleanup] Sheet "${sheetName}" not found.`);
    return;
  }
  const sheetNumericId = sheetObj.properties.sheetId;

  // Collect row indices to delete (0-indexed; row 0 = header, skip it)
  const toDelete = [];
  for (let i = 1; i < rows.length; i++) {
    const cell = (rows[i] && rows[i][0]) ? rows[i][0] : '';
    if (!cell) continue;

    // Parse the date portion from the timestamp string
    // e.g. "May 22, 2026, 09:00:00 AM" → new Date("May 22, 2026")
    const datePart = cell.split(',').slice(0, 2).join(',').trim(); // "May 22, 2026"
    const rowDate = new Date(datePart);
    if (isNaN(rowDate.getTime())) continue; // skip unparseable cells (e.g. header)

    // If the row's date is strictly before the cutoff day, mark for deletion
    if (rowDate < cutoff) {
      toDelete.push(i); // 0-indexed row number in the sheet data array
    }
  }

  if (toDelete.length === 0) {
    console.log('[Sheets Cleanup] No old rows to delete.');
    return;
  }

  // Build deleteDimension requests — must be processed in reverse order
  // so that deleting earlier rows doesn't shift later indices.
  const requests = toDelete
    .sort((a, b) => b - a) // descending
    .map((rowIdx) => ({
      deleteDimension: {
        range: {
          sheetId:    sheetNumericId,
          dimension:  'ROWS',
          startIndex: rowIdx,     // 0-indexed, inclusive
          endIndex:   rowIdx + 1, // exclusive
        },
      },
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody:   { requests },
  });

  const cutoffLabel = cutoff.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  console.log(`[Sheets Cleanup] ✅ Deleted ${toDelete.length} row(s) older than ${cutoffLabel} from "${sheetName}".`);
}

module.exports = { appendBalanceRow, appendTransactionRows, deleteOldBalanceRows };
