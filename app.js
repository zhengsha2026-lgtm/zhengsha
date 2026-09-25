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
const STORAGE_BUCKET_EVENT_COVERS = 'event-covers';
const SIGNED_UPLOAD_URL_EXPIRES_IN = 60 * 10;
const SIGNED_READ_URL_EXPIRES_IN = 60 * 30;
const EVENT_ALBUM_MAX_PHOTOS = 6;
const EVENT_NOTIFY_RECIPIENT_HARD_LIMIT = 500;
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

const ADMIN_LIFF_ID = process.env.ADMIN_LIFF_ID || '';

app.get('/api/client-config', (req, res) => {
  res.json({
    liffId: LIFF_ID,
    liffFormUrl: LIFF_FORM_URL,
    candidateName: CANDIDATE_NAME,
    adminLiffId: ADMIN_LIFF_ID,
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

// ============================================================================
// 競選行程 API（里民端）
//   - 列表：upcoming 第一筆為主打，列表不重複；upcoming/past 只看 start_at
//   - 詳情：含封面、相簿（最多 6 張 signed URL）、video_url、rsvp_count、my_rsvp
//   - RSVP：報名 INSERT / 取消 DELETE；未上架不可報名；已結束不可「新」報名，
//           但已報名者結束後仍可取消（不擋取消）
//   - 未上架行程對非管理員回 404
// ============================================================================

// 撈取並組成行程列表：{ next, upcoming[], past[] }
app.get('/api/events', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  try {
    const nowIso = new Date().toISOString();

    // scope=upcoming：第一屏（下一場＋即將到來）；scope=past：過往足跡背景補載；
    // 不帶 scope：一次回全部（相容舊契約）
    const scope = req.query.scope === 'upcoming' || req.query.scope === 'past' ? req.query.scope : null;

    let listQuery = supabaseAdmin
      .from('campaign_events')
      .select(
        'id, title, description, start_at, end_at, location, cover_image_path, rsvp_count, is_published'
      )
      .eq('is_published', true);
    if (scope === 'upcoming') {
      listQuery = listQuery.gte('start_at', nowIso).order('start_at', { ascending: true });
    } else if (scope === 'past') {
      listQuery = listQuery.lt('start_at', nowIso).order('start_at', { ascending: false });
    } else {
      listQuery = listQuery.order('start_at', { ascending: true });
    }

    const { data, error } = await listQuery;

    if (error) {
      console.error('events list fetch failed:', error);
      return res.status(500).json({
        success: false,
        message: '行程列表讀取失敗，請稍後再試。',
      });
    }

    const all = data || [];
    let upcomingRaw;
    let pastRaw;
    if (scope === 'upcoming') {
      upcomingRaw = all;
      pastRaw = [];
    } else if (scope === 'past') {
      // 查詢已 start_at desc
      upcomingRaw = [];
      pastRaw = all;
    } else {
      upcomingRaw = all.filter((e) => new Date(e.start_at) >= new Date(nowIso));
      pastRaw = all.filter((e) => new Date(e.start_at) < new Date(nowIso));
    }

    // upcoming 第一筆為主打，列表不重複
    const nextItem = upcomingRaw.length > 0 ? upcomingRaw[0] : null;
    const upcomingRest = upcomingRaw.slice(1);

    // past 由近到遠（start_at desc）
    const pastSorted = pastRaw.slice().sort((a, b) => new Date(b.start_at) - new Date(a.start_at));

    // 列表封面一律簽縮圖 URL（image transform；詳情 API 才簽原圖大圖）
    const decorate = async (e) => {
      const coverUrl = await getEventCoverSignedUrl(e.cover_image_path, EVENT_LIST_COVER_TRANSFORM);
      const { cover_image_path, is_published, ...rest } = e;
      return { ...rest, cover_url: coverUrl };
    };

    const [nextDecorated, upcomingDecor, pastDecor] = await Promise.all([
      nextItem ? decorate(nextItem) : Promise.resolve(null),
      Promise.all(upcomingRest.map(decorate)),
      Promise.all(pastSorted.map(decorate)),
    ]);

    return res.json({
      success: true,
      data: {
        next: nextDecorated,
        upcoming: upcomingDecor,
        past: pastDecor,
      },
    });
  } catch (error) {
    console.error('events list failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// 行程詳情（含相簿 signed URL、my_rsvp、rsvp_count）
app.get('/api/events/:id', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'event detail auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const eventId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({
      success: false,
      message: '行程編號不正確。',
    });
  }

  try {
    const { data: eventRow, error: fetchError } = await supabaseAdmin
      .from('campaign_events')
      .select(
        'id, title, description, content, start_at, end_at, location, cover_image_path, video_url, rsvp_count, is_published'
      )
      .eq('id', eventId)
      .single();

    if (fetchError || !eventRow) {
      const code = fetchError && fetchError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆行程或尚未上架。',
        });
      }
      console.error('event detail fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '行程內容讀取失敗，請稍後再試。',
      });
    }

    // 未上架行程對非管理員回 404
    if (!eventRow.is_published && !isAdminLineUserId(identity.lineUserId)) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程或尚未上架。',
      });
    }

    const [coverUrl, albumResult, myRsvpResult] = await Promise.all([
      getEventCoverSignedUrl(eventRow.cover_image_path),
      supabaseAdmin
        .from('campaign_event_photos')
        .select('id, storage_path, sort_order')
        .eq('event_id', eventId)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true }),
      supabaseAdmin
        .from('event_rsvps')
        .select('id')
        .eq('event_id', eventId)
        .eq('line_user_id', identity.lineUserId)
        .maybeSingle(),
    ]);

    if (albumResult.error) {
      console.error('event album fetch failed:', albumResult.error);
    }
    if (myRsvpResult.error) {
      console.error('my rsvp check failed:', myRsvpResult.error);
    }

    const albumPhotos = [];
    for (const photo of (albumResult.data || [])) {
      let signedUrl = null;
      if (photo.storage_path) {
        try {
          const { data, error } = await supabaseAdmin.storage
            .from(STORAGE_BUCKET_EVENT_COVERS)
            .createSignedUrl(photo.storage_path, SIGNED_READ_URL_EXPIRES_IN);
          if (!error && data) {
            signedUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('event album signed URL error:', err.message);
        }
      }
      albumPhotos.push({
        id: photo.id,
        sort_order: photo.sort_order,
        signed_url: signedUrl,
      });
    }

    const { cover_image_path, is_published, ...rest } = eventRow;

    return res.json({
      success: true,
      data: {
        ...rest,
        cover_url: coverUrl,
        album: albumPhotos,
        rsvp_count: Number(eventRow.rsvp_count) || 0,
        my_rsvp: Boolean(myRsvpResult.data),
      },
    });
  } catch (error) {
    console.error('event detail failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// 報名 RSVP：INSERT；未上架 / 已結束不可新報名
app.post('/api/events/:id/rsvp', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'event rsvp auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const eventId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({
      success: false,
      message: '行程編號不正確。',
    });
  }

  try {
    const { data: eventRow, error: fetchError } = await supabaseAdmin
      .from('campaign_events')
      .select('id, title, start_at, is_published')
      .eq('id', eventId)
      .single();

    if (fetchError || !eventRow) {
      const code = fetchError && fetchError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆行程。',
        });
      }
      console.error('event rsvp fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '報名處理失敗，請稍後再試。',
      });
    }

    if (!eventRow.is_published) {
      return res.status(400).json({
        success: false,
        message: '此行程尚未上架，無法報名。',
      });
    }

    // 已結束不可「新」報名（start_at < now）
    const nowIso = new Date().toISOString();
    if (new Date(eventRow.start_at) < new Date(nowIso)) {
      return res.status(400).json({
        success: false,
        message: '此行程已結束，無法報名。',
      });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('event_rsvps')
      .insert([
        {
          event_id: eventId,
          line_user_id: identity.lineUserId,
        },
      ])
      .select('id')
      .maybeSingle();

    if (insertError) {
      // UNIQUE 衝突 = 已報名
      if (insertError.code === '23505') {
        return res.status(409).json({
          success: false,
          message: '您已經報名此行程。',
        });
      }
      console.error('event rsvp insert failed:', insertError);
      return res.status(500).json({
        success: false,
        message: '報名失敗，請稍後再試。',
      });
    }

    if (!inserted) {
      // maybeSingle 回傳 null 也代表已存在（INSERT ... ON CONFLICT 不適用，這裡用直插）
      return res.status(409).json({
        success: false,
        message: '您已經報名此行程。',
      });
    }

    // rsvp_count 由 trigger 維護，回讀最新值
    const { data: fresh } = await supabaseAdmin
      .from('campaign_events')
      .select('rsvp_count')
      .eq('id', eventId)
      .single();

    // 管理員通知（fire-and-forget，失敗不擋里民）
    insertAdminNotification(
      'event_rsvp',
      '行程新報名',
      `「${eventRow.title || '行程'}」有新的報名`,
      'campaign_events',
      eventId
    );

    return res.status(201).json({
      success: true,
      message: '報名成功，期待與您相見。',
      data: {
        event_id: eventId,
        my_rsvp: true,
        rsvp_count: Number(fresh && fresh.rsvp_count) || 0,
      },
    });
  } catch (error) {
    console.error('event rsvp failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// 取消報名 RSVP：DELETE；已結束「不擋」取消
app.delete('/api/events/:id/rsvp', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'event rsvp cancel auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({
      success: false,
      message: 'Supabase Service Role 尚未完成設定。',
    });
  }

  const eventId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({
      success: false,
      message: '行程編號不正確。',
    });
  }

  try {
    const { error: deleteError } = await supabaseAdmin
      .from('event_rsvps')
      .delete()
      .eq('event_id', eventId)
      .eq('line_user_id', identity.lineUserId);

    if (deleteError) {
      console.error('event rsvp cancel failed:', deleteError);
      return res.status(500).json({
        success: false,
        message: '取消報名失敗，請稍後再試。',
      });
    }

    const { data: fresh } = await supabaseAdmin
      .from('campaign_events')
      .select('rsvp_count')
      .eq('id', eventId)
      .single();

    return res.json({
      success: true,
      message: '已取消報名。',
      data: {
        event_id: eventId,
        my_rsvp: false,
        rsvp_count: Number(fresh && fresh.rsvp_count) || 0,
      },
    });
  } catch (error) {
    console.error('event rsvp cancel failed:', error);
    return res.status(500).json({
      success: false,
      message: '伺服器忙碌中，請稍後再試。',
    });
  }
});

// ============================================================================
// 報平安（safety）：里民端 API
// 規則：
//   1. 加入必須本人同意（LIFF ID Token 的 sub）
//   2. 一天只計一次簽到（台灣日期，後端計算）；已簽再按為冪等（200，不報錯）
//   3. 退出 = left_at 設時間（soft delete）；重新加入重設 baseline_date
//   4. 待關懷 = 活躍且今日未簽且 missing_days >= SAFETY_CARE_MISSING_DAYS（管理端計算）
// ============================================================================

const SAFETY_TAIPEI_TZ = 'Asia/Taipei';
const SAFETY_NAME_MAX_LENGTH = 20;
const SAFETY_NOTE_MAX_LENGTH = 200;
const SAFETY_SNOOZE_DAYS = 3;
const SAFETY_REJECT_REASON_MAX_LENGTH = 200;
// 待關懷門檻（日曆天）：距最後簽到日（或 baseline_date）>= 3 天才算待關懷。
// 例：週一簽過 → 週二(1)、週三(2) 不算 → 週四(3) 早上 09:00 才通知幹部、才進待關懷
// （chips 待關懷 / filter=care / 排序置頂 / cron admin 全讀 buildSafetyAdminItem 的 needs_care，單一事實來源）
const SAFETY_CARE_MISSING_DAYS = 3;

// 台灣時區的今天，回傳 'YYYY-MM-DD'（後端唯一可信的日期來源，不信前端）
function getTaipeiToday() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: SAFETY_TAIPEI_TZ }).format(now);
  return parts; // 'YYYY-MM-DD'
}

function dateDaysDiff(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00Z`).getTime();
  const to = new Date(`${toDateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86400000);
}

