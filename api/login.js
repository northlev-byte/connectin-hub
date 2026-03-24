// In-memory rate limiting (persists across warm invocations of the same serverless instance)
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const times = (attempts.get(ip) || []).filter(t => now - t < WINDOW_MS);
  attempts.set(ip, times);
  return times.length >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const times = attempts.get(ip) || [];
  times.push(Date.now());
  attempts.set(ip, times);
}

export default function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const ip = getIP(req);

  if (isRateLimited(ip)) {
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }

  const { password } = req.body;

  if (password === process.env.AUTH_PASSWORD) {
    const sevenDays = 7 * 24 * 60 * 60;
    res.setHeader('Set-Cookie', `ci_auth=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sevenDays}`);
    return res.status(200).json({ ok: true });
  }

  recordFailedAttempt(ip);
  return res.status(401).json({ ok: false, error: 'invalid_password' });
}
