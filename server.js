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

  const systemPrompt = 'あなたは「あかねチャットボット」です。丁寧で親しみやすい日本語で応答し、ユーザーの依頼内容を要約しつつ、具体的な提案や補足情報も提供してください。必要に応じて箇条書きも使い、会話が広がるフォローアップの質問を入れてください。';

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

const fallbackReply = (message) => {
  const text = message.trim();
  if (!text) {
    return '何かお話ししたいことはありますか？思いつかない時は「おすすめ」や「気分転換」などと聞いてみてください。';
  }
  if (/おすすめ|レコメンド|提案/.test(text)) {
    return [
      '気分転換には短い散歩やストレッチがおすすめです。',
      '少し時間があるなら、今日良かったことを2つメモしてみませんか？'
    ].join('\n');
  }
  if (/疲れ|休み|リラックス/.test(text)) {
    return 'お疲れさまです。肩や首を回して血行を良くしたり、目を閉じて深呼吸を3回してみるとスッキリしますよ。';
  }
  if (/集中|勉強|仕事/.test(text)) {
    return '集中のコツは「25分作業 + 5分休憩」のポモドーロ法がおすすめです。タスクを細かく分けてみましょう。';
  }
  if (/予定|スケジュール|計画/.test(text)) {
    return '今日の予定を箇条書きにして優先順位をつけてみませんか？終わったらチェックしていくと達成感が得られます。';
  }
  if (/天気|外/.test(text)) {
    return '詳しい天気はお住まいの地域の予報をご確認ください。服装や持ち物で調整することも忘れずに。';
  }
  return '面白い話題ですね！もう少し詳しく教えていただけたら、できる限りお手伝いします。';
};

app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message が空です。' });
  }

  if (!apiKey) {
    return res.json({
      reply: fallbackReply(message),
      notice: 'GOOGLE_API_KEY が設定されていないため、簡易応答モードで返答しました。'
    });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';
  const payload = buildGeminiRequest(history, message);

  try {
    const response = await fetch(`${url}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: `Gemini API 呼び出しに失敗しました (${response.status})`,
        details: errorText
      });
    }

    const data = await response.json();
    const parts = data?.candidates?.[0]?.content?.parts;
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
      notice: 'Gemini 1.5 Flash と接続済みです。'
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
