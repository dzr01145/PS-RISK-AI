import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const basicAuthUser = process.env.BASIC_AUTH_USER || "admin";
const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD || "123";
const apiKey = process.env.GOOGLE_API_KEY;
const geminiModel = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash-latest";
const fallbackGeminiModel = process.env.GOOGLE_GEMINI_FALLBACK_MODEL || "gemini-1.5-flash-latest";

const isHealthCheckRequest = (req) => {
  const userAgent = req.headers["user-agent"] || "";
  return req.path === "/healthz"
    || req.headers["x-render-health-check"] === "true"
    || userAgent.includes("Render/health-check");
};

const timingSafeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
};

const demandAuth = (res) => {
  res.setHeader("WWW-Authenticate", "Basic realm=\"Restricted Area\"");
  return res.status(401).send("Authentication required");
};

const basicAuth = (req, res, next) => {
  if (isHealthCheckRequest(req)) {
    return next();
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) {
    return demandAuth(res);
  }
  const base64Credentials = header.slice(6);
  let decoded;
  try {
    decoded = Buffer.from(base64Credentials, "base64").toString("utf8");
  } catch {
    return demandAuth(res);
  }
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) {
    return demandAuth(res);
  }
  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  if (!timingSafeEqual(username, basicAuthUser) || !timingSafeEqual(password, basicAuthPassword)) {
    return demandAuth(res);
  }
  return next();
};

app.get("/healthz", (req, res) => {
  res.status(200).json({
    status: "ok",
    model: geminiModel,
    fallbackModel: fallbackGeminiModel
  });
});

app.head("/healthz", (req, res) => {
  res.status(200).end();
});

app.use(basicAuth);
app.use(express.json());
app.use(express.static(publicDir, { extensions: ["html"] }));

