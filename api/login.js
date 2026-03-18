export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const { password } = req.body;

  if (password === process.env.AUTH_PASSWORD) {
    res.setHeader('Set-Cookie', 'ci_auth=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
    return res.status(200).json({ ok: true });
  }

  return res.status(401).json({ ok: false });
}