// 台灣日期 + N 天，回傳 'YYYY-MM-DD'（暫不提醒幹部的到期日計算用）
function addDaysToTaipeiDate(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00Z`).getTime();
  if (Number.isNaN(base)) return null;
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

// 與許願池同一套電話驗證：選填，空白直接通過；非空只檢查長度上限（30），不驗證格式
function sanitizeSafetyPhone(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (trimmed.length > 30) return null;
  return trimmed;
}

// 出生年選填（第四期申請制）：整數 1900 ~ 台北時區當年；空值通過
function sanitizeSafetyBirthYear(value) {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const n = Number(value);
  if (!Number.isInteger(n) || String(value).trim() === '') return { ok: false, value: null };
  const thisYear = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: SAFETY_TAIPEI_TZ, year: 'numeric' }).format(new Date())
  );
  if (n < 1900 || n > thisYear) return { ok: false, value: null };
  return { ok: true, value: n };
}

// 查自己的活躍會員資料（left_at IS NULL；含 pending / rejected，供各端點自行判斷 approval_status）
async function findActiveSafetyMember(lineUserId) {
  const { data, error } = await supabaseAdmin
    .from('safety_members')
    .select(
      'id, line_user_id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, approval_status, applied_at, reviewed_at, reviewed_by, birth_year, reject_reason'
    )
    .eq('line_user_id', lineUserId)
    .is('left_at', null)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function buildSafetyMemberData(row) {
  return {
    id: row.id,
    display_name: row.display_name || '',
    phone: row.phone || '',
    contact_name: row.contact_name || '',
    contact_phone: row.contact_phone || '',
    joined_at: row.joined_at,
    baseline_date: row.baseline_date,
    approval_status: row.approval_status || 'approved',
    applied_at: row.applied_at || null,
    birth_year: row.birth_year || null,
    reject_reason: row.reject_reason || null,
  };
}

// 連續簽到天數（顯示用，不存欄位、每次現算）：從今天（台北日期）往回數 safety_checkins，
// checkin_date 必須一天天相連，缺一天就停
// - 今天未簽 → 0（前端不顯示）；今天已簽 → 至少 1
// - 不跨過 baseline_date（核准/重新加入的起算日），更早的舊簽到不接
// - 只查本會員的列（member_id 過濾）
async function calculateSafetyStreak(memberId, baselineDate) {
  const today = getTaipeiToday();
  const { data, error } = await supabaseAdmin
    .from('safety_checkins')
    .select('checkin_date')
    .eq('member_id', memberId)
    .gte('checkin_date', baselineDate)
    .order('checkin_date', { ascending: false });
  if (error) throw error;

  const dates = new Set((data || []).map((row) => row.checkin_date));
  if (!dates.has(today)) return 0;

  let streak = 1;
  let cursor = addDaysToTaipeiDate(today, -1);
  while (cursor && cursor >= baselineDate && dates.has(cursor)) {
    streak += 1;
    cursor = addDaysToTaipeiDate(cursor, -1);
  }
  return streak;
}

// GET /api/safety/status：我的報平安狀態（第四期起回傳 approval_status 供前端切換四態）
// - 無列 / 已退出 → joined:false + approval_status:null（前端顯申請表單）
// - pending       → joined:false + approval_status:'pending'（審核中，不可簽到）
// - rejected      → joined:false + approval_status:'rejected' + reject_reason（可再申請）
// - approved      → joined:true（現有簽到 UI 不變）
app.get('/api/safety/status', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'safety status auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    const today = getTaipeiToday();
    const member = await findActiveSafetyMember(identity.lineUserId);
    if (!member) {
      return res.json({
        success: true,
        data: {
          joined: false,
          member: null,
          approval_status: null,
          reject_reason: null,
          today,
          checked_in_today: false,
          today_checkin_at: null,
          last_checkin_date: null,
        },
      });
    }

    const approvalStatus = member.approval_status || 'approved';

    // pending / rejected：還不是有效會員，直接回組織資料（不查簽到）
    if (approvalStatus !== 'approved') {
      return res.json({
        success: true,
        data: {
          joined: false,
          member: buildSafetyMemberData(member),
          approval_status: approvalStatus,
          reject_reason: approvalStatus === 'rejected' ? member.reject_reason || '' : null,
          today,
          checked_in_today: false,
          today_checkin_at: null,
          last_checkin_date: null,
        },
      });
    }

    const { data: todayCheckin, error: todayError } = await supabaseAdmin
      .from('safety_checkins')
      .select('id, checkin_date, created_at')
      .eq('member_id', member.id)
      .eq('checkin_date', today)
      .maybeSingle();
    if (todayError) throw todayError;

    const { data: lastCheckin, error: lastError } = await supabaseAdmin
      .from('safety_checkins')
      .select('checkin_date')
      .eq('member_id', member.id)
      .order('checkin_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw lastError;

    // 連續簽到天數（顯示用）：今天未簽 = 0，前端不顯示
    const streak = await calculateSafetyStreak(member.id, member.baseline_date);

    return res.json({
      success: true,
      data: {
        joined: true,
        member: buildSafetyMemberData(member),
        approval_status: 'approved',
        reject_reason: null,
        today,
        checked_in_today: Boolean(todayCheckin),
        today_checkin_at: todayCheckin ? todayCheckin.created_at : null,
        last_checkin_date: lastCheckin ? lastCheckin.checkin_date : null,
        streak,
      },
    });
  } catch (error) {
    console.error('safety status failed:', error);
    return res.status(500).json({ success: false, message: '報平安狀態讀取失敗，請稍後再試。' });
  }
});

// POST /api/safety/join：送出加入申請（第四期申請制）
// - 已 approved 未退出 → 409 已加入（維持）
// - pending → 409 審核中（不可重複當新件）
// - rejected / 已退出 / 無列 → 同一列寫成 pending：更新表單資料、applied_at 重置、
//   清 reviewed_* 與 reject_reason；已退出者清 left_at 與殘留暫停（snooze_until）
// - baseline_date 不在此時重設（核准時才重設，避免核准前就算天數）
app.post('/api/safety/join', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'safety join auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const displayName = String((req.body && req.body.display_name) || '').trim();
  if (!displayName || displayName.length > SAFETY_NAME_MAX_LENGTH) {
    return res.status(400).json({ success: false, message: `請填寫稱呼（${SAFETY_NAME_MAX_LENGTH} 字以內）。` });
  }

  const phone = sanitizeSafetyPhone(req.body && req.body.phone);
  if (phone === null) {
    return res.status(400).json({ success: false, message: '您的電話長度過長，請檢查後再送出。' });
  }
  const contactName = String((req.body && req.body.contact_name) || '').trim().slice(0, SAFETY_NAME_MAX_LENGTH);
  const contactPhone = sanitizeSafetyPhone(req.body && req.body.contact_phone);
  if (contactPhone === null) {
    return res.status(400).json({ success: false, message: '聯絡人電話長度過長，請檢查後再送出。' });
  }
  const birthYearCheck = sanitizeSafetyBirthYear(req.body && req.body.birth_year);
  if (!birthYearCheck.ok) {
    return res.status(400).json({ success: false, message: '出生年請填西元年（1900 至今年），或留空。' });
  }

  try {
    const today = getTaipeiToday();
    const nowIso = new Date().toISOString();

    // 撈自己的列（left_at IS NULL，含 pending / rejected）
    const existing = await findActiveSafetyMember(identity.lineUserId);
    if (existing) {
      if (existing.approval_status === 'approved') {
        return res.status(409).json({ success: false, message: '您已加入報平安。' });
      }
      if (existing.approval_status === 'pending') {
        return res.status(409).json({ success: false, message: '申請審核中，請耐心等候幹部確認。' });
      }
      // rejected：同一列重送（更新表單資料、重置申請時間、清審核紀錄）
    }

    // 查是否有退出紀錄（同一人同一列；再申請同樣走 pending）
    let leftMember = null;
    if (!existing) {
      const { data: leftRow, error: findError } = await supabaseAdmin
        .from('safety_members')
        .select('id, left_at')
        .eq('line_user_id', identity.lineUserId)
        .not('left_at', 'is', null)
        .maybeSingle();
      if (findError) throw findError;
      leftMember = leftRow;
    }

    // 申請 payload（pending 起點）
    const applicationFields = {
      display_name: displayName,
      phone: phone || null,
      contact_name: contactName || null,
      contact_phone: contactPhone || null,
      birth_year: birthYearCheck.value,
      approval_status: 'pending',
      applied_at: nowIso,
      reviewed_at: null,
      reviewed_by: null,
      reject_reason: null,
    };

    let row;
    if (existing || leftMember) {
      const targetId = existing ? existing.id : leftMember.id;
      const { data: updated, error: updateError } = await supabaseAdmin
        .from('safety_members')
        .update({
          ...applicationFields,
          left_at: null,
          admin_notify_snooze_until: null,
        })
        .eq('id', targetId)
        .select('id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, approval_status, applied_at, birth_year, reject_reason')
        .single();
      if (updateError) throw updateError;
      row = updated;
    } else {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from('safety_members')
        .insert([
          {
            line_user_id: identity.lineUserId,
            ...applicationFields,
            baseline_date: today,
          },
        ])
        .select('id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, approval_status, applied_at, birth_year, reject_reason')
        .single();
      if (insertError) {
        // UNIQUE 衝突 = 並發重複申請
        if (insertError.code === '23505') {
          return res.status(409).json({ success: false, message: '申請已送出或審核中，請勿重複送出。' });
        }
        throw insertError;
      }
      row = inserted;
    }

    // 管理員通知（fire-and-forget，失敗不擋里民）
    insertAdminNotification(
      'safety_pending',
      '報平安待審核',
      `「${displayName}」申請加入報平安`,
      'safety_members',
      row.id
    );

    return res.status(201).json({
      success: true,
      message: '申請已送出，幹部審核通過後即可開始天天報平安。',
      data: {
        joined: false,
        member: buildSafetyMemberData(row),
        approval_status: 'pending',
        reject_reason: null,
        today,
        checked_in_today: false,
        today_checkin_at: null,
        last_checkin_date: null,
      },
    });
  } catch (error) {
    console.error('safety join failed:', error);
    return res.status(500).json({ success: false, message: '送出申請失敗，請稍後再試。' });
  }
});

// PATCH /api/safety/profile：修改稱呼/電話/聯絡人
app.patch('/api/safety/profile', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'safety profile auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const body = req.body || {};
  const hasAnyField =
    body.display_name !== undefined ||
    body.phone !== undefined ||
    body.contact_name !== undefined ||
    body.contact_phone !== undefined;
  if (!hasAnyField) {
    return res.status(400).json({ success: false, message: '沒有可更新的欄位。' });
  }

  const patch = {};
  if (body.display_name !== undefined) {
    const displayName = String(body.display_name || '').trim();
    if (!displayName || displayName.length > SAFETY_NAME_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: `稱呼需為 1-${SAFETY_NAME_MAX_LENGTH} 字。` });
    }
    patch.display_name = displayName;
  }
  if (body.phone !== undefined) {
    const phone = sanitizeSafetyPhone(body.phone);
    if (phone === null) {
      return res.status(400).json({ success: false, message: '您的電話長度過長，請檢查後再送出。' });
    }
    patch.phone = phone || null;
  }
  if (body.contact_name !== undefined) {
    const contactName = String(body.contact_name || '').trim();
    if (contactName.length > SAFETY_NAME_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: `聯絡人姓名需為 ${SAFETY_NAME_MAX_LENGTH} 字以內。` });
    }
    patch.contact_name = contactName || null;
  }
  if (body.contact_phone !== undefined) {
    const contactPhone = sanitizeSafetyPhone(body.contact_phone);
    if (contactPhone === null) {
      return res.status(400).json({ success: false, message: '聯絡人電話長度過長，請檢查後再送出。' });
    }
    patch.contact_phone = contactPhone || null;
  }

  try {
    const member = await findActiveSafetyMember(identity.lineUserId);
    if (!member) {
      return res.status(404).json({ success: false, message: '您尚未加入報平安。' });
    }
    // 僅已核准會員可改資料；pending 期間不開放編輯（要改請重送申請），rejected 同
    if (member.approval_status !== 'approved') {
      return res.status(403).json({ success: false, message: '申請審核中或未通過，暫時無法修改資料。' });
    }

    const { data: updated, error } = await supabaseAdmin
      .from('safety_members')
      .update(patch)
      .eq('id', member.id)
      .select('id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at')
      .single();
    if (error) throw error;

    return res.json({ success: true, message: '設定已更新。', data: { member: buildSafetyMemberData(updated) } });
  } catch (error) {
    console.error('safety profile failed:', error);
    return res.status(500).json({ success: false, message: '更新設定失敗，請稍後再試。' });
  }
});

// POST /api/safety/checkin：今日簽到（冪等：已簽再按回 200，不報錯不重複計次）
app.post('/api/safety/checkin', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'safety checkin auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    const today = getTaipeiToday();
    const member = await findActiveSafetyMember(identity.lineUserId);
    if (!member) {
      return res.status(404).json({ success: false, message: '您尚未加入報平安。' });
    }
    if (member.approval_status === 'pending') {
      return res.status(403).json({ success: false, message: '申請審核中，幹部確認通過後即可簽到。' });
    }
    if (member.approval_status === 'rejected') {
      return res.status(403).json({ success: false, message: '申請尚未通過，暫時無法簽到。' });
    }

    // 已簽：冪等回 200
    const { data: existing, error: findError } = await supabaseAdmin
      .from('safety_checkins')
      .select('id, checkin_date, created_at')
      .eq('member_id', member.id)
      .eq('checkin_date', today)
      .maybeSingle();
    if (findError) throw findError;
    if (existing) {
      const streak = await calculateSafetyStreak(member.id, member.baseline_date);
      return res.json({
        success: true,
        message: '今天已經報過平安囉。',
        data: { already_checked_in: true, checkin_date: existing.checkin_date, checkin_at: existing.created_at, streak },
      });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('safety_checkins')
      .insert([{ member_id: member.id, checkin_date: today }])
      .select('id, checkin_date, created_at')
      .single();
    if (insertError) {
      // UNIQUE 衝突 = 並發重複簽到，視為已簽（冪等）
      if (insertError.code === '23505') {
        const { data: again } = await supabaseAdmin
          .from('safety_checkins')
          .select('id, checkin_date, created_at')
          .eq('member_id', member.id)
          .eq('checkin_date', today)
          .maybeSingle();
        const streak = await calculateSafetyStreak(member.id, member.baseline_date);
        return res.json({
          success: true,
          message: '今天已經報過平安囉。',
          data: { already_checked_in: true, checkin_date: again ? again.checkin_date : today, checkin_at: again ? again.created_at : null, streak },
        });
      }
      throw insertError;
    }

    const streak = await calculateSafetyStreak(member.id, member.baseline_date);
    return res.status(201).json({
      success: true,
      message: '已記錄您今天平安，謝謝。',
      data: { already_checked_in: false, checkin_date: inserted.checkin_date, checkin_at: inserted.created_at, streak },
    });
  } catch (error) {
    console.error('safety checkin failed:', error);
    return res.status(500).json({ success: false, message: '簽到失敗，請稍後再試。' });
  }
});

// DELETE /api/safety/membership：退出報平安（soft delete；簽到歷史保留）
app.delete('/api/safety/membership', async (req, res) => {
  let identity;
  try {
    identity = await authenticateLineIdentity(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'safety leave auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    const member = await findActiveSafetyMember(identity.lineUserId);
    if (!member) {
      return res.status(404).json({ success: false, message: '您尚未加入報平安。' });
    }
    // 僅已核准會員可退出；pending 無退出概念（第一期無撤回申請功能）
    if (member.approval_status !== 'approved') {
      return res.status(403).json({ success: false, message: '申請審核中或未通過，無需退出。' });
    }

    const { error } = await supabaseAdmin
      .from('safety_members')
      .update({ left_at: new Date().toISOString() })
      .eq('id', member.id)
      .is('left_at', null);
    if (error) throw error;

    return res.json({ success: true, message: '已退出報平安，您的資料不再出現在關懷名單。' });
  } catch (error) {
    console.error('safety leave failed:', error);
    return res.status(500).json({ success: false, message: '退出失敗，請稍後再試。' });
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
        message: '反映內容儲存失敗，請稍後再試一次。',
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

    // 管理員通知（fire-and-forget，失敗不擋里民）
    insertAdminNotification(
      'feedback_new',
      '新反映',
      buildFeedbackNotificationSummary(payload.data.user_name, payload.data.content),
      'user_feedback',
      feedbackId
    );

    return res.status(201).json({
      success: true,
      message: '感謝您的反映，我們已收到並會儘速處理。',
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
        message: '我的案件清單讀取失敗，請稍後再試。',
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
      message: '反映編號不正確。',
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
          message: '找不到這筆反映紀錄。',
        });
      }
      console.error('my-feedback detail fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '反映內容讀取失敗，請稍後再試。',
      });
    }

    if (feedbackRow.line_user_id !== identity.lineUserId) {
      return res.status(403).json({
        success: false,
        message: '您沒有權限檢視這筆反映內容。',
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

// ============================================================================
// 管理員通知 API（第一期：紅點 + 列表 + 已讀）
// 表：admin_notifications / admin_notification_reads（migration 008）
// ============================================================================

const ADMIN_NOTIFICATION_LIST_DEFAULT_LIMIT = 30;
const ADMIN_NOTIFICATION_LIST_MAX_LIMIT = 100;

// 共用：抓該管理員的未讀數（排除已讀列；reads 一人一通知一列 unique）
async function countAdminUnreadNotifications(lineUserId) {
  const { count, error } = await supabaseAdmin
    .from('admin_notifications')
    .select('id', { count: 'exact', head: true })
    .not(
      'id',
      'in',
      `(${await supabaseAdmin
        .from('admin_notification_reads')
        .select('notification_id')
        .eq('line_user_id', lineUserId)
        .then((r) => (r.data || []).map((x) => x.notification_id).join(',') || '-1')})`
    );
  if (error) throw error;
  return count || 0;
}

// GET /api/admin/notifications?unread=1&limit=30
// 回 items（含 is_read）+ unread_count
app.get('/api/admin/notifications', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/notifications list auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    const unreadOnly = req.query.unread === '1';
    const limit = Math.min(
      Math.max(Number(req.query.limit) || ADMIN_NOTIFICATION_LIST_DEFAULT_LIMIT, 1),
      ADMIN_NOTIFICATION_LIST_MAX_LIMIT
    );

    // 該管理員已讀集合
    const { data: readRows, error: readError } = await supabaseAdmin
      .from('admin_notification_reads')
      .select('notification_id')
      .eq('line_user_id', identity.lineUserId)
      .limit(1000);
    if (readError) throw readError;
    const readSet = new Set((readRows || []).map((r) => r.notification_id));

    const unreadCount = await countAdminUnreadNotifications(identity.lineUserId);

    // 列表：最新在前
    const { data: items, error: listError } = await supabaseAdmin
      .from('admin_notifications')
      .select('id, type, title, summary, ref_table, ref_id, created_at')
      .order('created_at', { ascending: false })
      .limit(limit * 2); // 多抓一些，未讀過濾後仍湊得到 limit
    if (listError) throw listError;

    const merged = (items || [])
      .map((row) => ({ ...row, is_read: readSet.has(row.id) }))
      .filter((row) => (unreadOnly ? !row.is_read : true))
      .slice(0, limit);

    return res.json({
      success: true,
      data: { items: merged, unread_count: unreadCount },
    });
  } catch (error) {
    console.error('admin/notifications list failed:', error);
    return res.status(500).json({ success: false, message: '通知列表讀取失敗，請稍後再試。' });
  }
});

// GET /api/admin/notifications/unread-count
app.get('/api/admin/notifications/unread-count', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/notifications unread-count auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    const unreadCount = await countAdminUnreadNotifications(identity.lineUserId);
    return res.json({ success: true, data: { unread_count: unreadCount } });
  } catch (error) {
    console.error('admin/notifications unread-count failed:', error);
    return res.status(500).json({ success: false, message: '未讀數讀取失敗，請稍後再試。' });
  }
});

// POST /api/admin/notifications/:id/read（冪等：已讀再按一樣 200）
app.post('/api/admin/notifications/:id/read', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/notifications read auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const notificationId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(notificationId) || notificationId <= 0) {
    return res.status(400).json({ success: false, message: '通知編號不正確。' });
  }

  try {
    // 確認通知存在
    const { data: notification, error: fetchError } = await supabaseAdmin
      .from('admin_notifications')
      .select('id')
      .eq('id', notificationId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!notification) {
      return res.status(404).json({ success: false, message: '找不到這則通知。' });
    }

    // upsert 已讀（unique(notification_id, line_user_id) 衝突時忽略 = 冪等）
    const { error: upsertError } = await supabaseAdmin
      .from('admin_notification_reads')
      .upsert(
        [{ notification_id: notificationId, line_user_id: identity.lineUserId }],
        { onConflict: 'notification_id,line_user_id', ignoreDuplicates: true }
      );
    if (upsertError) throw upsertError;

    const unreadCount = await countAdminUnreadNotifications(identity.lineUserId);
    return res.json({ success: true, data: { unread_count: unreadCount } });
  } catch (error) {
    console.error('admin/notifications read failed:', error);
    return res.status(500).json({ success: false, message: '標記已讀失敗，請稍後再試。' });
  }
});

// POST /api/admin/notifications/read-all（把目前所有通知標已讀）
app.post('/api/admin/notifications/read-all', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/notifications read-all auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  try {
    // 抓該管理員未讀的通知 id
    const { data: readRows, error: readError } = await supabaseAdmin
      .from('admin_notification_reads')
      .select('notification_id')
      .eq('line_user_id', identity.lineUserId)
      .limit(5000);
    if (readError) throw readError;
    const readSet = new Set((readRows || []).map((r) => r.notification_id));

    const { data: allRows, error: listError } = await supabaseAdmin
      .from('admin_notifications')
      .select('id')
      .order('id', { ascending: false })
      .limit(5000);
    if (listError) throw listError;

    const unreadIds = (allRows || []).map((r) => r.id).filter((id) => !readSet.has(id));
    if (unreadIds.length > 0) {
      const rows = unreadIds.map((id) => ({ notification_id: id, line_user_id: identity.lineUserId }));
      // ignoreDuplicates：與並發已讀打架時忽略
      const { error: insertError } = await supabaseAdmin
        .from('admin_notification_reads')
        .upsert(rows, { onConflict: 'notification_id,line_user_id', ignoreDuplicates: true });
      if (insertError) throw insertError;
    }

    return res.json({ success: true, data: { unread_count: 0, marked: unreadIds.length } });
  } catch (error) {
    console.error('admin/notifications read-all failed:', error);
    return res.status(500).json({ success: false, message: '全部已讀失敗，請稍後再試。' });
  }
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
        message: '反映列表讀取失敗，請稍後再試。',
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
      message: '反映編號不正確。',
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
          message: '找不到這筆反映紀錄。',
        });
      }
      console.error('admin/feedback detail fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '反映內容讀取失敗，請稍後再試。',
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
      message: '反映編號不正確。',
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
          message: '找不到這筆反映紀錄。',
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
        message: '反映狀態更新失敗，請稍後再試。',
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
      message: '已儲存進度，里民端「我的案件」將同步顯示最新狀態。',
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

app.delete('/api/admin/feedback/:id', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/feedback delete auth failed');
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
      message: '反映編號不正確。',
    });
  }

  try {
    // 刪前確認該筆存在，並取出照片 storage_path（刪 Storage 用）
    const { data: target, error: fetchError } = await supabaseAdmin
      .from('user_feedback')
      .select('id, user_name, content')
      .eq('id', feedbackId)
      .maybeSingle();

    if (fetchError) {
      console.error('admin feedback delete fetch failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '案件讀取失敗，請稍後再試。',
      });
    }
    if (!target) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆反映紀錄，可能已被刪除。',
      });
    }

    // 取出照片路徑（DB cascade 會刪 photos/status_logs，Storage 要手動刪）
    const { data: photos, error: photosError } = await supabaseAdmin
      .from('user_feedback_photos')
      .select('storage_path')
      .eq('feedback_id', feedbackId);

    if (photosError) {
      console.error('admin feedback delete photos fetch failed:', photosError);
      return res.status(500).json({
        success: false,
        message: '案件照片讀取失敗，請稍後再試。',
      });
    }

    const photoPaths = (photos || [])
      .map((p) => p.storage_path)
      .filter((p) => typeof p === 'string' && p.length > 0);

    // 刪主表（photos、status_logs 依 ON DELETE CASCADE 一併刪除）
    const { error: deleteError } = await supabaseAdmin
      .from('user_feedback')
      .delete()
      .eq('id', feedbackId);

    if (deleteError) {
      console.error('admin feedback delete failed:', deleteError);
      return res.status(500).json({
        success: false,
        message: '反映刪除失敗，請稍後再試。',
      });
    }

    // 刪 Storage 照片（主表已刪，Storage 失敗不擋回應，只記 log）
    if (photoPaths.length > 0) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_WISH_PHOTOS)
        .remove(photoPaths);
      if (removeError) {
        console.error('Remove wish photos on feedback delete failed:', removeError);
      }
    }

    return res.json({
      success: true,
      message: '反映已刪除，照片與處理紀錄已一併移除。',
      data: {
        id: feedbackId,
        photo_count: photoPaths.length,
        deleted_by: identity.lineUserId,
      },
    });
  } catch (error) {
    console.error('admin feedback delete failed:', error);
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

// ============================================================================
// 行程管理 API（管理員白名單）
//   - 列表/詳情/新增/編輯/刪除
//   - 封面上傳 URL / 回寫 / 刪除
//   - 相簿上傳 URL / 回寫 / 刪除（每場最多 6 張，應用層限制）
//   - 影片只存外連 URL
//   - 通知：notify-rsvp（已報名者）/ notify-wish-pool（許願池里民）
//   - 通知文案後端寫死；未設 LINE token 回明確錯誤；> 500 人第一版拒絕
// ============================================================================

// 取得行程列表（含未上架，含封面 signed URL、rsvp_count）
app.get('/api/admin/events', async (req, res) => {
  try {
    await requireAdmin(req);

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data, error } = await supabaseAdmin
      .from('campaign_events')
      .select('id, title, description, start_at, end_at, location, cover_image_path, video_url, rsvp_count, is_published, created_at')
      .order('start_at', { ascending: true });

    if (error) {
      console.error('admin events list failed:', error);
      return res.status(500).json({
        success: false,
        message: '行程列表讀取失敗，請稍後再試。',
      });
    }

    const decorated = await Promise.all((data || []).map(async (e) => {
      const coverUrl = await getEventCoverSignedUrl(e.cover_image_path);
      const { cover_image_path, ...rest } = e;
      return { ...rest, cover_url: coverUrl };
    }));

    return res.json({
      success: true,
      data: decorated,
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin events list failed:');
  }
});

// 取得單筆行程完整資料（含相簿 signed URL）
app.get('/api/admin/events/:id', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: eventRow, error: fetchError } = await supabaseAdmin
      .from('campaign_events')
      .select('id, title, description, content, start_at, end_at, location, cover_image_path, video_url, rsvp_count, is_published, created_at')
      .eq('id', eventId)
      .single();

    if (fetchError || !eventRow) {
      const code = fetchError && fetchError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆行程。',
        });
      }
      console.error('admin event detail failed:', fetchError);
      return res.status(500).json({
        success: false,
        message: '行程資料讀取失敗，請稍後再試。',
      });
    }

    const { data: albumRows, error: albumError } = await supabaseAdmin
      .from('campaign_event_photos')
      .select('id, storage_path, sort_order, created_at')
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });

    if (albumError) {
      console.error('admin event album fetch failed:', albumError);
    }

    const album = [];
    for (const photo of (albumRows || [])) {
      let signedUrl = null;
      if (photo.storage_path) {
        try {
          const { data, error } = await supabaseAdmin.storage
            .from(STORAGE_BUCKET_EVENT_COVERS)
            .createSignedUrl(photo.storage_path, SIGNED_READ_URL_EXPIRES_IN);
          if (!error && data) {
            signedUrl = data.signedUrl;
          }
        } catch (err) {
          console.error('admin event album signed URL error:', err.message);
        }
      }
      album.push({
        id: photo.id,
        storage_path: photo.storage_path,
        sort_order: photo.sort_order,
        signed_url: signedUrl,
        created_at: photo.created_at,
      });
    }

    const coverUrl = await getEventCoverSignedUrl(eventRow.cover_image_path);
    const { cover_image_path, ...rest } = eventRow;

    return res.json({
      success: true,
      data: { ...rest, cover_url: coverUrl, album },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event detail failed:');
  }
});

// 新增行程（預設未上架）
app.post('/api/admin/events', async (req, res) => {
  try {
    await requireAdmin(req);

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const normalized = normalizeEventPayload(req.body || {});
    if (!normalized.success) {
      return res.status(400).json(normalized);
    }

    const insertRow = {
      ...normalized.data,
      is_published: false, // 新增預設未上架
      rsvp_count: 0,
    };

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('campaign_events')
      .insert([insertRow])
      .select('id, title, start_at, is_published')
      .single();

    if (insertError || !inserted) {
      console.error('admin event insert failed:', insertError);
      return res.status(500).json({
        success: false,
        message: '行程新增失敗，請稍後再試。',
      });
    }

    return res.status(201).json({
      success: true,
      message: '行程已建立，預設為未上架。',
      data: inserted,
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event insert failed:');
  }
});

// 編輯行程（文案/時間/地點/影片/上架狀態）
app.patch('/api/admin/events/:id', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const body = req.body || {};
    // 若只帶 end_at 沒帶 start_at，需先取現存 start_at 做前後端一致的時間順序驗證
    let existingStartAt = null;
    const hasEndAt = Object.prototype.hasOwnProperty.call(body, 'end_at');
    const hasStartAt = Object.prototype.hasOwnProperty.call(body, 'start_at');
    if (hasEndAt && !hasStartAt) {
      const { data: existingRow } = await supabaseAdmin
        .from('campaign_events')
        .select('start_at')
        .eq('id', eventId)
        .maybeSingle();
      if (existingRow && existingRow.start_at) {
        existingStartAt = existingRow.start_at;
      }
    }

    let updatePayload;
    try {
      updatePayload = buildEventUpdatePayload(body, existingStartAt);
    } catch (err) {
      const status = err.status || 400;
      return res.status(status).json({
        success: false,
        message: err.message || '欄位格式不正確。',
      });
    }
    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        message: '沒有可更新的欄位。',
      });
    }

    // 編輯時不得經本端點改動 rsvp_count（由 trigger 維護）
    delete updatePayload.rsvp_count;

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('campaign_events')
      .update(updatePayload)
      .eq('id', eventId)
      .select('id, title, description, content, start_at, end_at, location, cover_image_path, video_url, rsvp_count, is_published, created_at')
      .single();

    if (updateError || !updated) {
      const code = updateError && updateError.code;
      if (code === 'PGRST116') {
        return res.status(404).json({
          success: false,
          message: '找不到這筆行程。',
        });
      }
      console.error('admin event patch failed:', updateError);
      return res.status(500).json({
        success: false,
        message: '行程更新失敗，請稍後再試。',
      });
    }

    const coverUrl = await getEventCoverSignedUrl(updated.cover_image_path);
    const { cover_image_path, ...rest } = updated;

    return res.json({
      success: true,
      message: '行程已儲存。',
      data: { ...rest, cover_url: coverUrl },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event patch failed:');
  }
});

// 刪除行程（cascade 相簿 + RSVP）
app.delete('/api/admin/events/:id', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    // 先撈封面與相簿路徑，刪列後清 storage
    const { data: eventRow } = await supabaseAdmin
      .from('campaign_events')
      .select('id, cover_image_path')
      .eq('id', eventId)
      .maybeSingle();

    const { data: albumRows } = await supabaseAdmin
      .from('campaign_event_photos')
      .select('storage_path')
      .eq('event_id', eventId);

    if (!eventRow) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程。',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('campaign_events')
      .delete()
      .eq('id', eventId);

    if (deleteError) {
      console.error('admin event delete failed:', deleteError);
      return res.status(500).json({
        success: false,
        message: '行程刪除失敗，請稍後再試。',
      });
    }

    // 清 storage：封面 + 相簿（失敗只記錄，不阻擋）
    const pathsToRemove = [];
    if (eventRow.cover_image_path) pathsToRemove.push(eventRow.cover_image_path);
    for (const p of (albumRows || [])) {
      if (p.storage_path) pathsToRemove.push(p.storage_path);
    }
    if (pathsToRemove.length > 0) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .remove(pathsToRemove);
      if (removeError) {
        console.error('Remove event storage files failed:', removeError);
      }
    }

    return res.json({
      success: true,
      message: '行程已刪除。',
      data: { id: eventId },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event delete failed:');
  }
});

// 取得封面上傳 URL
app.post('/api/admin/events/:id/cover-upload-url', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: exist } = await supabaseAdmin
      .from('campaign_events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle();
    if (!exist) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程。',
      });
    }

    const fileUuid = generateUuidSafe();
    const storagePath = buildEventCoverStoragePath(eventId, fileUuid);
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET_EVENT_COVERS)
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      console.error('Event cover signed upload URL failed:', error);
      return res.status(500).json({
        success: false,
        message: '封面上傳金鑰產生失敗，請稍後再試。',
      });
    }

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
    return handleAuthOrServerError(res, error, 'admin event cover upload-url failed:');
  }
});

// 回寫封面 storage_path（上傳完成後呼叫，刪舊封面）
app.patch('/api/admin/events/:id/cover', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
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

    // 校驗路徑前綴必須是 covers/{eventId}/
    const expectedPrefix = `covers/${eventId}/`;
    if (!storagePath.startsWith(expectedPrefix) || !storagePath.endsWith('.webp')) {
      return res.status(400).json({
        success: false,
        message: 'storage_path 格式不正確。',
      });
    }

    const { data: current } = await supabaseAdmin
      .from('campaign_events')
      .select('id, cover_image_path')
      .eq('id', eventId)
      .single();
    const oldPath = current && current.cover_image_path;

    const { data: updated, error } = await supabaseAdmin
      .from('campaign_events')
      .update({ cover_image_path: storagePath })
      .eq('id', eventId)
      .select('id, cover_image_path')
      .single();

    if (error || !updated) {
      console.error('admin event cover patch failed:', error);
      return res.status(500).json({
        success: false,
        message: '封面更新失敗，請稍後再試。',
      });
    }

    if (oldPath && oldPath !== storagePath) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .remove([oldPath]);
      if (removeError) {
        console.error('Remove old event cover failed:', removeError);
      }
    }

    const coverUrl = await getEventCoverSignedUrl(updated.cover_image_path);

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
    return handleAuthOrServerError(res, error, 'admin event cover patch failed:');
  }
});

// 刪除封面
app.delete('/api/admin/events/:id/cover', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: current } = await supabaseAdmin
      .from('campaign_events')
      .select('id, cover_image_path')
      .eq('id', eventId)
      .single();
    const oldPath = current && current.cover_image_path;

    if (!oldPath) {
      return res.json({
        success: true,
        message: '本筆行程目前沒有封面。',
        data: { id: eventId, cover_image_path: null, cover_url: null },
      });
    }

    const { error: removeError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET_EVENT_COVERS)
      .remove([oldPath]);
    if (removeError) {
      console.error('Remove event cover failed:', removeError);
    }

    const { error: updateError } = await supabaseAdmin
      .from('campaign_events')
      .update({ cover_image_path: null })
      .eq('id', eventId);

    if (updateError) {
      console.error('Clear event cover path failed:', updateError);
      return res.status(500).json({
        success: false,
        message: '封面路徑清空失敗，請稍後再試。',
      });
    }

    return res.json({
      success: true,
      message: '封面已刪除。',
      data: { id: eventId, cover_image_path: null, cover_url: null },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event cover delete failed:');
  }
});

// 取得相簿某張上傳 URL（先檢查 ≤ 6 張）
app.post('/api/admin/events/:id/album-upload-url', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: exist } = await supabaseAdmin
      .from('campaign_events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle();
    if (!exist) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程。',
      });
    }

    const { count, error: countError } = await supabaseAdmin
      .from('campaign_event_photos')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);

    if (countError) {
      console.error('Event album count failed:', countError);
      return res.status(500).json({
        success: false,
        message: '相簿數量檢查失敗，請稍後再試。',
      });
    }

    if (Number(count) >= EVENT_ALBUM_MAX_PHOTOS) {
      return res.status(400).json({
        success: false,
        message: `相簿最多 ${EVENT_ALBUM_MAX_PHOTOS} 張，請先刪除舊照再上傳。`,
      });
    }

    const fileUuid = generateUuidSafe();
    const storagePath = buildEventAlbumStoragePath(eventId, fileUuid);
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET_EVENT_COVERS)
      .createSignedUploadUrl(storagePath);

    if (error || !data) {
      console.error('Event album signed upload URL failed:', error);
      return res.status(500).json({
        success: false,
        message: '相簿上傳金鑰產生失敗，請稍後再試。',
      });
    }

    return res.json({
      success: true,
      message: '相簿上傳金鑰已核發，請在 10 分鐘內完成上傳。',
      data: {
        storage_path: storagePath,
        upload_url: data.signedUrl || data.url,
        upload_token: data.token || null,
        expires_in_seconds: SIGNED_UPLOAD_URL_EXPIRES_IN,
        expected_content_type: 'image/webp',
      },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event album upload-url failed:');
  }
});

// 回寫一張相簿照片
app.post('/api/admin/events/:id/album', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
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

    const expectedPrefix = `albums/${eventId}/`;
    if (!storagePath.startsWith(expectedPrefix) || !storagePath.endsWith('.webp')) {
      return res.status(400).json({
        success: false,
        message: 'storage_path 格式不正確。',
      });
    }

    // 再次檢查 ≤ 6 張（避免上傳 URL 核發後又被新增）
    const { count } = await supabaseAdmin
      .from('campaign_event_photos')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);

    if (Number(count) >= EVENT_ALBUM_MAX_PHOTOS) {
      // 刪除已上傳但無法寫入的檔案
      await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .remove([storagePath]);
      return res.status(400).json({
        success: false,
        message: `相簿最多 ${EVENT_ALBUM_MAX_PHOTOS} 張，已超過上限。`,
      });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('campaign_event_photos')
      .insert([
        {
          event_id: eventId,
          storage_path: storagePath,
          sort_order: Number(count),
        },
      ])
      .select('id, storage_path, sort_order')
      .single();

    if (insertError || !inserted) {
      console.error('admin event album insert failed:', insertError);
      return res.status(500).json({
        success: false,
        message: '相簿照片建立失敗，請稍後再試。',
      });
    }

    let signedUrl = null;
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .createSignedUrl(inserted.storage_path, SIGNED_READ_URL_EXPIRES_IN);
      if (!error && data) {
        signedUrl = data.signedUrl;
      }
    } catch (err) {
      console.error('admin event album signed URL error:', err.message);
    }

    return res.status(201).json({
      success: true,
      message: '相簿照片已新增。',
      data: {
        id: inserted.id,
        storage_path: inserted.storage_path,
        sort_order: inserted.sort_order,
        signed_url: signedUrl,
      },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event album insert failed:');
  }
});

// 刪除單張相簿照片
app.delete('/api/admin/events/:id/album/:photoId', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    const photoId = Number.parseInt(req.params.photoId, 10);
    if (!Number.isInteger(eventId) || eventId <= 0 || !Number.isInteger(photoId) || photoId <= 0) {
      return res.status(400).json({
        success: false,
        message: '編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    const { data: photo } = await supabaseAdmin
      .from('campaign_event_photos')
      .select('id, event_id, storage_path')
      .eq('id', photoId)
      .eq('event_id', eventId)
      .maybeSingle();

    if (!photo) {
      return res.status(404).json({
        success: false,
        message: '找不到這張相簿照片。',
      });
    }

    const { error: deleteError } = await supabaseAdmin
      .from('campaign_event_photos')
      .delete()
      .eq('id', photoId)
      .eq('event_id', eventId);

    if (deleteError) {
      console.error('admin event album delete failed:', deleteError);
      return res.status(500).json({
        success: false,
        message: '相簿照片刪除失敗，請稍後再試。',
      });
    }

    if (photo.storage_path) {
      const { error: removeError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .remove([photo.storage_path]);
      if (removeError) {
        console.error('Remove event album file failed:', removeError);
      }
    }

    return res.json({
      success: true,
      message: '相簿照片已刪除。',
      data: { id: photoId, event_id: eventId },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event album delete failed:');
  }
});

// 通知已報名者
app.post('/api/admin/events/:id/notify-rsvp', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    if (!lineClient) {
      return res.status(500).json({
        success: false,
        message: '尚未設定 LINE Messaging API 權杖（LINE_CHANNEL_ACCESS_TOKEN），無法發送通知。',
      });
    }

    const { data: eventRow } = await supabaseAdmin
      .from('campaign_events')
      .select('id, title, start_at, location, is_published')
      .eq('id', eventId)
      .maybeSingle();

    if (!eventRow) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程。',
      });
    }

    const { data: rsvpRows, error: rsvpError } = await supabaseAdmin
      .from('event_rsvps')
      .select('line_user_id')
      .eq('event_id', eventId);

    if (rsvpError) {
      console.error('notify-rsvp fetch failed:', rsvpError);
      return res.status(500).json({
        success: false,
        message: '報名名單讀取失敗，請稍後再試。',
      });
    }

    const recipients = (rsvpRows || [])
      .map((r) => r.line_user_id)
      .filter(Boolean);

    const attempted = recipients.length;
    if (attempted === 0) {
      return res.json({
        success: true,
        message: '目前沒有已報名者，無需通知。',
        data: { attempted: 0, succeeded: 0, failed: 0 },
      });
    }

    const messageText = buildEventRsvpNotifyText(eventRow);
    let succeeded = 0;
    let failed = 0;

    // 逐一發送（pushMessage 支援多人，但逐一以便精確計數成功/失敗）
    for (const userId of recipients) {
      try {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: messageText }],
        });
        succeeded += 1;
      } catch (err) {
        console.error('pushMessage failed for', userId, err.message);
        failed += 1;
      }
    }

    return res.json({
      success: true,
      message: `通知已發送：嘗試 ${attempted} 人，成功 ${succeeded} 人，失敗 ${failed} 人。`,
      data: { attempted, succeeded, failed },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event notify-rsvp failed:');
  }
});

// 通知曾使用許願池的里民（user_feedback distinct line_user_id）
app.post('/api/admin/events/:id/notify-wish-pool', async (req, res) => {
  try {
    await requireAdmin(req);

    const eventId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({
        success: false,
        message: '行程編號不正確。',
      });
    }

    if (!supabaseAdmin) {
      return res.status(500).json({
        success: false,
        message: 'Supabase Service Role 尚未設定。',
      });
    }

    if (!lineClient) {
      return res.status(500).json({
        success: false,
        message: '尚未設定 LINE Messaging API 權杖（LINE_CHANNEL_ACCESS_TOKEN），無法發送通知。',
      });
    }

    const { data: eventRow } = await supabaseAdmin
      .from('campaign_events')
      .select('id, title, start_at, location, is_published')
      .eq('id', eventId)
      .maybeSingle();

    if (!eventRow) {
      return res.status(404).json({
        success: false,
        message: '找不到這筆行程。',
      });
    }

    const { data: feedbackRows, error: feedbackError } = await supabaseAdmin
      .from('user_feedback')
      .select('line_user_id')
      .not('line_user_id', 'is', null);

    if (feedbackError) {
      console.error('notify-wish-pool fetch failed:', feedbackError);
      return res.status(500).json({
        success: false,
        message: '反映里民名單讀取失敗，請稍後再試。',
      });
    }

    const distinctSet = new Set();
    for (const row of (feedbackRows || [])) {
      if (row.line_user_id) distinctSet.add(row.line_user_id);
    }
    const recipients = Array.from(distinctSet);

    const attempted = recipients.length;
    if (attempted === 0) {
      return res.json({
        success: true,
        message: '目前沒有曾反映過的里民，無需通知。',
        data: { attempted: 0, succeeded: 0, failed: 0 },
      });
    }

    if (attempted > EVENT_NOTIFY_RECIPIENT_HARD_LIMIT) {
      return res.status(400).json({
        success: false,
        message: `通知對象共 ${attempted} 人，超過第一版上限 ${EVENT_NOTIFY_RECIPIENT_HARD_LIMIT} 人，暫不發送。`,
      });
    }

    const messageText = buildEventNewEventNotifyText(eventRow);
    let succeeded = 0;
    let failed = 0;

    for (const userId of recipients) {
      try {
        await lineClient.pushMessage({
          to: userId,
          messages: [{ type: 'text', text: messageText }],
        });
        succeeded += 1;
      } catch (err) {
        console.error('pushMessage failed for', userId, err.message);
        failed += 1;
      }
    }

    return res.json({
      success: true,
      message: `通知已發送：嘗試 ${attempted} 人，成功 ${succeeded} 人，失敗 ${failed} 人。`,
      data: { attempted, succeeded, failed },
    });
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin event notify-wish-pool failed:');
  }
});

// ============================================================================
// 報平安（safety）：管理端 API（requireAdmin 雙重檢查）
//   - 名單只列活躍會員（left_at IS NULL）；退出者不出現、不計未簽
//   - derived 欄位後端計算：checked_in_today / today_checkin_at / last_checkin_date
//     / last_checkin_at / missing_days / needs_care
//   - missing_days = 今天(台灣) - max(最後簽到日, baseline_date)；今天已簽 = 0
//   - 待關懷（needs_care）= 活躍且今日未簽且 missing_days >= SAFETY_CARE_MISSING_DAYS(3)
//   - 第一期通知：僅後台亮「待關懷」，不自動對外宣布、不自動群發
// ============================================================================

const SAFETY_ADMIN_FILTERS = new Set(['all', 'checked', 'unchecked', 'care', 'pending']);

// 與會員 + 簽到紀錄計算 derived 欄位
// 第四期：approval_status 進入回傳；needs_care 僅對 approved 有效
// （pending 不算待關懷/今日未簽；rejected 不會進名單但此函式仍可安全呼叫）
function buildSafetyAdminItem(memberRow, checkinRows, latestCare) {
  const today = getTaipeiToday();
  const approvalStatus = memberRow.approval_status || 'approved';
  const todayCheckin = checkinRows.find((c) => c.checkin_date === today) || null;
  let lastCheckin = null;
  for (const c of checkinRows) {
    if (!lastCheckin || c.checkin_date > lastCheckin.checkin_date) {
      lastCheckin = c;
    }
  }

  let missingDays = 0;
  if (!todayCheckin) {
    // baseline_date 之後沒簽（或重新加入前的舊簽到不算）→ 從 max(最後簽到日, baseline_date) 起算
    const fromDate =
      lastCheckin && lastCheckin.checkin_date > memberRow.baseline_date
        ? lastCheckin.checkin_date
        : memberRow.baseline_date;
    missingDays = Math.max(0, dateDaysDiff(fromDate, today));
  }

  // 暫不提醒幹部：到期日當天（snooze_until >= today）仍暫停，隔天自動恢復
  // 暫停只影響 needs_care（待關懷篩選 + 早上幹部推播）；missing_days 與晚間催本人照常
  const snoozeUntil = memberRow.admin_notify_snooze_until || null;
  const snoozeActive = Boolean(snoozeUntil) && snoozeUntil >= today;

  return {
    id: memberRow.id,
    display_name: memberRow.display_name || '',
    phone: memberRow.phone || '',
    contact_name: memberRow.contact_name || '',
    contact_phone: memberRow.contact_phone || '',
    joined_at: memberRow.joined_at,
    baseline_date: memberRow.baseline_date,
    approval_status: approvalStatus,
    birth_year: memberRow.birth_year || null,
    applied_at: memberRow.applied_at || null,
    reviewed_at: memberRow.reviewed_at || null,
    reviewed_by: memberRow.reviewed_by || null,
    reject_reason: memberRow.reject_reason || null,
    today,
    checked_in_today: Boolean(todayCheckin),
    today_checkin_at: todayCheckin ? todayCheckin.created_at : null,
    last_checkin_date: lastCheckin ? lastCheckin.checkin_date : null,
    last_checkin_at: lastCheckin ? lastCheckin.created_at : null,
    missing_days: missingDays,
    needs_care:
      approvalStatus === 'approved' && !todayCheckin && missingDays >= SAFETY_CARE_MISSING_DAYS && !snoozeActive,
    admin_notify_snoozed: snoozeActive,
    admin_notify_snooze_until: snoozeUntil,
    latest_care: latestCare
      ? {
          method: latestCare.method,
          note: latestCare.note || '',
          created_by: latestCare.created_by,
          created_at: latestCare.created_at,
        }
      : null,
  };
}

// GET /api/admin/safety：報平安名單 + 五組篩選計數（第四期：+ pending 待審核）
// 名單 = 活躍（left_at IS NULL）且 approval_status IN (approved, pending)
// rejected 不顯示（里民再申請時會以 pending 回到名單）
// 注意：村里規模（數十人）下直接撈全部簽到/關懷紀錄後在 Node 端彙總；
// 名單成長到上千人時可改 PostgREST aggregate 或 RPC 優化
app.get('/api/admin/safety', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety list auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const filterParam = String(req.query.filter || 'all').trim();
  const filter = SAFETY_ADMIN_FILTERS.has(filterParam) ? filterParam : 'all';

  try {
    const [{ data: members, error: membersError }] = await Promise.all([
      supabaseAdmin
        .from('safety_members')
        .select(
          'id, line_user_id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, approval_status, applied_at, reviewed_at, reviewed_by, birth_year, reject_reason'
        )
        .is('left_at', null)
        .neq('approval_status', 'rejected')
        .order('display_name', { ascending: true }),
    ]);
    if (membersError) throw membersError;

    const memberIds = (members || []).map((m) => m.id);
    let checkins = [];
    let careLogs = [];
    if (memberIds.length > 0) {
      const [checkinsRes, careRes] = await Promise.all([
        supabaseAdmin
          .from('safety_checkins')
          .select('member_id, checkin_date, created_at')
          .in('member_id', memberIds),
        supabaseAdmin
          .from('safety_care_logs')
          .select('id, member_id, method, note, created_by, created_at')
          .in('member_id', memberIds)
          .order('created_at', { ascending: false }),
      ]);
      if (checkinsRes.error) throw checkinsRes.error;
      if (careRes.error) throw careRes.error;
      checkins = checkinsRes.data || [];
      careLogs = careRes.data || [];
    }

    // 彙總：每人簽到列表 + 最新一筆關懷
    const checkinsByMember = new Map();
    for (const c of checkins) {
      if (!checkinsByMember.has(c.member_id)) checkinsByMember.set(c.member_id, []);
      checkinsByMember.get(c.member_id).push(c);
    }
    const latestCareByMember = new Map();
    for (const log of careLogs) {
      if (!latestCareByMember.has(log.member_id)) latestCareByMember.set(log.member_id, log);
    }

    const items = (members || []).map((m) =>
      buildSafetyAdminItem(m, checkinsByMember.get(m.id) || [], latestCareByMember.get(m.id) || null)
    );

    // 排序：待審核最上（新申請在前）→ 待關懷（未簽天數多者在前）→ 其餘未簽 → 已簽
    items.sort((a, b) => {
      const aPending = a.approval_status === 'pending';
      const bPending = b.approval_status === 'pending';
      if (aPending !== bPending) return aPending ? -1 : 1;
      if (aPending && bPending) {
        return String(b.applied_at || '').localeCompare(String(a.applied_at || ''));
      }
      if (a.needs_care !== b.needs_care) return a.needs_care ? -1 : 1;
      if (a.checked_in_today !== b.checked_in_today) return a.checked_in_today ? 1 : -1;
      if (a.missing_days !== b.missing_days) return b.missing_days - a.missing_days;
      return a.display_name.localeCompare(b.display_name, 'zh-TW');
    });

    // 計數：全部 = approved + pending；checked/unchecked/care 僅 approved；pending = 待審核數
    const approvedItems = items.filter((i) => i.approval_status === 'approved');
    const pendingItems = items.filter((i) => i.approval_status === 'pending');
    const counts = {
      all: items.length,
      checked: approvedItems.filter((i) => i.checked_in_today).length,
      unchecked: approvedItems.filter((i) => !i.checked_in_today).length,
      care: approvedItems.filter((i) => i.needs_care).length,
      pending: pendingItems.length,
    };

    const filteredItems =
      filter === 'checked'
        ? approvedItems.filter((i) => i.checked_in_today)
        : filter === 'unchecked'
          ? approvedItems.filter((i) => !i.checked_in_today)
          : filter === 'care'
            ? approvedItems.filter((i) => i.needs_care)
            : filter === 'pending'
              ? pendingItems
              : items;

    return res.json({
      success: true,
      data: {
        items: filteredItems,
        counts,
        filter,
        today: getTaipeiToday(),
      },
    });
  } catch (error) {
    console.error('admin/safety list failed:', error);
    return res.status(500).json({ success: false, message: '報平安名單讀取失敗，請稍後再試。' });
  }
});

// GET /api/admin/safety/:id：單筆詳情（含近期簽到與關懷歷史）
app.get('/api/admin/safety/:id', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety detail auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const memberId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ success: false, message: '名單編號不正確。' });
  }

  try {
    const { data: memberRow, error: memberError } = await supabaseAdmin
      .from('safety_members')
      .select(
        'id, line_user_id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, admin_notify_snooze_until, approval_status, applied_at, reviewed_at, reviewed_by, birth_year, reject_reason'
      )
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) {
      return res.status(404).json({ success: false, message: '找不到這位里民。' });
    }

    const [checkinsRes, careRes] = await Promise.all([
      supabaseAdmin
        .from('safety_checkins')
        .select('id, checkin_date, created_at')
        .eq('member_id', memberId)
        .order('checkin_date', { ascending: false })
        .limit(30),
      supabaseAdmin
        .from('safety_care_logs')
        .select('id, method, note, created_by, created_at')
        .eq('member_id', memberId)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);
    if (checkinsRes.error) throw checkinsRes.error;
    if (careRes.error) throw careRes.error;

    const checkinRows = checkinsRes.data || [];
    const careRows = careRes.data || [];

    // 活躍者用完整 derived；已退出者仍可看資料（標示 left 狀態）
    const isActive = !memberRow.left_at;
    const summary = isActive
      ? buildSafetyAdminItem(memberRow, checkinRows, careRows[0] || null)
      : {
          ...buildSafetyAdminItem({ ...memberRow, baseline_date: memberRow.baseline_date }, [], null),
          checked_in_today: false,
          needs_care: false,
        };

    return res.json({
      success: true,
      data: {
        ...summary,
        is_active: isActive,
        left_at: memberRow.left_at || null,
        checkins: checkinRows,
        care_logs: careRows,
      },
    });
  } catch (error) {
    console.error('admin/safety detail failed:', error);
    return res.status(500).json({ success: false, message: '報平安詳情讀取失敗，請稍後再試。' });
  }
});

// POST /api/admin/safety/:id/care：標記關懷（已電訪 / 已家訪 + 一句備註）
app.post('/api/admin/safety/:id/care', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety care auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const memberId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ success: false, message: '名單編號不正確。' });
  }

  const method = String((req.body && req.body.method) || '').trim();
  if (method !== '已電訪' && method !== '已家訪') {
    return res.status(400).json({ success: false, message: '關懷方式需為「已電訪」或「已家訪」。' });
  }
  const note = String((req.body && req.body.note) || '').trim().slice(0, SAFETY_NOTE_MAX_LENGTH);

  try {
    const { data: memberRow, error: memberError } = await supabaseAdmin
      .from('safety_members')
      .select('id, left_at, approval_status')
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) {
      return res.status(404).json({ success: false, message: '找不到這位里民。' });
    }
    if (memberRow.left_at) {
      return res.status(400).json({ success: false, message: '這位里民已退出報平安，無需關懷。' });
    }
    if (memberRow.approval_status !== 'approved') {
      return res.status(400).json({ success: false, message: '申請尚未核准，無法標記關懷。' });
    }

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('safety_care_logs')
      .insert([{ member_id: memberId, method, note: note || null, created_by: identity.lineUserId }])
      .select('id, member_id, method, note, created_by, created_at')
      .single();
    if (insertError) throw insertError;

    return res.status(201).json({
      success: true,
      message: `已記錄：${method}。`,
      data: { care: inserted },
    });
  } catch (error) {
    console.error('admin/safety care failed:', error);
    return res.status(500).json({ success: false, message: '關懷紀錄儲存失敗，請稍後再試。' });
  }
});

// POST /api/admin/safety/:id/snooze：暫不提醒幹部 3 天
// - 天數後端寫死 3 天（當天+3），不收前端任何參數；要再停必須到期後再按一次
// - 只關閉待關懷篩選與早上幹部推播；本人晚間催簽照常、missing_days 照算
// - 標記已電訪/已家訪不會自動暫停（兩個獨立操作）
// - 關懷歷史寫一筆 method='暫停幹部通知'；無取消暫停功能，到期自動恢復
app.post('/api/admin/safety/:id/snooze', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety snooze auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const memberId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ success: false, message: '名單編號不正確。' });
  }

  try {
    const { data: memberRow, error: memberError } = await supabaseAdmin
      .from('safety_members')
      .select('id, left_at, approval_status')
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) {
      return res.status(404).json({ success: false, message: '找不到這位里民。' });
    }
    if (memberRow.left_at) {
      return res.status(400).json({ success: false, message: '這位里民已退出報平安，無需暫停。' });
    }
    if (memberRow.approval_status !== 'approved') {
      return res.status(400).json({ success: false, message: '申請尚未核准，暫停幹部通知僅對已核准會員有意義。' });
    }

    const today = getTaipeiToday();
    const until = addDaysToTaipeiDate(today, SAFETY_SNOOZE_DAYS);
    if (!until || until <= today) {
      return res.status(500).json({ success: false, message: '暫停日期計算失敗，請稍後再試。' });
    }

    // 先更新到期日（主要效果），再寫關懷紀錄（稽核軌跡）
    const { error: updateError } = await supabaseAdmin
      .from('safety_members')
      .update({ admin_notify_snooze_until: until })
      .eq('id', memberId)
      .is('left_at', null);
    if (updateError) throw updateError;

    const untilDisplay = until.split('-').join('/');
    const { data: careLog, error: careError } = await supabaseAdmin
      .from('safety_care_logs')
      .insert([
        {
          member_id: memberId,
          method: '暫停幹部通知',
          note: `至 ${untilDisplay}（${SAFETY_SNOOZE_DAYS} 天）`,
          created_by: identity.lineUserId,
        },
      ])
      .select('id, member_id, method, note, created_by, created_at')
      .single();
    if (careError) {
      // 暫停已儲存但紀錄寫入失敗：回明確錯誤，管理員重按一次會補上紀錄，不留假紀錄
      console.error('admin/safety snooze care log failed:', careError);
      return res.status(500).json({
        success: false,
        message: `暫停已儲存（至 ${untilDisplay}），但關懷紀錄寫入失敗，請再按一次以補上紀錄。`,
        data: { snooze_until: until },
      });
    }

    return res.status(201).json({
      success: true,
      message: `已暫停幹部通知 ${SAFETY_SNOOZE_DAYS} 天（至 ${untilDisplay}）。`,
      data: { snooze_until: until, care: careLog },
    });
  } catch (error) {
    console.error('admin/safety snooze failed:', error);
    return res.status(500).json({ success: false, message: '暫停幹部通知失敗，請稍後再試。' });
  }
});

// POST /api/admin/safety/:id/approve：核准加入申請（第四期）
// - 適用 pending 與 rejected（幹部反悔可直接核准）；已 approved 冪等回 200
// - 核准動作：approval_status='approved'、寫入 reviewed_at / reviewed_by、
//   清 reject_reason、baseline_date 重設為核准當天（台灣日期，避免一核准就待關懷）、
//   清 admin_notify_snooze_until（重申請前殘留的暫停無意義）
// - 不寫 safety_care_logs（審核軌跡 = reviewed_* 欄位；關懷紀錄是另一件事）
app.post('/api/admin/safety/:id/approve', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety approve auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const memberId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ success: false, message: '名單編號不正確。' });
  }

  try {
    const { data: memberRow, error: memberError } = await supabaseAdmin
      .from('safety_members')
      .select('id, left_at, approval_status, display_name')
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) {
      return res.status(404).json({ success: false, message: '找不到這位里民。' });
    }
    if (memberRow.left_at) {
      return res.status(400).json({ success: false, message: '這位里民已退出報平安。' });
    }
    if (memberRow.approval_status === 'approved') {
      return res.json({ success: true, message: '此申請已核准，無需重複操作。', data: { approval_status: 'approved' } });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('safety_members')
      .update({
        approval_status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: identity.lineUserId,
        reject_reason: null,
        baseline_date: getTaipeiToday(),
        admin_notify_snooze_until: null,
      })
      .eq('id', memberId)
      .select('id, approval_status, reviewed_at, reviewed_by, baseline_date')
      .single();
    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: '已核准加入，對方現在可以開始天天報平安。',
      data: { approval: updated },
    });
  } catch (error) {
    console.error('admin/safety approve failed:', error);
    return res.status(500).json({ success: false, message: '核准失敗，請稍後再試。' });
  }
});

// POST /api/admin/safety/:id/reject：不通過申請（第四期）
// - 僅 pending 可不通過（approved 要移除請走里民自行退出；第一期無此按鈕）
// - reason 選填 ≤ 200 字；rejected 可再改 reason（維持 rejected）
app.post('/api/admin/safety/:id/reject', async (req, res) => {
  let identity;
  try {
    identity = await requireAdmin(req);
  } catch (error) {
    return handleAuthOrServerError(res, error, 'admin/safety reject auth failed');
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }

  const memberId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(memberId) || memberId <= 0) {
    return res.status(400).json({ success: false, message: '名單編號不正確。' });
  }

  const reason = String((req.body && req.body.reason) || '').trim().slice(0, SAFETY_REJECT_REASON_MAX_LENGTH);

  try {
    const { data: memberRow, error: memberError } = await supabaseAdmin
      .from('safety_members')
      .select('id, left_at, approval_status')
      .eq('id', memberId)
      .maybeSingle();
    if (memberError) throw memberError;
    if (!memberRow) {
      return res.status(404).json({ success: false, message: '找不到這位里民。' });
    }
    if (memberRow.left_at) {
      return res.status(400).json({ success: false, message: '這位里民已退出報平安。' });
    }
    if (memberRow.approval_status === 'approved') {
      return res.status(400).json({ success: false, message: '已核准的會員不可改為不通過。' });
    }

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('safety_members')
      .update({
        approval_status: 'rejected',
        reject_reason: reason || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: identity.lineUserId,
      })
      .eq('id', memberId)
      .select('id, approval_status, reject_reason, reviewed_at, reviewed_by')
      .single();
    if (updateError) throw updateError;

    return res.json({
      success: true,
      message: '已標記為不通過，對方可修改資料後重新申請。',
      data: { approval: updated },
    });
  } catch (error) {
    console.error('admin/safety reject failed:', error);
    return res.status(500).json({ success: false, message: '操作失敗，請稍後再試。' });
  }
});

// ============================================================================
// 報平安第二期：排程通知（Vercel Cron）
// - GET  /api/cron/safety-reminders/:type（Vercel Cron 用；Cron 不保留 query string，故用路徑區分）
// - GET|POST /api/cron/safety-reminders（?type= 或 body { type }，本機手動測試用，保留）
// - 驗證：Authorization: Bearer <CRON_SECRET>；未設 CRON_SECRET 回 503、不符回 401
// - 冪等：safety_notification_logs UNIQUE(notify_type, line_user_id, notify_date)
// - 成功才寫 log；單人 push 失敗不阻塞其他人
// - 家人（contact_phone）不做任何通知
// ============================================================================

const SAFETY_CRON_TYPES = new Set(['resident', 'admin']);
const SAFETY_NOTIFY_RESIDENT = 'resident_same_day';
const SAFETY_NOTIFY_ADMIN = 'admin_care';
const SAFETY_ADMIN_CARE_NAME_PREVIEW = 3;

function buildSafetyLiffTabUrl(tab) {
  if (LIFF_ID) return `https://liff.line.me/${LIFF_ID}?tab=${tab}`;
  return `${LIFF_FORM_URL}?tab=${tab}`;
}

