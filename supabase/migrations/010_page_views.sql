-- 010：瀏覽紀錄（2026-10-09）
-- 誰、何時、進了哪個分頁。未登入不寫入（後端驗 LINE ID Token 的 sub）。
-- 同一人同一頁 5 分鐘內去重（後端 POST /api/page-views 略過，仍回成功）。
-- 冪等設計：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

BEGIN;

CREATE TABLE IF NOT EXISTS public.page_views (
  id           bigserial    PRIMARY KEY,
  line_user_id text         NOT NULL, -- LINE verify API 的 sub，不信前端
  page_code    text         NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT page_views_page_code_check
    CHECK (page_code IN (
      -- 里民端 liff.html 分頁
      'platforms',   -- 核心政見
      'intro',       -- 候選人介紹
      'wish',        -- 有事找里長
      'schedule',    -- 競選行程
      'bulletin',    -- 公布欄
      'safety',      -- 報平安
      'admin_home',  -- 管理首頁（盾牌 / admin.html 進入）
      -- 電腦版 admin.html 模組
      'admin_feedback', -- 反映管理
      'admin_safety',   -- 報平安管理
      'admin_events',   -- 行程管理
      'admin_bulletin'  -- 公布欄管理
    ))
);

-- 管理端「最近 50 筆」查詢
CREATE INDEX IF NOT EXISTS idx_page_views_recent
  ON public.page_views (created_at DESC);

-- 同人同頁 5 分鐘去重查詢
CREATE INDEX IF NOT EXISTS idx_page_views_dedup
  ON public.page_views (line_user_id, page_code, created_at DESC);

-- 今日（台北）統計查詢
CREATE INDEX IF NOT EXISTS idx_page_views_today
  ON public.page_views (created_at DESC, page_code);

COMMIT;
