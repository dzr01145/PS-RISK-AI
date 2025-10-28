import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const basicAuthUser = process.env.BASIC_AUTH_USER || 'admin';
const basicAuthPassword = process.env.BASIC_AUTH_PASSWORD || '123';
const apiKey = process.env.GOOGLE_API_KEY;
const geminiModel = process.env.GOOGLE_GEMINI_MODEL || 'gemini-2.5-flash-latest';
const fallbackGeminiModel = process.env.GOOGLE_GEMINI_FALLBACK_MODEL || 'gemini-1.5-flash-latest';

const isHealthCheckRequest = (req) => {
  const userAgent = req.headers['user-agent'] || '';
  return req.path === '/healthz'
    || req.headers['x-render-health-check'] === 'true'
    || userAgent.includes('Render/health-check');
};

const timingSafeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
};

const demandAuth = (res) => {
  res.setHeader('WWW-Authenticate', 'Basic realm="Restricted Area"');
  return res.status(401).send('Authentication required');
};

const basicAuth = (req, res, next) => {
  if (isHealthCheckRequest(req)) {
    return next();
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    return demandAuth(res);
  }
  const base64Credentials = header.slice(6);
  let decoded;
  try {
    decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
  } catch {
    return demandAuth(res);
  }
  const separatorIndex = decoded.indexOf(':');
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

app.get('/healthz', (req, res) => {
  res.status(200).json({
    status: 'ok',
    model: geminiModel,
    fallbackModel: fallbackGeminiModel
  });
});

app.head('/healthz', (req, res) => {
  res.status(200).end();
});

app.use(basicAuth);
app.use(express.json());
app.use(express.static(publicDir, { extensions: ['html'] }));

const buildGeminiRequest = (history, message) => {
  const conversation = Array.isArray(history) ? history : [];
  const contents = conversation
    .filter((entry) => entry && typeof entry.text === 'string')
    .map((entry) => ({
      role: entry.role === 'model' ? 'model' : 'user',
      parts: [{ text: entry.text }]
    }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  const systemPrompt = [
    'あなたは「ブルーシールド・リスクアドバイザー」という名称のエキスパートコンサルタントです。',
    '専門領域は製品安全、製造物責任（PL）、品質管理、品質不正対応、国内外のリコール実務です。',
    '落ち着いたビジネス日本語を用い、',
    '1) 相談内容の背景整理、2) 想定リスクと関連法規、3) 具体的な対応策とチェック項目、4) 次に検討すべきアクション',
    'を明確に提示してください。必要に応じて箇条書きを活用し、実務に役立つ視点を添えます。',
    '回答の最後には状況把握に役立つフォローアップ質問を一つ添えてください。'
  ].join('\n');

  return {
    contents,
    systemInstruction: {
      role: 'system',
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

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message が空です。' });
  }

  if (!apiKey) {
    return res.status(503).json({
      error: 'GOOGLE_API_KEY が設定されていません。Render の環境変数にキーを登録してください。'
    });
  }

  const payload = JSON.stringify(buildGeminiRequest(history, message));

  const callGemini = async (model) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await fetch(`${url}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
        fallbackNotice = `指定モデル ${geminiModel} が見つからなかったため、${fallbackGeminiModel} で応答しました。`;
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
        error: `Gemini API 呼び出しに失敗しました (${primaryResult.status})`,
        details: detailMessage
      });
    }

    const parts = primaryResult.data?.candidates?.[0]?.content?.parts;
    const reply = Array.isArray(parts)
      ? parts.map((part) => part?.text || '').join('\n').trim()
      : '';

    if (!reply) {
      return res.status(502).json({
        error: 'Gemini API から有効な返答が得られませんでした。'
      });
    }

    return res.json({
      reply,
      notice: fallbackNotice || `${primaryResult.model || activeModel} で応答しました。`
    });
  } catch (error) {
    return res.status(500).json({
      error: 'サーバー内でエラーが発生しました。',
      details: error.message
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Akane chatbot server listening on port ${port}`);
});