// 文案固定，語氣溫和，不含「出事／意外」等字眼
function buildSafetyResidentReminderText() {
  return ['今天還沒報平安，點這裡補按即可。', buildSafetyLiffTabUrl('safety')].join('\n');
}

function buildSafetyAdminCareText(careItems) {
  const count = careItems.length;
  const nameList = careItems
    .slice(0, SAFETY_ADMIN_CARE_NAME_PREVIEW)
    .map((item) => item.display_name || '里民')
    .join('、');
  const namesPart = count > SAFETY_ADMIN_CARE_NAME_PREVIEW ? `（${nameList}等）` : `（${nameList}）`;
  return [
    `報平安：目前有 ${count} 位待關懷${namesPart}，請至後台查看。`,
    buildSafetyLiffTabUrl('admin'),
  ].join('\n');
}

// 撈今天某類型已發過通知的收件人（冪等排除用）
async function fetchTodaySafetyNotifiedIds(notifyType, today) {
  const { data, error } = await supabaseAdmin
    .from('safety_notification_logs')
    .select('line_user_id')
    .eq('notify_type', notifyType)
    .eq('notify_date', today);
  if (error) throw error;
  return new Set((data || []).map((row) => row.line_user_id));
}

// 成功才寫 log；UNIQUE 擋重複，ignoreDuplicates 防 cron 重跑撞鍵
async function recordSafetyNotificationLog(lineUserId, notifyType, today) {
  const { error } = await supabaseAdmin
    .from('safety_notification_logs')
    .upsert(
      [{ line_user_id: lineUserId, notify_type: notifyType, notify_date: today }],
      { onConflict: 'notify_type,line_user_id,notify_date', ignoreDuplicates: true }
    );
  if (error) throw error;
}

