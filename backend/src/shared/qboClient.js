const axios = require('axios');
const { getSecretJson } = require('./secretsManager');

const TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTHORIZE_ENDPOINT = 'https://appcenter.intuit.com/connect/oauth2';

async function getAppSecrets() {
  return getSecretJson(process.env.APP_SECRETS_ARN);
}

function getApiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

async function buildAuthorizeUrl(state) {
  const { qboClientId, qboRedirectUri } = await getAppSecrets();
  const params = new URLSearchParams({
    client_id: qboClientId,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: qboRedirectUri,
    state,
  });
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

async function tokenRequest(formParams) {
  const { qboClientId, qboClientSecret } = await getAppSecrets();
  const basicAuth = Buffer.from(`${qboClientId}:${qboClientSecret}`).toString('base64');

  const { data } = await axios.post(TOKEN_ENDPOINT, formParams.toString(), {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: data.expires_in,
  };
}

async function exchangeCodeForTokens(code) {
  const { qboRedirectUri } = await getAppSecrets();
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: qboRedirectUri,
    })
  );
}

async function refreshAccessToken(refreshToken) {
  return tokenRequest(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
  );
}

async function apiGet(realmId, path, accessToken) {
  const { qboEnvironment } = await getAppSecrets();
  const { data } = await axios.get(`${getApiBase(qboEnvironment)}/v3/company/${realmId}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  return data;
}

// Runs a QBO query, paging through results 1000 rows at a time.
async function runQuery(realmId, accessToken, entity) {
  const results = [];
  let startPosition = 1;
  const pageSize = 1000;

  for (;;) {
    const query = encodeURIComponent(
      `SELECT * FROM ${entity} STARTPOSITION ${startPosition} MAXRESULTS ${pageSize}`
    );
    const data = await apiGet(realmId, `/query?query=${query}`, accessToken);
    const rows = data.QueryResponse?.[entity] || [];
    results.push(...rows);
    if (rows.length < pageSize) break;
    startPosition += pageSize;
  }

  return results;
}

async function queryAccounts(realmId, accessToken) {
  return runQuery(realmId, accessToken, 'Account');
}

async function queryClasses(realmId, accessToken) {
  return runQuery(realmId, accessToken, 'Class');
}

async function getGeneralLedgerReport(realmId, accessToken, startDate, endDate) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    columns: 'tx_date,txn_type,doc_num,name,memo,klass_name,debt_amt,credit_amt',
    accounting_method: 'Accrual',
  });
  return apiGet(realmId, `/reports/GeneralLedger?${params.toString()}`, accessToken);
}

// QBO's GeneralLedger report nests transaction rows inside a "Section" row
// per account (Header.ColData[0].value holds the account label, commonly
// formatted as "<code> <name>", e.g. "502050 Admin Salaries"). This walks
// the tree and flattens it into one row per transaction line.
function flattenGeneralLedgerReport(report) {
  const columns = (report.Columns?.Column || []).map((c) => c.ColType);
  const colIndex = (type) => columns.indexOf(type);
  const rows = [];

  function splitAccountLabel(label) {
    const match = /^(\S+)\s+(.+)$/.exec(label || '');
    return match ? { code: match[1], name: match[2] } : { code: null, name: label || null };
  }

  function walk(node, currentAccount) {
    const sectionRows = node.Rows?.Row || [];
    for (const row of sectionRows) {
      if (row.type === 'Section') {
        const label = row.Header?.ColData?.[0]?.value;
        const account = label ? splitAccountLabel(label) : currentAccount;
        walk(row, account);
      } else if (row.ColData && currentAccount) {
        const get = (type) => {
          const idx = colIndex(type);
          return idx >= 0 ? row.ColData[idx]?.value : undefined;
        };

        const debit = parseFloat(get('debt_amt')) || 0;
        const credit = parseFloat(get('credit_amt')) || 0;

        rows.push({
          transactionDate: get('tx_date') || null,
          accountCode: currentAccount.code,
          accountName: currentAccount.name,
          className: get('klass_name') || null,
          debit,
          credit,
          amount: debit - credit,
          transactionType: get('txn_type') || null,
          description: get('memo') || null,
          qboTransactionId: get('doc_num') || null,
        });
      }
    }
  }

  walk(report, null);
  return rows;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  queryAccounts,
  queryClasses,
  getGeneralLedgerReport,
  flattenGeneralLedgerReport,
};
