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

// 許願池後台管理員白名單（逗號分隔 LINE user id，即 LINE verify API 回傳的 sub）
const adminLineUserIds = new Set(
  String(process.env.ADMIN_LINE_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);
const hasAdminWhitelist = adminLineUserIds.size > 0;

function isAdminLineUserId(lineUserId) {
  if (!lineUserId) return false;
  return adminLineUserIds.has(lineUserId);
}

const STORAGE_BUCKET_WISH_PHOTOS = 'wish-photos';
const STORAGE_BUCKET_PLATFORM_COVERS = 'platform-covers';
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
      .select('id, sort_order, subtitle, title, description, icon, theme_color, agree_count, summary, cover_image_path, is_featured, is_published')
      .eq('is_published', true)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('Fetch campaign_platforms failed:', error);
      return res.status(500).json({
        success: false,
        message: '政見資料讀取失敗，請稍後再試。',
      });
    }

    // 為有封面的政見產生 signed read URL
    const withCovers = await Promise.all((data || []).map(async (p) => {
      const coverUrl = await getPlatformCoverSignedUrl(p.cover_image_path);
      const { cover_image_path, ...rest } = p;
      return { ...rest, cover_url: coverUrl };
    }));

    return res.json({
      success: true,
      data: withCovers,
    });
  } catch (error) {
    console.error('Platforms API failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// 里民端單筆政見詳情（含 content 全文）
app.get('/api/platforms/:id', async (req, res) => {
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
    const { data, error } = await supabase
      .from('campaign_platforms')
      .select('id, sort_order, subtitle, title, description, icon, theme_color, agree_count, summary, content, cover_image_path, is_featured, is_published')
      .eq('id', platformId)
      .eq('is_published', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆政見或尚未上架。',
        });
      }
      console.error('Fetch platform detail failed:', error);
      return res.status(500).json({
        success: false,
        message: '政見資料讀取失敗，請稍後再試。',
      });
    }

    const coverUrl = await getPlatformCoverSignedUrl(data.cover_image_path);
    const { cover_image_path, ...rest } = data;

    return res.json({
      success: true,
      data: { ...rest, cover_url: coverUrl },
    });
  } catch (error) {
    console.error('Platform detail API failed:', error);
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

// ============================================================================
// 許願池後台管理 API
// 所有 /api/admin/* 路徑：
//   1. 必須驗證 LINE ID Token（與里民端同一個 authenticateLineIdentity）
//   2. 必須在 ADMIN_LINE_USER_IDS 白名單內
//   3. 一律使用 Service Role Key 存取資料
// 與里民端 /api/feedback、/api/my-feedback 權限完全分開
// ============================================================================

const ADMIN_FEEDBACK_STATUSES = ['已收到', '處理中', '已回覆', '已結案'];
const ADMIN_FEEDBACK_STATUS_SET = new Set(ADMIN_FEEDBACK_STATUSES);
const ADMIN_FEEDBACK_LIST_MAX_LIMIT = 100;
const ADMIN_FEEDBACK_LIST_DEFAULT_LIMIT = 30;
const ADMIN_FEEDBACK_SEARCH_MIN_LENGTH = 1;
const ADMIN_REPLY_SUMMARY_MAX_LENGTH = 2000;

app.get('/api/admin/me', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/me auth failed');
  }

  if (!hasAdminWhitelist) {
    return res.status(403).json({
      success: false,
      message: '系統尚未設定管理員白名單。',
    });
  }

  const isAdmin = isAdminLineUserId(identity.lineUserId);
  return res.json({
    success: true,
    data: {
      is_admin: isAdmin,
      line_user_id: identity.lineUserId,
    },
  });
});

