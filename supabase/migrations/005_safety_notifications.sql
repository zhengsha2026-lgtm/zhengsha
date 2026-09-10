-- ============================================================================
-- 005_safety_notifications.sql
-- 報平安第二期：safety_notification_logs（通知發送紀錄，冪等用）
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. 冪等鍵 = (notify_type, line_user_id, notify_date)：
--      每人每天每類型最多 1 則，UNIQUE 約束 DB 層保證，cron 重跑也擋得住
--   2. notify_type 只有兩種：
--      resident_same_day = 當晚 20:00 催本人（活躍且今日未簽）
--      admin_care        = 隔天 09:00 通知幹部（待關懷 missing_days >= 2）
--   3. 成功才寫 log：push 失敗不佔用當天額度（當天不重試，下次 cron 是隔天）
--   4. line_user_id 不 FK safety_members：
--      admin_care 收件人（管理員）不一定是報平安會員；
--      冪等鍵是「人 + 類型 + 日期」，與會員資料無關
--   5. notify_date 一律由後端以 Asia/Taipei 計算（getTaipeiToday()），不信前端
--   6. 舊紀錄不刪（保留稽核；量極小，每天最多十幾筆）
--   7. 家人（contact_phone）不做任何通知
--
-- 存取控制慣例（與 001_wish / 002_platform / 003_events / 004_safety 一致）：
--   - 表級不啟用 RLS，所有讀寫經後端 Service Role + API 把關
--   - 前端不直接連這張表
--   - 本模組不需要 Storage bucket
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- safety_notification_logs：報平安通知發送紀錄
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.safety_notification_logs (
  id           bigint generated always as identity primary key,
  line_user_id text        not null,            -- 收件人 LINE sub（里民本人或管理員，後端 verify 的值）
  notify_type  text        not null check (notify_type in ('resident_same_day', 'admin_care')),
  notify_date  date        not null,            -- 台灣日期，後端計算
  created_at   timestamptz not null default now(),
  constraint safety_notification_logs_unique
    unique (notify_type, line_user_id, notify_date)
);

-- 冪等查詢：今天的某類型已發過誰
CREATE INDEX IF NOT EXISTS idx_safety_notification_logs_lookup
  ON public.safety_notification_logs (notify_type, notify_date);

COMMIT;
