-- 011：官方帳號好友名單（2026-10-10）
-- 記錄 LINE 編號、顯示名稱、電話、加入時間、退出時間、來源。
-- 同一個 LINE 編號只留一筆（line_user_id UNIQUE）。
-- 來源只有兩種：
--   '加入好友'    —— 官方帳號 follow 事件寫入（webhook）
--   '曾使用頁面'  —— 舊資料回補（用過 App 的人，不代表確定加過好友）
-- 冪等設計：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ON CONFLICT DO NOTHING。

BEGIN;

CREATE TABLE IF NOT EXISTS public.line_friends (
  id           bigserial   PRIMARY KEY,
  line_user_id text        NOT NULL UNIQUE, -- LINE verify API 的 sub，不信前端
  display_name text,
  phone        text,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz,                 -- 取消好友只填時間，不刪列
  source       text        NOT NULL DEFAULT '加入好友',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_friends_source_check
    CHECK (source IN ('加入好友', '曾使用頁面'))
);

CREATE INDEX IF NOT EXISTS idx_line_friends_list
  ON public.line_friends (left_at, joined_at DESC);

-- ---------------------------------------------------------------------------
-- 回補舊資料：四張表（瀏覽紀錄 / 有事找里長 / 報平安 / 行程報名）出現過的人
--   joined_at    = 四張表最早出現時間
--   display_name / phone = 報平安未退出（left_at IS NULL）優先，其次最近一筆反映
--   source = '曾使用頁面'（不當成確定的加入好友）
--   重跑安全：ON CONFLICT DO NOTHING（已存在的記錄——含 '加入好友'——不覆蓋）
-- ---------------------------------------------------------------------------
WITH all_seen AS (
  SELECT line_user_id, MIN(created_at) AS first_at
    FROM public.page_views WHERE line_user_id IS NOT NULL GROUP BY line_user_id
  UNION ALL
  SELECT line_user_id, MIN(created_at)
    FROM public.user_feedback WHERE line_user_id IS NOT NULL GROUP BY line_user_id
  UNION ALL
  SELECT line_user_id, MIN(joined_at)
    FROM public.safety_members WHERE line_user_id IS NOT NULL GROUP BY line_user_id
  UNION ALL
  SELECT line_user_id, MIN(created_at)
    FROM public.event_rsvps WHERE line_user_id IS NOT NULL GROUP BY line_user_id
),
first_seen AS (
  SELECT line_user_id, MIN(first_at) AS joined_at
    FROM all_seen GROUP BY line_user_id
)
INSERT INTO public.line_friends (line_user_id, display_name, phone, joined_at, source)
SELECT
  fs.line_user_id,
  COALESCE(sm.display_name, fb.user_name),
  COALESCE(sm.phone, fb.phone),
  fs.joined_at,
  '曾使用頁面'
FROM first_seen fs
LEFT JOIN LATERAL (
  SELECT display_name, phone
    FROM public.safety_members
   WHERE line_user_id = fs.line_user_id AND left_at IS NULL
   ORDER BY joined_at DESC
   LIMIT 1
) sm ON TRUE
LEFT JOIN LATERAL (
  SELECT user_name, phone
    FROM public.user_feedback
   WHERE line_user_id = fs.line_user_id
   ORDER BY created_at DESC
   LIMIT 1
) fb ON TRUE
ON CONFLICT (line_user_id) DO NOTHING;

COMMIT;
