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

const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const hasSupabaseServiceRole =
  /^https?:\/\//.test(supabaseUrl) &&
  Boolean(supabaseServiceRoleKey) &&
  !supabaseServiceRoleKey.includes('your_supabase_');

const supabaseAdmin = hasSupabaseServiceRole
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

const lineLoginChannelId = process.env.LINE_LOGIN_CHANNEL_ID || '';
const hasLineLoginChannelId =
  Boolean(lineLoginChannelId) && !lineLoginChannelId.includes('your_line_');

const STORAGE_BUCKET_WISH_PHOTOS = 'wish-photos';
const SIGNED_UPLOAD_URL_EXPIRES_IN = 60 * 10;
const SIGNED_READ_URL_EXPIRES_IN = 60 * 30;
const LINE_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

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
  res.redirect('/liff.html');
});

app.get('/api/client-config', (req, res) => {
  res.json({
    liffId: LIFF_ID,
    liffFormUrl: LIFF_FORM_URL,
    candidateName: CANDIDATE_NAME,
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    liffId: LIFF_ID,
    candidateName: CANDIDATE_NAME,
  });
});

app.get('/api/platforms', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({
      success: false,
      message: 'Supabase 尚未完成設定，請先檢查環境變數。',
    });
  }

  try {
    const { data, error } = await supabase
      .from('campaign_platforms')
      .select('id, sort_order, subtitle, title, description, icon, theme_color, agree_count')
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('Fetch campaign_platforms failed:', error);
      return res.status(500).json({
        success: false,
        message: '政見資料讀取失敗，請稍後再試。',
      });
    }

    return res.json({
      success: true,
      data: data || [],
    });
  } catch (error) {
    console.error('Platforms API failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.post('/api/platforms/:id/agree', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({
      success: false,
      message: 'Supabase 尚未完成設定，請先檢查環境變數。',
    });
  }

  const platformId = Number.parseInt(req.params.id, 10);

  if (!Number.isInteger(platformId) || platformId <= 0) {
    return res.status(400).json({
      success: false,
      message: '政見編號不正確。',
    });
  }

  try {
    const result = await incrementPlatformAgreeCount(platformId);

    return res.json({
      success: true,
      message: '感謝您的支持，我們已收到這份認同。',
      data: result,
    });
  } catch (error) {
    const statusCode = error.code === 'NOT_FOUND' ? 404 : 500;

    if (statusCode === 500) {
      console.error('Platform agree API failed:', error);
    }

    return res.status(statusCode).json({
      success: false,
      message:
        error.code === 'NOT_FOUND'
          ? '找不到指定的政見資料。'
          : '支持票數更新失敗，請稍後再試。',
    });
  }
});

app.post('/api/feedback/upload-urls', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'upload-urls auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未設定，照片上傳功能暫時無法使用。',
    });
  }

  const rawCount = Number(req.body && req.body.count);
  const photoCount = Number.isInteger(rawCount) ? rawCount : 1;
  if (!Number.isInteger(photoCount) || photoCount < 1 || photoCount > 3) {
    return res.status(400).json({
      success: false,
      message: '照片數量須為 1 至 3 張。',
    });
  }

  const tempGroupId = 'tmp_' + generateUuidSafe();
  try {
    const uploadItems = [];
    for (let i = 0; i < photoCount; i += 1) {
      const fileUuid = generateUuidSafe();
      const storagePath = buildPhotoStoragePath(identity.lineUserId, tempGroupId, fileUuid);
      const { data, error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_WISH_PHOTOS)
        .createSignedUploadUrl(storagePath);
      if (error || !data) {
        console.error('Signed upload URL creation failed:', error);
        return res.status(500).json({
          success: false,
          message: '照片上傳金鑰產生失敗，請稍後再試。',
        });
      }
      uploadItems.push({
        sort_order: i,
        storage_path: storagePath,
        upload_url: data.signedUrl || data.url,
        file_uuid: fileUuid,
        upload_token: data.token || null,
        expected_content_type: 'image/webp',
      });
    }

    return res.json({
      success: true,
      message: '照片上傳金鑰已核發，請在 10 分鐘內完成上傳。',
      data: {
        temp_group_id: tempGroupId,
        bucket: STORAGE_BUCKET_WISH_PHOTOS,
        expires_in_seconds: SIGNED_UPLOAD_URL_EXPIRES_IN,
        uploads: uploadItems,
      },
    });
  } catch (error) {
    console.error('upload-urls failed:', error);
    return res.status(500).json({
      success: false,
      message: '照片上傳準備失敗，請稍後再試。',
    });
  }
});

