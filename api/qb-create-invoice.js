// Creates an invoice in QuickBooks from budget line items
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
  if (!res.ok) throw new Error('Token refresh failed');
  const newTokens = await res.json();
  const updated = {
    access_token: newTokens.access_token,
    refresh_token: newTokens.refresh_token,
    realm_id: tokens.realm_id,
    expires_at: Date.now() + newTokens.expires_in * 1000,
  };
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    await fetch(`${kvUrl}/set/qb_tokens`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(updated)),
    });
  }
  return updated;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    let tokens = await getTokens();
    if (!tokens) return res.status(401).json({ error: 'not_connected' });
    if (tokens.expires_at && Date.now() > tokens.expires_at - 300000) {
      tokens = await refreshAccessToken(tokens);
    }

    const { customerId, customerName, dueDate, memo, lines, terms } = req.body;

    if (!customerId || !lines || !lines.length) {
      return res.status(400).json({ error: 'customerId and lines are required' });
    }

    // Build QB Invoice object
    const invoiceLines = lines.map((line, i) => ({
      Id: String(i + 1),
      LineNum: i + 1,
      Description: line.description || '',
      Amount: Math.round((line.qty || 1) * (line.rate || 0) * 100) / 100,
      DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: {
        Qty: line.qty || 1,
        UnitPrice: line.rate || 0,
        TaxCodeRef: {
          value: line.vat === 20 || line.vat === '20' ? 'TAX' : 'NON',
        },
      },
    }));

    const invoice = {
      CustomerRef: { value: customerId, name: customerName },
      Line: invoiceLines,
      DueDate: dueDate || undefined,
      CustomerMemo: memo ? { value: memo } : undefined,
      SalesTermRef: terms ? { value: terms } : undefined,
    };

    // POST to QuickBooks
    const qbRes = await fetch(
      `${QB_API_BASE}/${tokens.realm_id}/invoice?minorversion=65`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(invoice),
      }
    );

    const qbData = await qbRes.json();

    if (!qbRes.ok) {
      console.error('QB_CREATE_INVOICE_ERROR|' + JSON.stringify(qbData));
      return res.status(qbRes.status).json({
        error: 'QB API error',
        detail: qbData,
      });
    }

    return res.status(200).json({
      ok: true,
      invoice: {
        id: qbData.Invoice?.Id,
        docNumber: qbData.Invoice?.DocNumber,
        totalAmt: qbData.Invoice?.TotalAmt,
        balance: qbData.Invoice?.Balance,
        customer: qbData.Invoice?.CustomerRef?.name,
        dueDate: qbData.Invoice?.DueDate,
      },
    });
  } catch (err) {
    console.error('QB_CREATE_INVOICE_ERROR|' + err.message);
    return res.status(500).json({ error: err.message });
  }
}
