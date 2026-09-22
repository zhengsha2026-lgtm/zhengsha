-- ============================================================================
-- 008_admin_notifications.sql
-- 管理員通知第一期：admin_notifications / admin_notification_reads
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. 寫入來源只有三類（fire-and-forget，失敗只 log、絕不擋里民主流程）：
--      feedback_new  = POST /api/feedback 成功後（新反映）
--      safety_pending= POST /api/safety/join 成功後（報平安待審核）
--      event_rsvp    = POST /api/events/:id/rsvp 成功後（行程新報名）
--      每日簽到、取消報名、狀態變更、snooze 一律不寫通知
--   2. summary 不放完整電話（只取稱呼 ≤ 20 字 + 內容前 40 字）
--   3. 已讀模型：admin_notification_reads 每人每則一筆
--      （UNIQUE(notification_id, line_user_id)），upsert ignoreDuplicates 冪等；
--      未讀 = 沒有對應 read 列
--   4. ref_id 存 text（相容不同表的主鍵型別），導向前由應用層轉型
--   5. 舊通知不刪（保留稽核；量極小）
--
-- 存取控制慣例（與 001~007 一致）：
--   - 不啟用 RLS，所有讀寫經後端 Service Role + API 把關（requireAdmin）
--   - 前端不直接連這兩張表
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- admin_notifications：管理員通知主表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id         bigserial   primary key,
  type       text        not null check (type in ('feedback_new', 'safety_pending', 'event_rsvp')),
  title      text        not null,
  summary    text,
  ref_table  text,
  ref_id     text,
  created_at timestamptz not null default now()
);

-- 未讀列表（最新在前）
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created
  ON public.admin_notifications (created_at DESC);

-- Email digest 每日三類計數
CREATE INDEX IF NOT EXISTS idx_admin_notifications_type
  ON public.admin_notifications (type, created_at);

-- ----------------------------------------------------------------------------
-- admin_notification_reads：管理員通知已讀紀錄（每人每則一筆）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_notification_reads (
  notification_id bigint      not null references public.admin_notifications(id) on delete cascade,
  line_user_id    text        not null,            -- 管理員 LINE sub（後端 verify 的值）
  read_at         timestamptz not null default now(),
  constraint admin_notification_reads_unique
    unique (notification_id, line_user_id)
);

-- 未讀數計算（先撈該管理員的 read set 再比對）
CREATE INDEX IF NOT EXISTS idx_admin_notification_reads_lookup
  ON public.admin_notification_reads (line_user_id, notification_id);

COMMIT;