function checkSafetyCronAuth(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) {
    return { ok: false, status: 503, message: '環境變數 CRON_SECRET 尚未設定，排程通知已停用。' };
  }
  const authHeader = req.headers && req.headers.authorization;
  if (authHeader !== `Bearer ${secret}`) {
    return { ok: false, status: 401, message: '排程通知驗證失敗。' };
  }
  return { ok: true };
}

// type=resident：催本人（活躍且今日未簽，含今天剛加入尚未簽到者）
// 第四期：僅已核准會員（pending / rejected 不催）
async function runSafetyResidentReminders(today) {
  const { data: members, error: membersError } = await supabaseAdmin
    .from('safety_members')
    .select('id, line_user_id')
    .is('left_at', null)
    .eq('approval_status', 'approved');
  if (membersError) throw membersError;

  const activeMembers = members || [];
  if (activeMembers.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const { data: todayCheckins, error: checkinsError } = await supabaseAdmin
    .from('safety_checkins')
    .select('member_id')
    .in('member_id', activeMembers.map((m) => m.id))
    .eq('checkin_date', today);
  if (checkinsError) throw checkinsError;

  const checkedMemberIds = new Set((todayCheckins || []).map((c) => c.member_id));
  const uncheckedMembers = activeMembers.filter((m) => !checkedMemberIds.has(m.id));

  const alreadyNotified = await fetchTodaySafetyNotifiedIds(SAFETY_NOTIFY_RESIDENT, today);
  const targets = uncheckedMembers.filter((m) => m.line_user_id && !alreadyNotified.has(m.line_user_id));
  const skipped = uncheckedMembers.length - targets.length;

  const messageText = buildSafetyResidentReminderText();
  let succeeded = 0;
  let failed = 0;
  for (const member of targets) {
    try {
      await lineClient.pushMessage({
        to: member.line_user_id,
        messages: [{ type: 'text', text: messageText }],
      });
      await recordSafetyNotificationLog(member.line_user_id, SAFETY_NOTIFY_RESIDENT, today);
      succeeded += 1;
    } catch (err) {
      // 失敗不阻塞其他人、不寫 log（當天不重試，下次 cron 是隔天）
      console.error('safety resident reminder pushMessage failed for', member.line_user_id, err.message);
      failed += 1;
    }
  }

  return { attempted: targets.length, succeeded, failed, skipped };
}

// type=admin：通知幹部（待關懷名單，計算沿用既有 buildSafetyAdminItem，不重寫）
// 第四期：僅撈已核准會員（needs_care 對 pending 恆 false，撈取直接排除更省）
async function runSafetyAdminCareNotifications(today) {
  const { data: members, error: membersError } = await supabaseAdmin
    .from('safety_members')
    .select(
      'id, line_user_id, display_name, phone, contact_name, contact_phone, joined_at, baseline_date, left_at, admin_notify_snooze_until, approval_status'
    )
    .is('left_at', null)
    .eq('approval_status', 'approved');
  if (membersError) throw membersError;

  const activeMembers = members || [];
  const checkinsByMember = new Map();
  if (activeMembers.length > 0) {
    const { data: checkins, error: checkinsError } = await supabaseAdmin
      .from('safety_checkins')
      .select('member_id, checkin_date, created_at')
      .in('member_id', activeMembers.map((m) => m.id));
    if (checkinsError) throw checkinsError;
    for (const checkin of checkins || []) {
      if (!checkinsByMember.has(checkin.member_id)) checkinsByMember.set(checkin.member_id, []);
      checkinsByMember.get(checkin.member_id).push(checkin);
    }
  }

  const careItems = activeMembers
    .map((m) => buildSafetyAdminItem(m, checkinsByMember.get(m.id) || [], null))
    .filter((item) => item.needs_care);

  // 當天沒有待關懷 → 不發任何訊息
  if (careItems.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0, skipped: 0, care_count: 0 };
  }

  const adminIds = [...adminLineUserIds];
  const alreadyNotified = await fetchTodaySafetyNotifiedIds(SAFETY_NOTIFY_ADMIN, today);
  const targets = adminIds.filter((id) => !alreadyNotified.has(id));
  const skipped = adminIds.length - targets.length;

  const messageText = buildSafetyAdminCareText(careItems);
  let succeeded = 0;
  let failed = 0;
  for (const adminId of targets) {
    try {
      await lineClient.pushMessage({
        to: adminId,
        messages: [{ type: 'text', text: messageText }],
      });
      await recordSafetyNotificationLog(adminId, SAFETY_NOTIFY_ADMIN, today);
      succeeded += 1;
    } catch (err) {
      console.error('safety admin care pushMessage failed for', adminId, err.message);
      failed += 1;
    }
  }

  return { attempted: targets.length, succeeded, failed, skipped, care_count: careItems.length };
}

