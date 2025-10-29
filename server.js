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
const primaryModel = process.env.GOOGLE_GEMINI_MODEL || "gemini-2.5-pro";
const fallbackModel = process.env.GOOGLE_GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-latest";

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

app.get("/healthz", (_req, res) => {
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
    "あなたは国内外の製品安全・製造物責任・品質管理リスクに精通した信頼できるアドバイザリーチャットボットです。",
    "主な領域は製品事故、PL訴訟、品質不正、リコール対応、危機管理、危機広報です。",
    "実務担当者がすぐ動けるアクションリストと意思決定の勘所を、根拠と前提を添えて提示してください。",
    "1. 初動対応・証拠保全・安全確保のポイント",
    "2. 規制当局・被害者・顧客・サプライヤーとのコミュニケーション方針",
    "3. 社内危機対策本部の体制整備と役割分担",
    "4. 再発防止、品質改善、ナレッジ共有のフォローアップ",
    "回答は日本語で、必要に応じて国内外の法令・規制を踏まえながら冷静に助言してください。",
    "全体でおおむね3000文字以内に収め、断定を避けつつも実行につながる提案を行ってください。"
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

const extractTextFromParts = (parts) => {
  if (!Array.isArray(parts)) return "";

  return parts
    .map((part) => {
      if (typeof part?.text === "string") {
        return part.text;
      }
      if (typeof part?.functionCall?.name === "string") {
        const args = part.functionCall.args ? JSON.stringify(part.functionCall.args) : "";
        return `関数呼び出し: ${part.functionCall.name}${args ? ` ${args}` : ""}`;
      }
      if (typeof part?.codeExecutionResult?.outputText === "string") {
        return part.codeExecutionResult.outputText;
      }
      if (part?.inlineData?.data) {
        const size = Buffer.from(part.inlineData.data, "base64").length;
        const mimeType = part.inlineData.mimeType || "application/octet-stream";
        return `インラインデータ (${mimeType}, ${size} bytes)`;
      }
      if (part?.fileData?.fileUri) {
        return `ファイル参照: ${part.fileData.fileUri}`;
      }
      if (part?.outputAudio?.data) {
        return "音声レスポンスが生成されました。";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
};

app.post("/api/chat", async (req, res) => {
  const { message, history } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message フィールドを入力してください。" });
  }

  if (!apiKey) {
    return res.status(503).json({
      error: "GOOGLE_API_KEY が設定されていません。Render の環境変数に API キーを登録してください。"
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
        notice = `指定モデル ${primaryModel} が利用できなかったため、${fallbackModel} で回答しました。`;
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
        error: `Gemini API の呼び出しに失敗しました (${result.status})`,
        details: detailMessage
      });
    }

    const parts = result.data?.candidates?.[0]?.content?.parts;
    const candidates = Array.isArray(result.data?.candidates) ? result.data.candidates : [];

    let reply = "";
    let usedCandidate;

    for (const candidate of candidates) {
      const candidateReply = extractTextFromParts(candidate?.content?.parts);
      if (candidateReply) {
        reply = candidateReply;
        usedCandidate = candidate;
        break;
      }
    }

    if (!reply) {
      reply = extractTextFromParts(parts);
      usedCandidate ??= result.data?.candidates?.[0];
    }

    if (!reply) {
      const promptFeedback = result.data?.promptFeedback;
      const finishReason = usedCandidate?.finishReason || promptFeedback?.blockReason;

      console.error("[Gemini] Empty response", {
        finishReason,
        promptFeedback,
        candidate: usedCandidate
      });

      return res.status(502).json({
        error: "Gemini API から有効な回答を取得できませんでした。",
        details: finishReason
          ? `生成が停止された理由: ${finishReason}`
          : "レスポンスにテキストが含まれていませんでした。"
      });
    }

    return res.json({
      reply,
      notice: notice || `${result.model || activeModel} で応答しました。`
    });
  } catch (error) {
    return res.status(500).json({
      error: "サーバー側でエラーが発生しました。",
      details: error.message
    });
  }
});

app.use(express.static(publicDir, { extensions: ["html"] }));

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Risk advisor server listening on port ${port}`);
});

