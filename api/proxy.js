// Vercel serverless proxy — forwards requests to allowed Google Apps Script targets.

const ALLOWED_TARGETS = [
  "https://script.google.com/macros/s/AKfycbwXzqHGiGutRu3CoGAZTjI5c4VE_88Wmc6sipwrCoIJc-gqUC2rk3juhIOI6Eg6nzRp/exec",
];

export const config = {
  api: {
    bodyParser: false,
  },
};

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Determine which target to use from ?target= param, default to first
  const url = new URL(req.url, `https://${req.headers.host}`);
  const targetParam = url.searchParams.get("target");
  const targetIndex = targetParam !== null ? parseInt(targetParam, 10) : 0;
  const GAS_URL = ALLOWED_TARGETS[targetIndex];

  if (!GAS_URL) {
    return res.status(400).json({ error: "Invalid target index" });
  }

  try {
    if (req.method === "GET") {
      if (req.url && req.url.includes("url=1")) {
        return res.status(200).json({ GAS_URL });
      }
      const gasRes = await fetch(GAS_URL);
      const text = await gasRes.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(text);
    }

    if (req.method === "POST") {
      const rawBody = await readRawBody(req);

      let currentUrl = GAS_URL;
      let response;
      const trail = [];

      for (let hop = 0; hop < 6; hop++) {
        const isFirstHop = hop === 0;
        response = await fetch(currentUrl, {
          method: isFirstHop ? "POST" : "GET",
          headers: isFirstHop ? { "Content-Type": "application/json" } : {},
          body: isFirstHop ? rawBody : undefined,
          redirect: "manual",
        });

        const location = response.headers.get("location") || "";
        trail.push({ hop: hop + 1, method: isFirstHop ? "POST" : "GET", url: currentUrl, status: response.status, location });

        if (response.status >= 300 && response.status < 400 && location) {
          currentUrl = location;
        } else {
          break;
        }
      }

      const text = await response.text();

      console.log("PROXY|hops=" + trail.length
        + "|final_status=" + response.status
        + "|body_prefix=" + text.replace(/\s+/g, " ").substring(0, 200));

      trail.forEach(t =>
        console.log("HOP|" + t.hop + "|status=" + t.status + "|url=" + t.url + "|location=" + t.location)
      );

      return res.status(200).send(text);
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error("PROXY_ERROR|" + err.message + "|" + err.stack);
    return res.status(500).json({ error: err.message });
  }
}