// ============================================================================
// 管理員通知第一期：即時 Email（Resend）
// - 三個寫入點（新反映 / 報平安待審核 / 行程新報名）寫入 admin_notifications
//   成功後立刻逐封寄信給 ADMIN_NOTIFY_EMAILS（fire-and-forget，失敗只 log、不擋里民 201）
// - 寄件人 ADMIN_NOTIFY_FROM（未設才 fallback onboarding@resend.dev）；
//   Reply-To ADMIN_NOTIFY_REPLY_TO（選填，有設才帶）
// - 無 RESEND_API_KEY 或 ADMIN_NOTIFY_EMAILS：跳過並 log，不報錯（紅點功能照常）
// - 主旨短、摘要不含完整電話（summary 建立當下就沒放電話）、正文附後台連結
// - 不寄：每日簽到、取消報名、幹部操作（標記關懷／暫停／審核）
// ============================================================================

const ADMIN_NOTIFY_FROM_FALLBACK = 'onboarding@resend.dev';
const ADMIN_NOTIFY_ADMIN_URL = 'https://zhengsha.vercel.app/admin.html';

function getAdminNotifyEmails() {
  return String(process.env.ADMIN_NOTIFY_EMAILS || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

async function sendAdminNotifyEmail(title, summary) {
  const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
  const recipients = getAdminNotifyEmails();

  if (!resendApiKey) {
    console.log('admin notify email skipped: RESEND_API_KEY not set');
    return;
  }
  if (recipients.length === 0) {
    console.log('admin notify email skipped: ADMIN_NOTIFY_EMAILS not set');
    return;
  }

  const brief = String(summary || '').trim().slice(0, 30);
  const subject = brief ? `【幸福正砂】${title}：${brief}` : `【幸福正砂】${title}`;
  const summaryText = String(summary || '').trim() || '（無摘要）';
  const textBody = [`${title}：${summaryText}`, '', `後台連結：${ADMIN_NOTIFY_ADMIN_URL}`].join('\n');

  const fromEmail = String(process.env.ADMIN_NOTIFY_FROM || '').trim() || ADMIN_NOTIFY_FROM_FALLBACK;
  const replyTo = String(process.env.ADMIN_NOTIFY_REPLY_TO || '').trim();
  for (const email of recipients) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: email,
          subject,
          text: textBody,
          ...(replyTo ? { reply_to: replyTo } : {}),
        }),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        console.error(`admin notify email send failed for ${email}:`, response.status, errText);
      }
    } catch (err) {
      console.error(`admin notify email send error for ${email}:`, err.message);
    }
  }
}