app.post('/api/feedback', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'feedback auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const payload = normalizeFeedbackPayload(req.body || {}, identity.lineUserId);
  if (!payload.success) {
    return res.status(400).json(payload);
  }

  const photoEntries = Array.isArray(req.body && req.body.photos) ? req.body.photos : [];
  if (photoEntries.length > 3) {
    return res.status(400).json({
      success: false,
      message: '照片最多 3 張，請重新調整後再送出。',
    });
  }

  const normalizedPhotos = photoEntries
    .map((entry, idx) => {
      const storagePath = String((entry && entry.storage_path) || '').trim();
      const fileName = String((entry && entry.file_name) || (entry && entry.original_name) || '').slice(0, 200);
      const contentType = String((entry && entry.content_type) || 'image/webp').slice(0, 100);
      if (!storagePath) return null;
      const pathPrefix = `${identity.lineUserId.replace(/[^A-Za-z0-9_-]/g, '')}/`;
      if (!storagePath.startsWith(pathPrefix) || !storagePath.endsWith('.webp')) {
        return null;
      }
      const rawOrder = Number.isInteger(entry && entry.sort_order) ? entry.sort_order : idx;
      return {
        sort_order: Number.isInteger(rawOrder) && rawOrder >= 1 ? rawOrder : idx + 1,
        storage_path: storagePath,
        file_name: fileName,
        content_type: contentType,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.sort_order - b.sort_order);

  try {
    const feedbackRow = {
      ...payload.data,
      status: '已收到',
      photo_count: normalizedPhotos.length,
      has_photos: normalizedPhotos.length > 0,
    };

    const { data: insertedFeedback, error: insertFeedbackError } = await supabaseAdmin
      .from('user_feedback')
      .insert([feedbackRow])
      .select('id, created_at, status')
      .single();

    if (insertFeedbackError || !insertedFeedback) {
      console.error('user_feedback insert failed:', insertFeedbackError);
      return res.status(500).json({
        success: false,
        message: '許願內容儲存失敗，請稍後再試一次。',
      });
    }

    const feedbackId = insertedFeedback.id;
    const photoRows = normalizedPhotos.map((p) => ({
      line_user_id: identity.lineUserId,
      feedback_id: feedbackId,
      bucket_name: STORAGE_BUCKET_WISH_PHOTOS,
      sort_order: p.sort_order,
      storage_path: p.storage_path,
      file_name: p.file_name,
      content_type: p.content_type || 'image/webp',
    }));

    let photoInsertResult = { error: null };
    if (photoRows.length > 0) {
      photoInsertResult = await supabaseAdmin
        .from('user_feedback_photos')
        .insert(photoRows);
    }

    const statusLogInsert = await supabaseAdmin
      .from('user_feedback_status_logs')
      .insert([
        {
          feedback_id: feedbackId,
          status: '已收到',
          note: '系統建立初始狀態',
          changed_at: new Date().toISOString(),
        },
      ]);

    if (photoInsertResult.error) {
      console.error('user_feedback_photos insert failed:', photoInsertResult.error);
    }
    if (statusLogInsert.error) {
      console.error('user_feedback_status_logs insert failed:', statusLogInsert.error);
    }

    return res.status(201).json({
      success: true,
      message: '感謝您的許願，我們已收到並會儘速處理。',
      data: {
        id: feedbackId,
        created_at: insertedFeedback.created_at,
        status: insertedFeedback.status,
        photo_count: normalizedPhotos.length,
      },
    });
  } catch (error) {
    console.error('feedback submit failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.get('/api/my-feedback', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'my-feedback list auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const { data, error } = await supabaseAdmin
      .from('user_feedback')
      .select(
        `id, created_at, updated_at, last_status_at, category, content, status, photo_count, has_photos, reply_summary`
      )
      .eq('line_user_id', identity.lineUserId)
      .order('last_status_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('my-feedback list fetch failed:', error);
      return res.status(500).json({
        success: false,
        message: '我的許願清單讀取失敗，請稍後再試。',
      });
    }

    const items = (data || []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_status_at: row.last_status_at,
      category: row.category,
      status: row.status,
      photo_count: Number(row.photo_count) || 0,
      has_photos: Boolean(row.has_photos),
      excerpt: buildExcerpt(row.content, 60),
      reply_summary: row.reply_summary ? buildExcerpt(row.reply_summary, 120) : null,
    }));

    return res.json({
      success: true,
      data: {
        items,
        pagination: {
          offset,
          limit,
          returned_count: items.length,
        },
      },
    });
  } catch (error) {
    console.error('my-feedback list failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.get('/api/my-feedback/:id', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'my-feedback detail auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const feedbackId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return res.status(400).json({
      success: false,
      message: '許願編號不正確。',
    });
  }

  try {
    const { data: feedbackRow, error: fetchError } = await supabaseAdmin
      .from('user_feedback')
      .select(
        `id, line_user_id, user_name, phone, category, content, status, created_at, updated_at, last_status_at, photo_count, has_photos, reply_summary`
      )
      .eq('id', feedbackId)
      .single();

    if (fetchError || !feedbackRow) {
      const code = fetchError && fetchError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆許願紀錄。',
        });
      }
      console.error('my-feedback detail fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '許願內容讀取失敗，請稍後再試。',
      });
    }

    if (feedbackRow.line_user_id !== identity.lineUserId) {
      return res.status(403).json({
        success: false,
        message: '您沒有權限檢視這筆許願內容。',
      });
    }

    const photosPromise = supabaseAdmin
      .from('user_feedback_photos')
      .select('id, sort_order, bucket_name, storage_path, file_name, content_type, created_at')
      .eq('feedback_id', feedbackId)
      .order('sort_order', { ascending: true });

    const statusLogsPromise = supabaseAdmin
      .from('user_feedback_status_logs')
      .select('id, status, note, changed_at')
      .eq('feedback_id', feedbackId)
      .order('changed_at', { ascending: true })
      .order('id', { ascending: true });

    const [photosResult, logsResult] = await Promise.all([photosPromise, statusLogsPromise]);
    if (photosResult.error) {
      console.error('user_feedback_photos select failed:', photosResult.error);
    }
    if (logsResult.error) {
      console.error('user_feedback_status_logs select failed:', logsResult.error);
    }

    const rawPhotos = (photosResult.data || []).filter(Boolean);
    const signedPhotos = [];
    for (const photo of rawPhotos) {
      let signedUrl = null;
      if (photo.storage_path) {
        try {
          const { data, error } = await supabaseAdmin.storage
            .from(STORAGE_BUCKET_WISH_PHOTOS)
            .createSignedUrl(photo.storage_path, SIGNED_READ_URL_EXPIRES_IN);
          if (!error && data) {
            signedUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('photo signed URL error:', err.message);
        }
      }
      signedPhotos.push({
        id: photo.id,
        sort_order: photo.sort_order,
        bucket_name: photo.bucket_name || STORAGE_BUCKET_WISH_PHOTOS,
        file_name: photo.file_name || null,
        content_type: photo.content_type || 'image/webp',
        created_at: photo.created_at,
        storage_path: photo.storage_path,
        signed_url: signedUrl,
        expires_in_seconds: signedUrl ? SIGNED_READ_URL_EXPIRES_IN : null,
      });
    }

    const statusTimeline = (logsResult.data || []).filter(Boolean).map((log) => ({
      id: log.id,
      status: log.status,
      note: log.note || null,
      changed_at: log.changed_at,
    }));

    return res.json({
      success: true,
      data: {
        id: feedbackRow.id,
        category: feedbackRow.category,
        user_name: feedbackRow.user_name,
        phone: feedbackRow.phone,
        content: feedbackRow.content,
        status: feedbackRow.status,
        created_at: feedbackRow.created_at,
        updated_at: feedbackRow.updated_at,
        last_status_at: feedbackRow.last_status_at,
        photo_count: Number(feedbackRow.photo_count) || 0,
        has_photos: Boolean(feedbackRow.has_photos),
        reply_summary: feedbackRow.reply_summary || null,
        photos: signedPhotos,
        status_timeline: statusTimeline,
      },
    });
  } catch (error) {
    console.error('my-feedback detail failed:', error);
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

function normalizeFeedbackPayload(body = {}, authLineUserId = null) {
  const trustedLineUserId = authLineUserId
    ? String(authLineUserId).trim()
    : String(body.line_user_id || '').trim();
  const userName = String(body.user_name || '').trim();
  const phone = String(body.phone || '').trim();
  const category = String(body.category || '').trim();
  const content = String(body.content || '').trim();

  if (!trustedLineUserId || !userName || !phone || !category || !content) {
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
      line_user_id: trustedLineUserId,
      user_name: userName,
      phone,
      category,
      content,
    },
  };
}

