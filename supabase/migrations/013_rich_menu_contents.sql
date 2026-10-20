-- 013：圖文選單動態回覆（rich_menu_contents）（2026-10-20）
-- 管理端維護各類型（type）回覆內容；webhook 收到 postback 時
-- 依 type 取「is_active = true 且 updated_at 最新」一筆，在 LINE 聊天室回覆文字。
-- 同一 type 可有多筆（歷史版本留在表裡，靠 is_active + updated_at 取最新）。
-- 冪等設計：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS。

BEGIN;

CREATE TABLE IF NOT EXISTS public.rich_menu_contents (
  id         bigserial   PRIMARY KEY,
  type       text        NOT NULL,             -- 類型代碼，例如 garbage / outage（存小寫）
  title      text,                             -- 標題（可空；回覆時組成「標題\n內容」）
  content    text        NOT NULL,             -- 回覆內文（LINE 文字訊息上限 2000 字）
  is_active  boolean     NOT NULL DEFAULT true,-- 是否啟用（停用的不會回覆）
  updated_at timestamptz NOT NULL DEFAULT now(),-- 取最新的依據（編輯時後端會 bump）
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rich_menu_contents_latest
  ON public.rich_menu_contents (type, is_active, updated_at DESC);

COMMIT;
