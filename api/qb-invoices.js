// Fetches invoices from QuickBooks Online API
const QB_API_BASE =
  (process.env.QB_ENV === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com') + '/v3/company';

async function getTokens() {
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (kvUrl && kvToken) {
    const res = await fetch(`${kvUrl}/get/qb_tokens`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await res.json();
    if (data.result) return JSON.parse(data.result);
  }

  // Fallback to env vars
  if (process.env.QB_ACCESS_TOKEN) {
    return {
      access_token: process.env.QB_ACCESS_TOKEN,
      refresh_token: process.env.QB_REFRESH_TOKEN,
      realm_id: process.env.QB_REALM_ID,
      expires_at: 0,
    };
  }

  return null;
}

async function refreshAccessToken(tokens) {
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Token refresh failed: ' + err);
  }

  const newTokens = await res.json();

  const updated = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token,
    realm_id: tokens.realm_id,
    expires_at: Date.now() + newTokens.expires_in * 1000,
    refresh_expires_at:
      Date.now() + newTokens.x_refresh_token_expires_in * 1000,
  };

  // Save updated tokens to KV
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    await fetch(`${kvUrl}/set/qb_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updated),
    });
  }

  return updated;
}

async function queryQB(tokens, query) {
  const url = `${QB_API_BASE}/${tokens.realm_id}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`QB API error ${res.status}: ${err}`);
  }

  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let tokens = await getTokens();

    if (!tokens) {
      return res.status(401).json({
        error: 'not_connected',
        message: 'QuickBooks not connected. Visit /api/qb-auth to connect.',
      });
    }

    // Refresh if expired (with 5 min buffer)
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
      tokens = await refreshAccessToken(tokens);
    }

    // Determine what to fetch based on ?type= param
    const url = new URL(req.url, `https://${req.headers.host}`);
    const type = url.searchParams.get('type') || 'overdue';
    const fromDate = url.searchParams.get('from');
    const toDate = url.searchParams.get('to');

    // Reports use a different API path
    const isReport = type === 'pnl' || type === 'balancesheet' || type === 'txn-list' || type === 'pnl-class';

    if (isReport) {
      const reportMap = {
        pnl: 'ProfitAndLoss',
        balancesheet: 'BalanceSheet',
        'txn-list': 'TransactionList',
        'pnl-class': 'ProfitAndLoss',
      };
      const reportParams = new URLSearchParams({ minorversion: '65' });
      if (fromDate) reportParams.set('start_date', fromDate);
      if (toDate) reportParams.set('end_date', toDate);
      // TransactionList accepts additional filters
      if (type === 'txn-list') {
        const accountId = url.searchParams.get('account');
        // QB's TransactionList uses `source_account` to filter by the account
        // that a transaction posts to/from. `account` alone means something else.
        if (accountId) reportParams.set('source_account', accountId);
        const classId = url.searchParams.get('class');
        if (classId) reportParams.set('class', classId);
        // Request multiple amount columns so we can fall back if one is empty
        reportParams.set('columns', 'tx_date,txn_type,doc_num,name,memo,subt_nat_amount,nat_amount,credit_amt,debt_amt');
      }
      // P&L broken down by Class — pivot the report columns so each class is a separate column
      if (type === 'pnl-class') {
        reportParams.set('summarize_column_by', 'Classes');
        // If caller did not specify a date window, use an explicit wide range.
        // date_macro=All Dates is flaky on some report endpoints, explicit dates are reliable.
        if (!fromDate && !toDate) {
          reportParams.set('start_date', '2000-01-01');
          reportParams.set('end_date', '2099-12-31');
        }
      }
      // TransactionList with no date window defaults to all time too
      if (type === 'txn-list' && !fromDate && !toDate) {
        reportParams.set('start_date', '2000-01-01');
        reportParams.set('end_date', '2099-12-31');
      }
      const reportUrl = `${QB_API_BASE}/${tokens.realm_id}/reports/${reportMap[type]}?${reportParams.toString()}`;
      const reportRes = await fetch(reportUrl, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
        },
      });
      if (!reportRes.ok) {
        const err = await reportRes.text();
        throw new Error(`QB Report error ${reportRes.status}: ${err}`);
      }
      const reportData = await reportRes.json();
      return res.status(200).json(reportData);
    }

    let query;
    switch (type) {
      case 'overdue':
        query = `SELECT * FROM Invoice WHERE DueDate < '${new Date().toISOString().split('T')[0]}' AND Balance > '0' ORDERBY DueDate ASC`;
        break;
      case 'all':
        query = "SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 1000";
        break;
      case 'unpaid':
        query = "SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate ASC";
        break;
      case 'customers':
        query = "SELECT * FROM Customer MAXRESULTS 200";
        break;
      case 'classes':
        query = "SELECT * FROM Class MAXRESULTS 500";
        break;
      case 'payments':
        query = "SELECT * FROM Payment ORDERBY MetaData.CreateTime DESC MAXRESULTS 100";
        break;
      case 'estimates':
        query = "SELECT * FROM Estimate ORDERBY MetaData.CreateTime DESC MAXRESULTS 100";
        break;
      case 'credit-notes':
        query = "SELECT * FROM CreditMemo ORDERBY MetaData.CreateTime DESC MAXRESULTS 100";
        break;
      case 'expenses':
        query = "SELECT * FROM Purchase ORDERBY MetaData.CreateTime DESC MAXRESULTS 100";
        break;
      case 'bills':
        query = "SELECT * FROM Bill ORDERBY MetaData.CreateTime DESC MAXRESULTS 100";
        break;
      case 'accounts':
        query = "SELECT * FROM Account WHERE AccountType = 'Bank' ORDERBY Name ASC";
        break;
      case 'deposits':
        query = "SELECT * FROM Deposit ORDERBY TxnDate DESC MAXRESULTS 100";
        break;
      case 'transfers':
        query = "SELECT * FROM Transfer ORDERBY TxnDate DESC MAXRESULTS 50";
        break;
      default:
        query = "SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 50";
    }

    const data = await queryQB(tokens, query);
    return res.status(200).json(data);
  } catch (err) {
    console.error('QB_INVOICES_ERROR|' + err.message);

    if (err.message.includes('401') || err.message.includes('Token refresh failed')) {
      return res.status(401).json({
        error: 'auth_expired',
        message: 'QuickBooks session expired. Visit /api/qb-auth to reconnect.',
      });
    }

    return res.status(500).json({ error: err.message });
  }
}
