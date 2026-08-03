require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');
const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const isRunningOnVercel = Boolean(process.env.VERCEL);

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const LIFF_ID = process.env.LIFF_ID || '';
const LIFF_FORM_URL = process.env.LIFF_FORM_URL || `http://localhost:${PORT}/liff.html`;
const CANDIDATE_NAME = process.env.CANDIDATE_NAME || 'ＯＯ';
const FEEDBACK_CATEGORIES = new Set(['環境', '治安', '銀髮', '親子', '其他']);

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};

const hasLineCredentials =
  Boolean(lineConfig.channelAccessToken) &&
  Boolean(lineConfig.channelSecret) &&
  !lineConfig.channelAccessToken.includes('your_line_') &&
  !lineConfig.channelSecret.includes('your_line_');

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
const hasSupabaseCredentials =
  /^https?:\/\//.test(supabaseUrl) && !supabaseAnonKey.includes('your_supabase_');

const supabase = hasSupabaseCredentials
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

const lineClient = hasLineCredentials
  ? new line.messagingApi.MessagingApiClient({
      channelAccessToken: lineConfig.channelAccessToken,
    })
  : null;

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (error) {
    console.error('Webhook handling failed:', error);
    res.status(500).end();
  }
});

app.use(express.json({ limit: '1mb' }));

// Vercel serves /public from its CDN. Keep express.static only for local dev.
if (!isRunningOnVercel) {
  app.use(express.static(PUBLIC_DIR));
}

app.get('/', (req, res) => {
  res.json({
    message: 'LINE webhook server is running.',
    lineConfigured: hasLineCredentials,
    supabaseConfigured: hasSupabaseCredentials,
    liffConfigured: Boolean(LIFF_ID),
    liffFormUrl: LIFF_FORM_URL,
    runtime: process.env.VERCEL ? 'vercel' : 'local',
  });
});

app.get('/api/client-config', (req, res) => {
  res.json({
    liffId: LIFF_ID,
    liffFormUrl: LIFF_FORM_URL,
    candidateName: CANDIDATE_NAME,
  });
});

app.post('/api/feedback', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({
      success: false,
      message: 'Supabase 尚未完成設定，請先檢查環境變數。',
    });
  }

  const payload = normalizeFeedbackPayload(req.body);

  if (!payload.success) {
    return res.status(400).json(payload);
  }

  try {
    const { data, error } = await supabase
      .from('user_feedback')
      .insert([payload.data])
      .select('id, created_at')
      .single();

    if (error) {
      console.error('Supabase insert failed:', error);
      return res.status(500).json({
        success: false,
        message: '資料寫入失敗，請稍後再試一次。',
      });
    }

    return res.status(201).json({
      success: true,
      message: '感謝您的建議，我們已收到並會盡快了解。',
      data,
    });
  } catch (error) {
    console.error('Feedback API failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof line.SignatureValidationFailed) {
    console.error('LINE signature validation failed.');
    return res.status(401).send('Invalid LINE signature.');
  }

  if (error instanceof line.JSONParseError) {
    console.error('LINE webhook JSON parse failed.');
    return res.status(400).send('Invalid webhook payload.');
  }

  console.error('Unexpected server error:', error);
  return res.status(500).send('Internal server error.');
});

function normalizeFeedbackPayload(body = {}) {
  const lineUserId = String(body.line_user_id || '').trim();
  const userName = String(body.user_name || '').trim();
  const phone = String(body.phone || '').trim();
  const category = String(body.category || '').trim();
  const content = String(body.content || '').trim();

  if (!lineUserId || !userName || !phone || !category || !content) {
    return {
      success: false,
      message: '請完整填寫所有欄位後再送出。',
    };
  }

  if (!FEEDBACK_CATEGORIES.has(category)) {
    return {
      success: false,
      message: '反映類別不正確，請重新選擇。',
    };
  }

  if (phone.length > 30 || content.length > 2000 || userName.length > 100) {
    return {
      success: false,
      message: '欄位長度超出限制，請檢查後重新送出。',
    };
  }

  return {
    success: true,
    data: {
      line_user_id: lineUserId,
      user_name: userName,
      phone,
      category,
      content,
    },
  };
}

function buildFeedbackInvitation() {
  return `您好！我是里長參選人${CANDIDATE_NAME}。如果您有任何建議、許願或需要協助的地方，歡迎點擊下方連結填寫「里民許願池表單」，讓我為您服務：${LIFF_FORM_URL}`;
}

async function handleEvent(event) {
  if (!lineClient) {
    console.warn('LINE credentials are not configured yet. Webhook event skipped.');
    return null;
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return null;
  }

  const incomingText = event.message.text.trim();
  const specialCommandResponses = {
    ping: '系統正常運作中，歡迎隨時傳訊給我。',
    表單: buildFeedbackInvitation(),
    許願池: buildFeedbackInvitation(),
  };

  const replyText = specialCommandResponses[incomingText] || buildFeedbackInvitation();

  return lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: 'text',
        text: replyText,
      },
    ],
  });
}

async function verifySupabaseConnection() {
  if (!supabase) {
    console.warn(
      'Supabase credentials are still placeholders. Client initialization check skipped.'
    );
    return;
  }

  try {
    const { error, count } = await supabase
      .from('user_feedback')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.warn('Supabase connected, but user_feedback query returned:', error.message);
      return;
    }

    console.log(`Supabase connection OK. user_feedback row count: ${count ?? 0}`);
  } catch (error) {
    console.error('Supabase connection test failed:', error.message);
  }
}

app.locals.runtimeConfig = {
  PORT,
  LIFF_FORM_URL,
  LIFF_ID,
  hasLineCredentials,
  hasSupabaseCredentials,
  verifySupabaseConnection,
};

module.exports = app;