class AuthError extends Error {
  constructor(message = '身分驗證失敗。') {
    super(message);
    this.name = 'AuthError';
    this.status = 401;
  }
}

function requireNewFeedbackAuth() {
  if (!hasLineLoginChannelId) {
    const missingError = new Error(
      '環境變數 LINE_LOGIN_CHANNEL_ID 尚未設定。請至 LINE Developers 取得 LINE Login 頻道的 Channel ID 後，加入 .env 與 Vercel 環境變數。'
    );
    missingError.code = 'MISSING_LINE_LOGIN_CHANNEL';
    missingError.status = 500;
    throw missingError;
  }
  if (!hasSupabaseServiceRole) {
    const missingError = new Error(
      '環境變數 SUPABASE_SERVICE_ROLE_KEY 尚未設定。請至 Supabase 專案 Dashboard → Project Settings → API → service_role 取得後，加入 .env 與 Vercel 環境變數。'
    );
    missingError.code = 'MISSING_SUPABASE_SERVICE_ROLE';
    missingError.status = 500;
    throw missingError;
  }
}

async function authenticateLineIdentity(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string') {
    throw new AuthError('缺少身分驗證資訊，請重新開啟 LIFF。');
  }

  const headerParts = authHeader.trim().split(/\s+/);
  if (headerParts.length !== 2 || headerParts[0].toLowerCase() !== 'bearer' || !headerParts[1]) {
    throw new AuthError('身分驗證格式錯誤，應為 Authorization: Bearer <LIFF_ID_TOKEN>。');
  }
  const idToken = headerParts[1];

  requireNewFeedbackAuth();

  try {
    const params = new URLSearchParams({
      id_token: idToken,
      client_id: lineLoginChannelId,
    });
    const verifyRes = await fetch(LINE_ID_TOKEN_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!verifyRes.ok) {
      const errorBody = await verifyRes.text().catch(() => '');
      if (verifyRes.status === 400 || verifyRes.status === 401) {
        console.warn('LINE ID token verify failed:', verifyRes.status, errorBody.slice(0, 200));
        throw new AuthError('身分驗證失敗，請重新開啟 LIFF 後再試。');
      }
      console.error('LINE verify endpoint error:', verifyRes.status, errorBody.slice(0, 300));
      const upstreamError = new Error('身分驗證服務暫時無法使用，請稍後再試。');
      upstreamError.status = 502;
      throw upstreamError;
    }

    const payload = await verifyRes.json();
    const sub = payload && typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!sub) {
      throw new AuthError('無法解析 LINE 使用者身分，請重新開啟 LIFF。');
    }
    return { lineUserId: sub, tokenPayload: payload };
  } catch (error) {
    if (error instanceof AuthError || (error && error.status)) {
      throw error;
    }
    console.error('LINE identity auth unexpected error:', error);
    const unknownError = new Error('身分驗證時發生錯誤，請稍後再試。');
    unknownError.status = 500;
    throw unknownError;
  }
}