async function handleSafetyCronRequest(req, res) {
  const auth = checkSafetyCronAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ success: false, message: auth.message });
  }

  if (!supabaseAdmin) {
    return res.status(500).json({ success: false, message: 'Supabase Service Role 尚未完成設定。' });
  }
  if (!lineClient) {
    return res.status(500).json({ success: false, message: 'LINE Messaging API 尚未完成設定。' });
  }

  const type = String((req.params.type ?? req.query.type ?? (req.body && req.body.type)) ?? '').trim();
  if (!SAFETY_CRON_TYPES.has(type)) {
    return res.status(400).json({ success: false, message: 'type 需為 resident 或 admin。' });
  }

  try {
    const today = getTaipeiToday();
    const result =
      type === 'resident'
        ? await runSafetyResidentReminders(today)
        : await runSafetyAdminCareNotifications(today);

    const message =
      type === 'admin' && result.care_count === 0
        ? '當天沒有待關懷名單，未發送通知。'
        : `已完成：嘗試 ${result.attempted} 人，成功 ${result.succeeded} 人，失敗 ${result.failed} 人，略過（今日已發）${result.skipped} 人。`;

    return res.json({
      success: true,
      message,
      data: { type, today, ...result },
    });
  } catch (error) {
    console.error('safety cron failed:', error);
    return res.status(500).json({ success: false, message: '排程通知執行失敗。' });
  }
}

