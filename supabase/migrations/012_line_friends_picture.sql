-- 012: line_friends 加 picture_url 欄位（LINE 頭像網址）
-- 有人加入好友時（follow 事件）一併存入；舊資料無此資訊，保留 NULL
-- 冪等：可重複執行

BEGIN;

ALTER TABLE public.line_friends
  ADD COLUMN IF NOT EXISTS picture_url text;

COMMIT;
