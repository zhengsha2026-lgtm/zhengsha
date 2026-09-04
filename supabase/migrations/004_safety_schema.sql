-- ============================================================================
-- 004_safety_schema.sql
-- 報平安第一期：safety_members / safety_checkins / safety_care_logs
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. 一人一列：safety_members.line_user_id UNIQUE；退出 = left_at 設時間（soft delete）
--      重新加入 = 復用同一列、清空 left_at、重設 baseline_date = 當天（台灣日期）
--   2. 一天只計一次：safety_checkins UNIQUE(member_id, checkin_date)
--      checkin_date 一律由後端以 (now() AT TIME ZONE 'Asia/Taipei')::date 計算，不信前端
--   3. 簽到冪等：已簽再按回 200 + already_checked_in: true，不報錯不重複計次
--   4. 未簽天數後端即時計算，不存欄位：
--      missing_days = 今天(台灣) - COALESCE(最後簽到日, baseline_date)
--      今天已簽 = 0
--   5. 待關懷 = 活躍（left_at IS NULL）且今日未簽且 missing_days >= 2
--   6. 退出者不出現在管理名單、不計未簽（查詢一律 WHERE left_at IS NULL）
--   7. 系統不自動對外宣布出事、不自動群發；第一期通知 = 後台亮「待關懷」
--
-- 存取控制慣例（與 001_wish / 002_platform / 003_events 一致）：
--   - 表級不啟用 RLS，所有讀寫經後端 Service Role + API 把關
--   - 前端不直接連這三張表
--   - 本模組不需要 Storage bucket
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- safety_members：報平安名單（一人一筆，退出 = soft delete）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.safety_members (
  id            bigint generated always as identity primary key,
  line_user_id  text        not null,           -- 後端 verify 後的 LINE sub，不信前端
  display_name  text        not null,           -- 稱呼（必填）
  phone         text,                           -- 里民本人電話（選填）
  contact_name  text,                           -- 指定聯絡人姓名（選填）
  contact_phone text,                           -- 指定聯絡人電話（選填）
  joined_at     timestamptz not null default now(),
  baseline_date date        not null,           -- 未簽天數計算基準（加入/重新加入當天，台灣日期）
  left_at       timestamptz,                    -- null = 活躍；非 null = 已退出
  constraint safety_members_line_user_id_unique unique (line_user_id)
);

-- 管理端名單查詢：活躍名單
CREATE INDEX IF NOT EXISTS idx_safety_members_active
  ON public.safety_members (left_at);

-- ----------------------------------------------------------------------------
-- safety_checkins：每日簽到（一人一天一筆，UNIQUE 擋重複計次）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.safety_checkins (
  id           bigint generated always as identity primary key,
  member_id    bigint      not null,
  checkin_date date        not null,            -- 台灣日期，後端計算
  created_at   timestamptz not null default now(),
  constraint safety_checkins_member_fkey
    foreign key (member_id)
    references public.safety_members (id)
    on delete cascade,
  constraint safety_checkins_member_date_unique
    unique (member_id, checkin_date)
);

-- 查某人最後簽到日 / 管理端「今日已簽」判斷
CREATE INDEX IF NOT EXISTS idx_safety_checkins_member_date
  ON public.safety_checkins (member_id, checkin_date DESC);

-- ----------------------------------------------------------------------------
-- safety_care_logs：關懷紀錄（管理員標記電訪/家訪 + 一句備註）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.safety_care_logs (
  id         bigint generated always as identity primary key,
  member_id  bigint      not null,
  method     text        not null check (method in ('已電訪', '已家訪')),
  note       text,
  created_by text        not null,              -- 管理員 line_user_id（後端 verify 的 sub）
  created_at timestamptz not null default now(),
  constraint safety_care_logs_member_fkey
    foreign key (member_id)
    references public.safety_members (id)
    on delete cascade
);

-- 管理端詳情：關懷歷史（新到舊）
CREATE INDEX IF NOT EXISTS idx_safety_care_logs_member
  ON public.safety_care_logs (member_id, created_at DESC);

COMMIT;