function handleAuthOrServerError(res, error, contextMessage) {
  if (error instanceof AuthError) {
    return res.status(error.status || 401).json({
      success: false,
      message: error.message || '身分驗證失敗。',
    });
  }
  const status = Number(error && error.status) || 500;
  if (status === 500) {
    console.error(contextMessage || 'API failed:', error);
  }
  return res.status(status).json({
    success: false,
    message: error && error.message ? error.message : '伺服器忙碌中，請稍後再試。',
  });
}

function generateUuidSafe() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes =
    typeof crypto !== 'undefined' && crypto.randomBytes
      ? crypto.randomBytes(16)
      : null;
  if (bytes) {
    const hex = bytes.toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      '4' + hex.slice(13, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function buildPhotoStoragePath(lineUserId, feedbackGroupId, fileUuid) {
  const safeUser = String(lineUserId).replace(/[^A-Za-z0-9_-]/g, '');
  const safeGroup = String(feedbackGroupId).replace(/[^A-Za-z0-9_-]/g, '');
  const safeFile = String(fileUuid).replace(/[^A-Za-z0-9_-]/g, '');
  return `${safeUser}/${safeGroup}/${safeFile}.webp`;
}

function buildExcerpt(text, maxLen = 60) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
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

async function incrementPlatformAgreeCount(platformId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: currentRow, error: fetchError } = await supabase
      .from('campaign_platforms')
      .select('id, agree_count')
      .eq('id', platformId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        const notFoundError = new Error('Platform not found');
        notFoundError.code = 'NOT_FOUND';
        throw notFoundError;
      }

      throw fetchError;
    }

    const currentCount = Number(currentRow.agree_count) || 0;
    const nextCount = currentCount + 1;
    const { data: updatedRow, error: updateError } = await supabase
      .from('campaign_platforms')
      .update({ agree_count: nextCount })
      .eq('id', platformId)
      .eq('agree_count', currentCount)
      .select('id, agree_count')
      .single();

    if (!updateError && updatedRow) {
      return updatedRow;
    }

    if (updateError && updateError.code === 'PGRST116') {
      continue;
    }

    throw updateError;
  }

  throw new Error('Failed to update agree count after retries');
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
