export default {
  async fetch(request) {
    const url = new URL(request.url);

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    if (url.pathname === "/") {
      return json({
        status: "MambaFX API running",
        endpoints: ["/health", "/signal", "/auth"]
      }, headers);
    }

    if (url.pathname === "/health") {
      return json({
        status: "OK",
        system: "MambaFX Backend",
        time: Date.now()
      }, headers);
    }

    if (url.pathname === "/signal") {
      return json({
        signal: Math.random() > 0.5 ? "ONLY_UP" : "ONLY_DOWN",
        confidence: Math.random()
      }, headers);
    }

    if (url.pathname === "/auth" && request.method === "POST") {
      const body = await request.json();

      return json({
        status: "authenticated",
        session: {
          token: body.token,
          created: Date.now()
        }
      }, headers);
    }

    return json({ error: "Not Found" }, headers, 404);
  }
};

function json(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers
  });
}
