const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
require('dotenv').config();

const _proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const PROXY_CONFIG = _proxyUrl
  ? { httpsAgent: new HttpsProxyAgent(_proxyUrl), proxy: false }
  : {};

let _tenantAccessToken = null;
let _tokenExpireAt = 0;

// Authenticate and get Tenant Access Token
async function getTenantAccessToken() {
  if (_tenantAccessToken && Date.now() < _tokenExpireAt) {
    return _tenantAccessToken;
  }

  const res = await axios.post('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: process.env.LARK_APP_ID,
    app_secret: process.env.LARK_APP_SECRET
  }, PROXY_CONFIG);

  if (res.data.code !== 0) {
    throw new Error('Failed to get Lark tenant_access_token: ' + JSON.stringify(res.data));
  }

  _tenantAccessToken = res.data.tenant_access_token;
  _tokenExpireAt = Date.now() + (res.data.expire - 300) * 1000; // refresh 5 mins before expiry
  return _tenantAccessToken;
}

/**
 * Uploads a transaction to Lark Base table tblEDlO99GZj8I8K
 */
async function uploadTransactionToBase(wallet, tx) {
  const appToken = 'WF5ebtzvhaQ60OsLC0ilbwf1gvc';
  const tableId = 'tblEDlO99GZj8I8K';

  // Format Date (Vietnam timezone UTC+7)
  const TIMEZONE_OFFSET = parseInt(process.env.TIMEZONE_OFFSET_HOURS || '7', 10);
  const d = new Date(Number(tx.timestamp) * 1000);
  const local = new Date(d.getTime() + TIMEZONE_OFFSET * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const timeStr = `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)}/${local.getUTCFullYear()} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;

  // Amount
  const amount = (Number(tx.rawAmount) / Math.pow(10, wallet.decimals)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

  // Explorer link
  const txLink = wallet.type === 'tron'
    ? `https://tronscan.org/#/transaction/${tx.hash}`
    : `${wallet.explorer}/tx/${tx.hash}`;

  // Recipient check
  const dungWallet = 'TEskfVDdvuRXVA6UzVTABEsh13wex7xTzc'.toLowerCase();
  const isDung = tx.to && tx.to.toLowerCase() === dungWallet;
  const nguoiXin = isDung ? 'Nguyen Dinh Dung' : 'Người Xin Không Phải Dũng';

  // From address
  const fromAddr = tx.from || '';

  const amountNum = Number(tx.rawAmount) / Math.pow(10, wallet.decimals);

  const record = {
    fields: {
      'Date': timeStr,
      'Văn Bản': 'Checked',
      'Số Tiền': amountNum,
      'Người Xin': nguoiXin,
      'Bill Thanh Toán': { link: txLink, text: txLink },
      'Trạng Thái': 'Hoàn Thành',
      'Nguồn Tiền': `${fromAddr} + ${wallet.chain} + Anh Đức`
    }
  };

  const token = await getTenantAccessToken();

  const res = await axios.post(`https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, record, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...PROXY_CONFIG
  });

  if (res.data.code !== 0) {
    throw new Error('Lark Base Write Error: ' + JSON.stringify(res.data));
  }

  return res.data;
}

module.exports = { uploadTransactionToBase };
