// Handles QuickBooks OAuth callback — exchanges code for tokens and stores them
export default async function handler(req, res) {
  const { code, realmId, error, error_description, state } = req.query;

  if (error) {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:40px;background:#0b0f1a;color:#e8edf5;">
        <h2 style="color:#ef4444;">QuickBooks Authorization Error</h2>
        <p><strong>Error:</strong> ${error}</p>
        <p><strong>Description:</strong> ${error_description || 'No description provided'}</p>
        <p style="color:#6b7a99;">This usually means the redirect URI is not registered in your Intuit app's Production tab, or the user denied access.</p>
        <a href="/api/qb-auth" style="color:#00d4aa;">Try again →</a>
      </body></html>`
    );
  }

  if (!code || !realmId) {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:40px;background:#0b0f1a;color:#e8edf5;">
        <h2 style="color:#ef4444;">Missing code or realmId from QuickBooks</h2>
        <p>The callback was hit but the expected OAuth parameters were missing.</p>
        <p><strong>Received query params:</strong></p>
        <pre style="background:#111827;padding:16px;border-radius:8px;overflow-x:auto;">${JSON.stringify(req.query, null, 2)}</pre>
        <p style="color:#6b7a99;">Most likely cause: the redirect URI <code>https://connectin-hub.vercel.app/api/qb-callback</code> is not added under the <strong>Production</strong> tab on the Intuit Developer Portal (Settings → Redirect URIs → Production).</p>
        <a href="/api/qb-auth" style="color:#00d4aa;">Try again →</a>
      </body></html>`
    );
  }

  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  const redirectUri = 'https://connectin-hub.vercel.app/api/qb-callback';

  // Exchange authorization code for tokens
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const tokenRes = await fetch(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      }
    );

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('QB_TOKEN_ERROR|' + err);
      return res.status(500).send(
        `<html><body style="font-family:sans-serif;padding:40px;background:#0b0f1a;color:#e8edf5;">
          <h2 style="color:#ef4444;">Token Exchange Failed</h2>
          <p>Status: ${tokenRes.status}</p>
          <pre style="background:#111827;padding:20px;border-radius:8px;overflow-x:auto;color:#f87171;">${err}</pre>
          <p style="color:#6b7a99;">Client ID present: ${!!clientId} | Client Secret present: ${!!clientSecret}</p>
          <p style="color:#6b7a99;">Check your QB_CLIENT_ID and QB_CLIENT_SECRET env vars in Vercel, then redeploy.</p>
          <a href="/api/qb-auth" style="color:#00d4aa;">Try again →</a>
        </body></html>`
      );
    }

    const tokens = await tokenRes.json();

    // Store tokens in Vercel KV
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      // Fallback: show tokens for manual env var setup
      return res.status(200).send(`
        <html><body style="font-family:sans-serif;padding:40px;background:#0b0f1a;color:#e8edf5;">
          <h2 style="color:#00d4aa;">QuickBooks Connected!</h2>
          <p>Vercel KV is not configured. Please add these env vars to your Vercel project:</p>
          <pre style="background:#111827;padding:20px;border-radius:8px;overflow-x:auto;">
QB_REALM_ID=${realmId}
QB_ACCESS_TOKEN=${tokens.access_token}
QB_REFRESH_TOKEN=${tokens.refresh_token}
          </pre>
          <p style="color:#6b7a99;">Access token expires in ${tokens.expires_in}s. Refresh token expires in ${tokens.x_refresh_token_expires_in}s.</p>
          <p>For automatic token management, set up <strong>Vercel KV</strong> on your project.</p>
          <a href="/financials" style="color:#00d4aa;">← Back to Financials</a>
        </body></html>
      `);
    }

    // Store in Vercel KV
    const tokenData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      realm_id: realmId,
      expires_at: Date.now() + tokens.expires_in * 1000,
      refresh_expires_at:
        Date.now() + tokens.x_refresh_token_expires_in * 1000,
    };

    await fetch(`${kvUrl}/set/qb_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(JSON.stringify(tokenData)),
    });

    res.redirect(302, '/financials?qb=connected');
  } catch (err) {
    console.error('QB_CALLBACK_ERROR|' + err.message);
    return res.status(500).send('OAuth callback failed: ' + err.message);
  }
}