const buildGeminiRequest = (history, message) => {
  const conversation = Array.isArray(history) ? history : [];
  const contents = conversation
    .filter((entry) => entry && typeof entry.text === "string")
    .map((entry) => ({
      role: entry.role === "model" ? "model" : "user",
      parts: [{ text: entry.text }]
    }));

  contents.push({
    role: "user",
    parts: [{ text: message }]
  });

  const systemPrompt = [
    "\u3042\u306a\u305f\u306f\u300c\u30d6\u30eb\u30fc\u30b7\u30fc\u30eb\u30c9\u30fb\u30ea\u30b9\u30af\u30a2\u30c9\u30d0\u30a4\u30b6\u30fc\u300d\u3068\u3044\u3046\u540d\u79f0\u306e\u30a8\u30ad\u30b9\u30d1\u30fc\u30c8\u30b3\u30f3\u30b5\u30eb\u30bf\u30f3\u30c8\u3067\u3059\u3002",
    "\u5c02\u9580\u9818\u57df\u306f\u88fd\u54c1\u5b89\u5168\u3001\u88fd\u9020\u7269\u8cac\u4efb\uff08PL\uff09\u3001\u54c1\u8cea\u7ba1\u7406\u3001\u54c1\u8cea\u4e0d\u6b63\u5bfe\u5fdc\u3001\u56fd\u5185\u5916\u306e\u30ea\u30b3\u30fc\u30eb\u5b9f\u52d9\u3067\u3059\u3002",
    "\u843d\u3061\u7740\u3044\u305f\u30d3\u30b8\u30cd\u30b9\u65e5\u672c\u8a9e\u3092\u7528\u3044\u3001",
    "\u0031\u0029\u0020\u76f8\u8ac7\u5185\u5bb9\u306e\u80cc\u666f\u6574\u7406\u3001\u0032\u0029\u0020\u60f3\u5b9a\u30ea\u30b9\u30af\u3068\u95a2\u9023\u6cd5\u898f\u3001\u0033\u0029\u0020\u5177\u4f53\u7684\u306a\u5bfe\u5fdc\u7b56\u3068\u30c1\u30a7\u30c3\u30af\u9805\u76ee\u3001\u0034\u0029\u0020\u6b21\u306b\u691c\u8a0e\u3059\u3079\u304d\u30a2\u30af\u30b7\u30e7\u30f3",
    "\u3092\u660e\u78ba\u306b\u63d0\u793a\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u5fc5\u8981\u306b\u5fdc\u3058\u3066\u7b87\u6761\u66f8\u304d\u3092\u6d3b\u7528\u3057\u3001\u5b9f\u52d9\u306b\u5f79\u7acb\u3064\u8996\u70b9\u3092\u6dfb\u3048\u307e\u3059\u3002",
    "\u56de\u7b54\u306e\u6700\u5f8c\u306b\u306f\u72b6\u6cc1\u628a\u63e1\u306b\u5f79\u7acb\u3064\u30d5\u30a9\u30ed\u30fc\u30a2\u30c3\u30d7\u8cea\u554f\u3092\u4e00\u3064\u6dfb\u3048\u3066\u304f\u3060\u3055\u3044\u3002"
  ].join("\n");

  return {
    contents,
    systemInstruction: {
      role: "system",
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
      maxOutputTokens: 512
    }
  };
};

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message \u304c\u7a7a\u3067\u3059\u3002" });
  }

  if (!apiKey) {
    return res.status(503).json({
      error: "GOOGLE_API_KEY \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002Render \u306e\u74b0\u5883\u5909\u6570\u306b\u30ad\u30fc\u3092\u767b\u9332\u3057\u3066\u304f\u3060\u3055\u3044\u3002"
    });
  }

  const payload = JSON.stringify(buildGeminiRequest(history, message));

  const callGemini = async (model) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(`${url}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, detail: text, model };
    }
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { ok: true, data, model };
  };

  try {
    let primaryResult = await callGemini(geminiModel);
    let activeModel = geminiModel;
    let fallbackNotice;

    if (!primaryResult.ok && primaryResult.status === 404 && geminiModel !== fallbackGeminiModel) {
      console.warn(`[Gemini] Model ${geminiModel} returned 404. Trying fallback model ${fallbackGeminiModel}.`);
      const fallbackResult = await callGemini(fallbackGeminiModel);
      if (fallbackResult.ok) {
        primaryResult = fallbackResult;
        activeModel = fallbackGeminiModel;
        fallbackNotice = `\u6307\u5b9a\u30e2\u30c7\u30eb ${geminiModel}\u0020\u304c\u898b\u3064\u304b\u3089\u306a\u304b\u3063\u305f\u305f\u3081\u3001${fallbackGeminiModel}\u0020\u3067\u5fdc\u7b54\u3057\u307e\u3057\u305f\u3002`;
      } else {
        primaryResult.detail += `\nFallback attempt (${fallbackGeminiModel}) also failed: ${fallbackResult.detail}`;
        primaryResult.status = fallbackResult.status;
      }
    }

    if (!primaryResult.ok) {
      let detailMessage = primaryResult.detail;
      try {
        const json = JSON.parse(primaryResult.detail);
        detailMessage = json?.error?.message || primaryResult.detail;
      } catch {
        // keep raw detail
      }
      return res.status(primaryResult.status).json({
        error: `\u0047\u0065\u006d\u0069\u006e\u0069\u0020\u0041\u0050\u0049\u0020\u547c\u3073\u51fa\u3057\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u0020\u0028${primaryResult.status}\u0029`,
        details: detailMessage
      });
    }

    const parts = primaryResult.data?.candidates?.[0]?.content?.parts;
    const reply = Array.isArray(parts)
      ? parts.map((part) => part?.text || "").join("\n").trim()
      : "";

    if (!reply) {
      return res.status(502).json({
        error: "\u0047\u0065\u006d\u0069\u006e\u0069\u0020\u0041\u0050\u0049\u0020\u304b\u3089\u6709\u52b9\u306a\u8fd4\u7b54\u304c\u5f97\u3089\u308c\u307e\u305b\u3093\u3067\u3057\u305f\u3002"
      });
    }

    return res.json({
      reply,
      notice: fallbackNotice || `${primaryResult.model || activeModel}\u0020\u3067\u5fdc\u7b54\u3057\u307e\u3057\u305f\u3002`
    });
  } catch (error) {
    return res.status(500).json({
      error: "\u30b5\u30fc\u30d0\u30fc\u5185\u3067\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002",
      details: error.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Akane chatbot server listening on port ${port}`);
});