// 路徑式：Vercel Cron 用（Cron 不保留 query string；:type 非法值由 type 驗證擋下）
app.get('/api/cron/safety-reminders/:type', handleSafetyCronRequest);
// query / body 式：本機手動測試用（保留）
app.get('/api/cron/safety-reminders', handleSafetyCronRequest);
app.post('/api/cron/safety-reminders', handleSafetyCronRequest);

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

// ============================================================================
// 管理員通知第一期：admin_notifications 紅點 + 即時 Email
// - 寫入時機僅三類：feedback_new / safety_pending / event_rsvp
// - 寫入失敗只 log，不得擋里民主流程（呼叫端一律不 await、不拋錯）
// - 寫入成功後立刻寄即時 Email（sendAdminNotifyEmail，同樣 fire-and-forget）
// ============================================================================

// fire-and-forget：包一層避免任何通知失敗影響主流程
function insertAdminNotification(type, title, summary, refTable, refId) {
  if (!supabaseAdmin) return;
  supabaseAdmin
    .from('admin_notifications')
    .insert([{ type, title, summary: summary || null, ref_table: refTable || null, ref_id: refId != null ? String(refId) : null }])
    .then(({ error }) => {
      if (error) {
        console.error('admin notification insert failed:', error);
        return;
      }
      // 即時 Email：通知寫入成功後立刻寄（fire-and-forget，失敗只 log、不擋里民 201）
      sendAdminNotifyEmail(title, summary).catch((err) =>
        console.error('admin notify email error:', err)
      );
    })
    .catch((err) => console.error('admin notification insert error:', err));
}