app.get('/api/admin/feedback', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/feedback list auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const statusParam = String(req.query.status || '').trim();
  const searchQuery = String(req.query.q || '').trim();
  const limit = Math.min(
    Math.max(Number(req.query.limit) || ADMIN_FEEDBACK_LIST_DEFAULT_LIMIT, 1),
    ADMIN_FEEDBACK_LIST_MAX_LIMIT
  );
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const filterStatus =
    statusParam && statusParam !== '全部' && ADMIN_FEEDBACK_STATUS_SET.has(statusParam)
      ? statusParam
      : null;

  try {
    let query = supabaseAdmin
      .from('user_feedback')
      .select(
        'id, created_at, updated_at, last_status_at, line_user_id, user_name, phone, category, content, status, photo_count, has_photos, reply_summary',
        { count: 'exact' }
      )
      .order('last_status_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (filterStatus) {
      query = query.eq('status', filterStatus);
    }

    if (searchQuery.length >= ADMIN_FEEDBACK_SEARCH_MIN_LENGTH) {
      const sanitized = searchQuery.replace(/[%_]/g, (m) => '\\' + m);
      const pattern = `%${sanitized}%`;
      query = query.or(
        `user_name.ilike.${pattern},phone.ilike.${pattern},content.ilike.${pattern}`
      );
    }

    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('admin/feedback list fetch failed:', error);
      return res.status(500).json({
        success: false,
        message: '許願列表讀取失敗，請稍後再試。',
      });
    }

    const items = (data || []).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_status_at: row.last_status_at,
      user_name: row.user_name || '',
      phone: row.phone || '',
      category: row.category,
      status: row.status,
      photo_count: Number(row.photo_count) || 0,
      has_photos: Boolean(row.has_photos),
      excerpt: buildExcerpt(row.content, 80),
      reply_summary: row.reply_summary ? buildExcerpt(row.reply_summary, 120) : null,
    }));

    // 同時撈各狀態數量給前端顯示 chips
    const countsPromise = supabaseAdmin
      .from('user_feedback')
      .select('status', { count: 'exact', head: true });

    const [allCountRes, receivedCountRes, processingRes, repliedRes, closedRes] =
      await Promise.all([
        countsPromise,
        supabaseAdmin
          .from('user_feedback')
          .select('status', { count: 'exact', head: true })
          .eq('status', '已收到'),
        supabaseAdmin
          .from('user_feedback')
          .select('status', { count: 'exact', head: true })
          .eq('status', '處理中'),
        supabaseAdmin
          .from('user_feedback')
          .select('status', { count: 'exact', head: true })
          .eq('status', '已回覆'),
        supabaseAdmin
          .from('user_feedback')
          .select('status', { count: 'exact', head: true })
          .eq('status', '已結案'),
      ]);

    return res.json({
      success: true,
      data: {
        items,
        pagination: {
          offset,
          limit,
          returned_count: items.length,
          total_count: Number(count) || 0,
        },
        counts: {
          全部: Number(allCountRes.count) || 0,
          已收到: Number(receivedCountRes.count) || 0,
          處理中: Number(processingRes.count) || 0,
          已回覆: Number(repliedRes.count) || 0,
          已結案: Number(closedRes.count) || 0,
        },
        applied_filters: {
          status: filterStatus || '全部',
          q: searchQuery || null,
        },
      },
    });
  } catch (error) {
    console.error('admin/feedback list failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.get('/api/admin/feedback/:id', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/feedback detail auth failed');
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
        'id, line_user_id, user_name, phone, category, content, status, created_at, updated_at, last_status_at, photo_count, has_photos, reply_summary'
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
      console.error('admin/feedback detail fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '許願內容讀取失敗，請稍後再試。',
      });
    }

    const photosPromise = supabaseAdmin
      .from('user_feedback_photos')
      .select(
        'id, sort_order, bucket_name, storage_path, file_name, content_type, created_at'
      )
      .eq('feedback_id', feedbackId)
      .order('sort_order', { ascending: true });

    const statusLogsPromise = supabaseAdmin
      .from('user_feedback_status_logs')
      .select('id, status, note, changed_by, changed_at')
      .eq('feedback_id', feedbackId)
      .order('changed_at', { ascending: true })
      .order('id', { ascending: true });

    const [photosResult, logsResult] = await Promise.all([
      photosPromise,
      statusLogsPromise,
    ]);

    if (photosResult.error) {
      console.error('admin photos select failed:', photosResult.error);
    }
    if (logsResult.error) {
      console.error('admin status_logs select failed:', logsResult.error);
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
          console.error('admin photo signed URL error:', err.message);
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

    const statusLogs = (logsResult.data || []).filter(Boolean).map((log) => ({
      id: log.id,
      status: log.status,
      note: log.note || null,
      changed_by: log.changed_by || null,
      changed_at: log.changed_at,
    }));

    return res.json({
      success: true,
      data: {
        id: feedbackRow.id,
        line_user_id: feedbackRow.line_user_id,
        category: feedbackRow.category,
        user_name: feedbackRow.user_name || '',
        phone: feedbackRow.phone || '',
        content: feedbackRow.content,
        status: feedbackRow.status,
        created_at: feedbackRow.created_at,
        updated_at: feedbackRow.updated_at,
        last_status_at: feedbackRow.last_status_at,
        photo_count: Number(feedbackRow.photo_count) || 0,
        has_photos: Boolean(feedbackRow.has_photos),
        reply_summary: feedbackRow.reply_summary || null,
        photos: signedPhotos,
        status_logs: statusLogs,
      },
    });
  } catch (error) {
    console.error('admin/feedback detail failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

app.patch('/api/admin/feedback/:id', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/feedback patch auth failed');
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

  const body = req.body || {};
  const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status');
  const hasReply = Object.prototype.hasOwnProperty.call(body, 'reply_summary');

  if (!hasStatus && !hasReply) {
    return res.status(400).json({
      success: false,
      message: '請至少提供狀態或回覆內容其中一項。',
    });
  }

  let nextStatus = null;
  if (hasStatus) {
    nextStatus = String(body.status || '').trim();
    if (!ADMIN_FEEDBACK_STATUS_SET.has(nextStatus)) {
      return res.status(400).json({
        success: false,
        message: '狀態值不正確，僅接受：已收到 / 處理中 / 已回覆 / 已結案。',
      });
    }
  }

  let nextReplySummary = null;
  let shouldUpdateReply = false;
  if (hasReply) {
    shouldUpdateReply = true;
    nextReplySummary = String(body.reply_summary || '').trim();
    if (nextReplySummary.length > ADMIN_REPLY_SUMMARY_MAX_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `回覆內容長度不得超過 ${ADMIN_REPLY_SUMMARY_MAX_LENGTH} 字。`,
      });
    }
  }

  try {
    const { data: currentRow, error: fetchError } = await supabaseAdmin
      .from('user_feedback')
      .select('id, status, reply_summary')
      .eq('id', feedbackId)
      .single();

    if (fetchError || !currentRow) {
      const code = fetchError && fetchError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆許願紀錄。',
        });
      }
      console.error('admin patch fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '案件讀取失敗，請稍後再試。',
      });
    }

    const nowIso = new Date().toISOString();
    const updatePayload = {
      updated_at: nowIso,
      last_status_at: nowIso,
    };

    if (nextStatus) {
      updatePayload.status = nextStatus;
    }
    if (shouldUpdateReply) {
      updatePayload.reply_summary = nextReplySummary || null;
    }

    const { data: updatedRow, error: updateError } = await supabaseAdmin
      .from('user_feedback')
      .update(updatePayload)
      .eq('id', feedbackId)
      .select(
        'id, status, reply_summary, updated_at, last_status_at, photo_count, has_photos'
      )
      .single();

    if (updateError || !updatedRow) {
      console.error('admin patch update failed:', updateError);
      return res.status(500).json({
        success: false,
        message: '許願狀態更新失敗，請稍後再試。',
      });
    }

    // 寫入狀態歷程。若同時變更狀態與回覆，note 以回覆為主；若只變更狀態，則記錄狀態說明。
    const logStatus = nextStatus || currentRow.status;
    let logNote = null;
    if (shouldUpdateReply) {
      logNote = nextReplySummary || null;
    } else if (nextStatus && nextStatus !== currentRow.status) {
      logNote = `狀態由「${currentRow.status}」變更為「${nextStatus}」`;
    }

    const statusLogInsert = await supabaseAdmin
      .from('user_feedback_status_logs')
      .insert([
        {
          feedback_id: feedbackId,
          status: logStatus,
          note: logNote,
          changed_by: identity.lineUserId,
          changed_at: nowIso,
        },
      ]);

    if (statusLogInsert.error) {
      console.error('admin status_logs insert failed:', statusLogInsert.error);
      // 主表已更新成功，不阻擋回應，但記錄錯誤
    }

    return res.json({
      success: true,
      message: '已儲存進度，里民端「我的許願」將同步顯示最新狀態。',
      data: {
        id: updatedRow.id,
        status: updatedRow.status,
        reply_summary: updatedRow.reply_summary || null,
        updated_at: updatedRow.updated_at,
        last_status_at: updatedRow.last_status_at,
      },
    });
  } catch (error) {
    console.error('admin patch failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// ============================================
// 政見管理 API（管理員白名單）
// ============================================

// 取得政見列表（含未上架、含封面 signed URL）
app.get('/api/admin/platforms', async (req, res) => {
  try {
    await requireAdmin(req);

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, sort_order, subtitle, title, description, icon, theme_color, agree_count, summary, content, cover_image_path, is_featured, is_published, created_at')
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('admin platforms list failed:', error);
      return res.status(500).json({
        success: false,
        message: '政見列表讀取失敗，請稍後再試。',
      });
    }

    const withCovers = await Promise.all((data || []).map(async (p) => {
      const coverUrl = await getPlatformCoverSignedUrl(p.cover_image_path);
      const { cover_image_path, ...rest } = p;
      return { ...rest, cover_url: coverUrl };
    }));

    return res.json({
      success: true,
      data: withCovers,
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platforms list failed:');
  }
});

// 取得單筆政見完整資料
app.get('/api/admin/platforms/:id', async (req, res) => {
  try {
    await requireAdmin(req);

    const platformId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      return res.status(400).json({
        success: false,
        message: '政見編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, sort_order, subtitle, title, description, icon, theme_color, agree_count, summary, content, cover_image_path, is_featured, is_published, created_at')
      .eq('id', platformId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆政見。',
        });
      }
      console.error('admin platform detail failed:', error);
      return res.status(500).json({
        success: false,
        message: '政見資料讀取失敗，請稍後再試。',
      });
    }

    const coverUrl = await getPlatformCoverSignedUrl(data.cover_image_path);
    const { cover_image_path, ...rest } = data;

    return res.json({
      success: true,
      data: { ...rest, cover_url: coverUrl },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform detail failed:');
  }
});

// 更新政見（標題、分類、摘要、內文、排序、主打、上架狀態）
app.patch('/api/admin/platforms/:id', async (req, res) => {
  try {
    await requireAdmin(req);

    const platformId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      return res.status(400).json({
        success: false,
        message: '政見編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const allowedFields = [
      'subtitle', 'title', 'summary', 'content',
      'sort_order', 'is_featured', 'is_published',
    ];
    const body = req.body || {};
    const updatePayload = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        if (key === 'sort_order') {
          const v = Number(body[key]);
          if (!Number.isInteger(v) || v < 0) {
            return res.status(400).json({
              success: false,
              message: '排序須為非負整數。',
            });
          }
          updatePayload[key] = v;
        } else if (key === 'is_featured' || key === 'is_published') {
          updatePayload[key] = Boolean(body[key]);
        } else {
          const v = String(body[key] || '').trim();
          if (!v) {
            return res.status(400).json({
              success: false,
              message: `${key} 不可為空。`,
            });
          }
          updatePayload[key] = v;
        }
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        message: '沒有可更新的欄位。',
      });
    }

    // 若要設為主打，先把其他主打取消（保證唯一性）
    if (updatePayload.is_featured === true) {
      const { error: unfeatureError } = await supabaseAdmin
        .from('campaign_platforms')
        .update({ is_featured: false })
        .eq('is_featured', true)
        .neq('id', platformId);
      if (unfeatureError) {
        console.error('unfeature others failed:', unfeatureError);
      }
    }

    // 若要改 sort_order，需要與其他筆交換 sort_order（避免 unique 衝突）
    // 用 temp 負值避開 unique index：當前→temp → 佔用者補到舊位 → 當前→新位
    if (Object.prototype.hasOwnProperty.call(updatePayload, 'sort_order')) {
      const { data: target } = await supabaseAdmin
        .from('campaign_platforms')
        .select('id, sort_order')
        .eq('id', platformId)
        .single();
      const oldSort = target && Number(target.sort_order);
      const newSort = Number(updatePayload.sort_order);
      if (Number.isInteger(oldSort) && oldSort !== newSort) {
        const tempVal = -Number(platformId);
        // step1: 當前 → temp
        await supabaseAdmin.from('campaign_platforms').update({ sort_order: tempVal }).eq('id', platformId);
        // step2: 佔用者補到 oldSort
        const { data: occupant } = await supabaseAdmin
          .from('campaign_platforms')
          .select('id, sort_order')
          .eq('sort_order', newSort)
          .neq('id', platformId)
          .maybeSingle();
        if (occupant) {
          await supabaseAdmin.from('campaign_platforms').update({ sort_order: oldSort }).eq('id', occupant.id);
        }
        // step3: 當前(temp) → newSort（這已經是 updatePayload.sort_order，主 update 會做）
      }
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('campaign_platforms')
      .update(updatePayload)
      .eq('id', platformId)
      .select('id, sort_order, subtitle, title, summary, content, icon, theme_color, agree_count, cover_image_path, is_featured, is_published, created_at')
      .single();

    if (updateError || !updated) {
      console.error('admin platform patch failed:', updateError);
      return res.status(500).json({
        success: false,
        message: '政見更新失敗，請稍後再試。',
      });
    }

    const coverUrl = await getPlatformCoverSignedUrl(updated.cover_image_path);
    const { cover_image_path, ...rest } = updated;

    return res.json({
      success: true,
      message: '政見已儲存，里民端重新載入即可看到最新內容。',
      data: { ...rest, cover_url: coverUrl },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform patch failed:');
  }
});

// 取得政見封面 signed upload URL
app.post('/api/admin/platforms/:id/cover-upload-url', async (req, res) => {
  try {
    await requireAdmin(req);

    const platformId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      return res.status(400).json({
        success: false,
        message: '政見編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    // 確認政見存在
    const { data: exist } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, cover_image_path')
      .eq('id', platformId)
      .single();
    if (!exist) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆政見。',
      });
    }

    const fileUuid = generateUuidSafe();
    const storagePath = buildPlatformCoverStoragePath(platformId, fileUuid);
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET_PLATFORM_COVERS)
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      console.error('Platform cover signed upload URL failed:', error);
      return res.status(500).json({
        success: false,
        message: '封面上傳金鑰產生失敗，請稍後再試。',
      });
    }

    // 上傳成功後前端會再 PATCH 回寫 storage_path
    return res.json({
      success: true,
      message: '封面上傳金鑰已核發，請在 10 分鐘內完成上傳。',
      data: {
        storage_path: storagePath,
        upload_url: data.signedUrl || data.url,
        upload_token: data.token || null,
        expires_in_seconds: SIGNED_UPLOAD_URL_EXPIRES_IN,
        expected_content_type: 'image/webp',
      },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform cover upload-url failed:');
  }
});

// 回寫政見封面 storage_path（上傳完成後呼叫）
app.patch('/api/admin/platforms/:id/cover', async (req, res) => {
  try {
    await requireAdmin(req);

    const platformId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      return res.status(400).json({
        success: false,
        message: '政見編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const storagePath = req.body && req.body.storage_path;
    if (!storagePath || typeof storagePath !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'storage_path 為必填。',
      });
    }

    // 校驗路徑前綴必須是 {platformId}/
    const expectedPrefix = `${platformId}/`;
    if (!storagePath.startsWith(expectedPrefix) || !storagePath.endsWith('.webp')) {
      return res.status(400).json({
        success: false,
        message: 'storage_path 格式不正確。',
      });
    }

    // 先讀舊封面路徑（若有，之後刪除舊檔）
    const { data: current } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, cover_image_path')
      .eq('id', platformId)
      .single();
    const oldPath = current && current.cover_image_path;

    const { data: updated, error } = await supabaseAdmin
      .from('campaign_platforms')
      .update({ cover_image_path: storagePath })
      .eq('id', platformId)
      .select('id, cover_image_path')
      .single();

    if (error || !updated) {
      console.error('admin platform cover patch failed:', error);
      return res.status(500).json({
        success: false,
        message: '封面更新失敗，請稍後再試。',
      });
    }

    // 刪除舊封面（若與新路徑不同）
    if (oldPath && oldPath !== storagePath) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_PLATFORM_COVERS)
        .remove([oldPath]);
      if (removeError) {
        console.error('Remove old platform cover failed:', removeError);
      }
    }

    const coverUrl = await getPlatformCoverSignedUrl(updated.cover_image_path);

    return res.json({
      success: true,
      message: '封面已更新。',
      data: {
        id: updated.id,
        cover_image_path: updated.cover_image_path,
        cover_url: coverUrl,
      },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform cover patch failed:');
  }
});

// 交換兩筆政見的 sort_order（避免 unique index 衝突）
// 步驟：A → temp(-A_id) → B 補 A 舊位 → A 補 B 舊位
app.post('/api/admin/platforms/swap-order', async (req, res) => {
  try {
    await requireAdmin(req);

    const { a_id, b_id } = req.body || {};
    if (!Number.isInteger(a_id) || !Number.isInteger(b_id) || a_id === b_id) {
      return res.status(400).json({
        success: false,
        message: 'a_id 與 b_id 必填且不可相同。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: aRow } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, sort_order')
      .eq('id', a_id)
      .single();
    const { data: bRow } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, sort_order')
      .eq('id', b_id)
      .single();

    if (!aRow || !bRow) {
      return res.status(404).json({
        success: false,
        message: '找不到其中一筆政見。',
      });
    }

    const aSort = Number(aRow.sort_order);
    const bSort = Number(bRow.sort_order);
    if (aSort === bSort) {
      return res.json({
        success: true,
        message: '兩筆排序相同，無需交換。',
      });
    }

    // 用負 id 作 temp（既有資料 sort_order 都是正整數，不會衝突）
    const tempA = -Number(a_id);
    const step1 = await supabaseAdmin
      .from('campaign_platforms')
      .update({ sort_order: tempA })
      .eq('id', a_id);
    if (step1.error) {
      console.error('swap step1 failed:', step1.error);
      return res.status(500).json({
        success: false,
        message: '排序交換失敗（步驟 1）。',
      });
    }

    const step2 = await supabaseAdmin
      .from('campaign_platforms')
      .update({ sort_order: aSort })
      .eq('id', b_id);
    if (step2.error) {
      console.error('swap step2 failed:', step2.error);
      // 回滾 A 到原位
      await supabaseAdmin.from('campaign_platforms').update({ sort_order: aSort }).eq('id', a_id);
      return res.status(500).json({
        success: false,
        message: '排序交換失敗（步驟 2）。',
      });
    }

    const step3 = await supabaseAdmin
      .from('campaign_platforms')
      .update({ sort_order: bSort })
      .eq('id', a_id);
    if (step3.error) {
      console.error('swap step3 failed:', step3.error);
      return res.status(500).json({
        success: false,
        message: '排序交換失敗（步驟 3）。',
      });
    }

    return res.json({
      success: true,
      message: '排序已交換。',
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform swap-order failed:');
  }
});

// 刪除政見封面
app.delete('/api/admin/platforms/:id/cover', async (req, res) => {
  try {
    await requireAdmin(req);

    const platformId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(platformId) || platformId <= 0) {
      return res.status(400).json({
        success: false,
        message: '政見編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: current } = await supabaseAdmin
      .from('campaign_platforms')
      .select('id, cover_image_path')
      .eq('id', platformId)
      .single();
    const oldPath = current && current.cover_image_path;

    if (!oldPath) {
      return res.json({
        success: true,
        message: '本筆政見目前沒有封面。',
        data: { id: platformId, cover_image_path: null, cover_url: null },
      });
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET_PLATFORM_COVERS)
      .remove([oldPath]);
    if (removeError) {
      console.error('Remove platform cover failed:', removeError);
    }

    const { error: updateError } = await supabaseAdmin
      .from('campaign_platforms')
      .update({ cover_image_path: null })
      .eq('id', platformId);

    if (updateError) {
      console.error('Clear platform cover path failed:', updateError);
      return res.status(500).json({
        success: false,
        message: '封面路徑清空失敗，請稍後再試。',
      });
    }

    return res.json({
      success: true,
      message: '封面已刪除。',
      data: { id: platformId, cover_image_path: null, cover_url: null },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin platform cover delete failed:');
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

// 管理員專用驗證：先做 LINE ID Token 驗證，再比對 ADMIN_LINE_USER_IDS 白名單
// 非管理員會拋出 ForbiddenError（status 403），與一般 AuthError 區別
class ForbiddenError extends Error {
  constructor(message = '您沒有權限使用此功能。') {
    super(message);
    this.name = 'ForbiddenError';
    this.status = 403;
  }
}

async function requireAdmin(req) {
  const identity = await authenticateLineIdentity(req);
  if (!hasAdminWhitelist) {
    const err = new ForbiddenError('系統尚未設定管理員白名單。');
    throw err;
  }
  if (!isAdminLineUserId(identity.lineUserId)) {
    throw new ForbiddenError('您沒有管理員權限，無法使用此功能。');
  }
  return identity;
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

function buildPlatformCoverStoragePath(platformId, fileUuid) {
  const safeId = String(platformId).replace(/[^A-Za-z0-9_-]/g, '');
  const safeFile = String(fileUuid).replace(/[^A-Za-z0-9_-]/g, '');
  return `${safeId}/${safeFile}.webp`;
}

// 為單一政見封面產生 signed read URL；無封面回傳 null
async function getPlatformCoverSignedUrl(coverPath) {
  if (!coverPath || !supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET_PLATFORM_COVERS)
    .createSignedUrl(coverPath, SIGNED_READ_URL_EXPIRES_IN);
  if (error || !data) {
    console.error('Platform cover signed URL failed:', error);
    return null;
  }
  return data.signedUrl || data.url || null;
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
