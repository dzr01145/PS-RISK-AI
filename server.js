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
const primaryModel = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-flash-latest";
const fallbackModel = process.env.GOOGLE_GEMINI_FALLBACK_MODEL || "gemini-1.5-flash-latest";

const isHealthCheck = (req) => {
  const userAgent = req.headers["user-agent"] || "";
  return req.path === "/healthz"
    || req.method === "HEAD"
    || req.headers["x-render-health-check"] === "true"
    || userAgent.includes("Render/health-check");
};

const timingSafeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
};

const demandAuth = (res) => {
  res.setHeader("WWW-Authenticate", "Basic realm=\"Restricted Area\"");
  return res.status(401).send("Authentication required");
};

const basicAuth = (req, res, next) => {
  if (isHealthCheck(req)) {
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) {
    return demandAuth(res);
  }

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
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
    model: primaryModel,
    fallbackModel
  });
});

app.head("/healthz", (_req, res) => {
  res.status(200).end();
});

app.use(basicAuth);
app.use(express.json());
app.use(express.static(publicDir, { extensions: ["html"] }));

const buildGeminiPayload = (history, message) => {
  const sanitizedHistory = Array.isArray(history) ? history : [];
  const contents = sanitizedHistory
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
    "あなたは「ブルーシールド・リスクカウンシル」という名称のエキスパートコンサルタントです。",
    "専門領域は製品安全、製造物責任（PL）、品質管理、品質不正対応、国内外のリコール実務です。",
    "落ち着いたビジネス日本語を用い、次の観点を含む構成で整理してください。",
    "1. 背景整理と課題の仮説",
    "2. 想定される法的・レピュテーションリスク",
    "3. 実務的な対応策・チェック項目（必要に応じて箇条書き）",
    "4. 次に検討すべきアクションとフォローアップ",
    "回答の最後には状況把握に役立つ確認質問を一つ添えてください。"
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
      maxOutputTokens: 768
    }
  };
};

const callGemini = async (model, body, key) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body
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

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message が空です。" });
  }

  if (!apiKey) {
    return res.status(503).json({
      error: "GOOGLE_API_KEY が設定されていません。Render の環境変数にキーを登録してください。"
    });
  }

  const payload = JSON.stringify(buildGeminiPayload(history, message.trim()));

  try {
    let result = await callGemini(primaryModel, payload, apiKey);
    let activeModel = primaryModel;
    let notice;

    if (!result.ok && result.status === 404 && primaryModel !== fallbackModel) {
      console.warn(`[Gemini] Model ${primaryModel} returned 404, attempting fallback ${fallbackModel}`);
      const fallbackResult = await callGemini(fallbackModel, payload, apiKey);
      if (fallbackResult.ok) {
        result = fallbackResult;
        activeModel = fallbackModel;
        notice = `指定モデル ${primaryModel} が利用できないため、${fallbackModel} で回答しました。`;
      } else {
        result.detail += `\nFallback (${fallbackModel}) failed: ${fallbackResult.detail}`;
        result.status = fallbackResult.status;
      }
    }

    if (!result.ok) {
      let detailMessage = result.detail;
      try {
        const json = JSON.parse(result.detail);
        detailMessage = json?.error?.message || result.detail;
      } catch {
        // keep original text
      }

      return res.status(result.status).json({
        error: `Gemini API 呼び出しに失敗しました (${result.status})`,
        details: detailMessage
      });
    }

    const parts = result.data?.candidates?.[0]?.content?.parts;
    const reply = Array.isArray(parts)
      ? parts.map((part) => part?.text || "").join("\n").trim()
      : "";

    if (!reply) {
      return res.status(502).json({
        error: "Gemini API から有効な返答が得られませんでした。"
      });
    }

    return res.json({
      reply,
      notice: notice || `${result.model || activeModel} で応答しました。`
    });
  } catch (error) {
    return res.status(500).json({
      error: "サーバー内でエラーが発生しました。",
      details: error.message
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Risk advisor server listening on port ${port}`);
});
