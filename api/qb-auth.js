// Initiates QuickBooks OAuth 2.0 flow — redirects user to Intuit login
export default function handler(req, res) {
  const clientId = process.env.QB_CLIENT_ID;
  const redirectUri = encodeURIComponent(
    'https://connectin-hub.vercel.app/api/qb-callback'
  );
  const scope = encodeURIComponent('com.intuit.quickbooks.accounting');
  const state = crypto.randomUUID();

  const authUrl =
    'https://appcenter.intuit.com/connect/oauth2' +
    `?client_id=${clientId}` +
    `&redirect_uri=${redirectUri}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&state=${state}`;

  res.redirect(302, authUrl);
}