// 摘要不放完整電話（Email 與後台列表同規）
function buildFeedbackNotificationSummary(displayName, content) {
  const name = (displayName || '里民').slice(0, 20);
  const brief = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return brief ? `${name}：${brief}` : name;
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

// ============================================================================
// 行程 helper：路徑建構、signed URL、payload 正規化、通知文案（後端寫死）
// ============================================================================

function buildEventCoverStoragePath(eventId, fileUuid) {
  const safeId = String(eventId).replace(/[^A-Za-z0-9_-]/g, '');
  const safeFile = String(fileUuid).replace(/[^A-Za-z0-9_-]/g, '');
  return `covers/${safeId}/${safeFile}.webp`;
}

function buildEventAlbumStoragePath(eventId, fileUuid) {
  const safeId = String(eventId).replace(/[^A-Za-z0-9_-]/g, '');
  const safeFile = String(fileUuid).replace(/[^A-Za-z0-9_-]/g, '');
  return `albums/${safeId}/${safeFile}.webp`;
}

// 行程封面 signed read URL；無路徑回 null
// 行程列表縮圖 transform：長邊 1080、品質 70（原圖上傳時已壓 maxEdge 1600 WebP；
// 詳情與 lightbox 用原圖，本來就在 1600～1920 帶）
const EVENT_LIST_COVER_TRANSFORM = { width: 1080, quality: 70 };

async function getEventCoverSignedUrl(coverPath, transform = null) {
  if (!coverPath || !supabaseAdmin) return null;
  // 優先 Supabase Storage image transform（縮圖）；專案未開 transform 時自動退回原圖 signed URL
  if (transform) {
    try {
      const { data: thumbData, error: thumbError } = await supabaseAdmin.storage
        .from(STORAGE_BUCKET_EVENT_COVERS)
        .createSignedUrl(coverPath, SIGNED_READ_URL_EXPIRES_IN, { transform });
      if (!thumbError && thumbData) {
        return thumbData.signedUrl || thumbData.url || null;
      }
      console.warn('Event cover transform unavailable, fallback to full-size URL:', thumbError && thumbError.message);
    } catch (err) {
      console.warn('Event cover transform error, fallback to full-size URL:', err.message);
    }
  }
  const { data, error } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET_EVENT_COVERS)
    .createSignedUrl(coverPath, SIGNED_READ_URL_EXPIRES_IN);
  if (error || !data) {
    console.error('Event cover signed URL failed:', error);
    return null;
  }
  return data.signedUrl || data.url || null;
}

// 行程時間解析：datetime-local 的值沒有時區資訊（如 '2026-11-01T11:00'），
// 一律視為台北時間（+08:00）再轉絕對時間；已帶時區（Z 或 +hh:mm）的字串原樣解析。
// 伺服器（Vercel）時區是 UTC，若直接 new Date(naive) 會被當 UTC，存檔即 +8 偏移
function parseEventDateTime(str) {
  const raw = String(str || '').trim();
  if (!raw) return new Date(NaN);
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  return new Date(hasTz ? raw : `${raw}+08:00`);
}

// 新增行程 payload 正規化（title、start_at 為必填）
function normalizeEventPayload(body = {}) {
  const title = String(body.title || '').trim();
  const description = String(body.description || '').trim();
  const content = String(body.content || '').trim();
  const location = String(body.location || '').trim();
  const videoUrl = String(body.video_url || '').trim();
  const startAt = String(body.start_at || '').trim();
  const endAt = String(body.end_at || '').trim();

  if (!title) {
    return { success: false, message: '請填寫行程名稱。' };
  }
  if (!startAt || Number.isNaN(parseEventDateTime(startAt).getTime())) {
    return { success: false, message: '請填寫正確的開始時間。' };
  }
  if (endAt && Number.isNaN(parseEventDateTime(endAt).getTime())) {
    return { success: false, message: '結束時間格式不正確。' };
  }
  if (endAt && parseEventDateTime(endAt) <= parseEventDateTime(startAt)) {
    return { success: false, message: '結束時間必須晚於開始時間。' };
  }
  if (title.length > 100) {
    return { success: false, message: '行程名稱過長，請精簡至 100 字內。' };
  }
  if (description.length > 300) {
    return { success: false, message: '列表摘要過長，請精簡至 300 字內。' };
  }
  if (content.length > 5000) {
    return { success: false, message: '說明內容過長，請精簡至 5000 字內。' };
  }
  if (location.length > 200) {
    return { success: false, message: '地點過長，請精簡至 200 字內。' };
  }
  if (videoUrl.length > 500) {
    return { success: false, message: '影片網址過長。' };
  }

  const data = {
    title,
    start_at: parseEventDateTime(startAt).toISOString(),
  };
  if (description) data.description = description;
  if (content) data.content = content;
  if (location) data.location = location;
  if (videoUrl) data.video_url = videoUrl;
  if (endAt) data.end_at = parseEventDateTime(endAt).toISOString();

  return { success: true, data };
}

// 跨輯行程 payload（選擇性欄位都允許）
// existingStartAt：當 body 只含 end_at 但不含 start_at 時，用來對比驗證的現存 start_at（ISO 字串）
function buildEventUpdatePayload(body = {}, existingStartAt = null) {
  const payload = {};

  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const title = String(body.title || '').trim();
    if (!title) {
      throw Object.assign(new Error('行程名稱不可為空。'), { status: 400 });
    }
    if (title.length > 100) {
      throw Object.assign(new Error('行程名稱過長，請精簡至 100 字內。'), { status: 400 });
    }
    payload.title = title;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'description')) {
    const description = String(body.description || '').trim();
    if (description.length > 300) {
      throw Object.assign(new Error('列表摘要過長，請精簡至 300 字內。'), { status: 400 });
    }
    payload.description = description || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'content')) {
    const content = String(body.content || '').trim();
    if (content.length > 5000) {
      throw Object.assign(new Error('說明內容過長，請精簡至 5000 字內。'), { status: 400 });
    }
    payload.content = content || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'start_at')) {
    const startAt = String(body.start_at || '').trim();
    if (!startAt || Number.isNaN(parseEventDateTime(startAt).getTime())) {
      throw Object.assign(new Error('開始時間格式不正確。'), { status: 400 });
    }
    payload.start_at = parseEventDateTime(startAt).toISOString();
  }

  if (Object.prototype.hasOwnProperty.call(body, 'end_at')) {
    const endAt = String(body.end_at || '').trim();
    if (endAt) {
      if (Number.isNaN(parseEventDateTime(endAt).getTime())) {
        throw Object.assign(new Error('結束時間格式不正確。'), { status: 400 });
      }
      // 取得對比用的 start_at：優先使用本次 payload 的，否則用現存值
      const startAtForCompare = payload.start_at || existingStartAt || null;
      if (startAtForCompare && parseEventDateTime(endAt) <= parseEventDateTime(startAtForCompare)) {
        throw Object.assign(new Error('結束時間必須晚於開始時間。'), { status: 400 });
      }
      payload.end_at = parseEventDateTime(endAt).toISOString();
    } else {
      payload.end_at = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, 'location')) {
    const location = String(body.location || '').trim();
    if (location.length > 200) {
      throw Object.assign(new Error('地點過長，請精簡至 200 字內。'), { status: 400 });
    }
    payload.location = location || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'video_url')) {
    const videoUrl = String(body.video_url || '').trim();
    if (videoUrl.length > 500) {
      throw Object.assign(new Error('影片網址過長。'), { status: 400 });
    }
    payload.video_url = videoUrl || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'is_published')) {
    payload.is_published = Boolean(body.is_published);
  }

  return payload;
}

// 通知文案：提醒已報名者
function buildEventRsvpNotifyText(eventRow) {
  const title = eventRow.title || '行程';
  const startAtStr = formatEventDateTime(eventRow.start_at);
  const location = eventRow.location || '待公佈';
  return [
    `${CANDIDATE_NAME}向您問候：`,
    `您報名的行程「${title}」即將到來！`,
    `時間：${startAtStr}`,
    `地點：${location}`,
    `期待與您相見，請留意當天天候與交通。`,
    `詳情請至 LIFF 行程頁查看：${LIFF_FORM_URL}`,
  ].join('\n');
}

// 通知文案：發送新行程通知（對象：曾使用許願池的里民）
function buildEventNewEventNotifyText(eventRow) {
  const title = eventRow.title || '新行程';
  const startAtStr = formatEventDateTime(eventRow.start_at);
  const location = eventRow.location || '待公佈';
  const description = eventRow.description ? `\n${eventRow.description}` : '';
  return [
    `${CANDIDATE_NAME}向您問候：`,
    `有新行程公告囉！`,
    `${title}${description}`,
    `時間：${startAtStr}`,
    `地點：${location}`,
    `歡迎到 LIFF 行程頁報名參加：${LIFF_FORM_URL}`,
  ].join('\n');
}

// 行程時間顯示格式（YYYY/MM/DD HH:mm，固定台北時區，不隨伺服器時區變動）
// 台灣無日光節約，+8 小時後用 UTC getter 即為台北牆上時間；無時區字串視為台北時間
function formatEventDateTime(isoStr) {
  if (!isoStr) return '待公佈';
  const d = parseEventDateTime(isoStr);
  if (Number.isNaN(d.getTime())) return '待公佈';
  const tpe = new Date(d.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${tpe.getUTCFullYear()}/${pad(tpe.getUTCMonth() + 1)}/${pad(tpe.getUTCDate())} ${pad(tpe.getUTCHours())}:${pad(tpe.getUTCMinutes())}`;
}

function buildExcerpt(text, maxLen = 60) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
}

function buildFeedbackInvitation() {
  return `您好！我是里長參選人${CANDIDATE_NAME}。如果您有任何建議或需要協助的地方，歡迎點擊下方連結填寫「有事找里長」表單，讓我為您服務：${LIFF_FORM_URL}`;
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
    找里長: buildFeedbackInvitation(),
    有事找里長: buildFeedbackInvitation(),
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
