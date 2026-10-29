-- 017：特殊日期支援「停運」與「增班」兩種類型
--   kind = 'off'   停運（現有行為：當天停運，查詢顯示最近清運日）
--   kind = 'extra' 增班（當天多跑一趟；extra_first_time = 第一個清運點到達時間 'HH:MM'，
--                   其餘清運點時間由後端依原路線各點時間間隔推算）
-- 冪等可重跑；既有資料 kind 預設 'off'（目前特殊日期皆為停運用途）
-- ⚠️ 需手動於 Supabase SQL Editor 執行；未執行前 push 上線會讓垃圾車查詢失敗（select 含新欄位）

BEGIN;

ALTER TABLE public.garbage_special_dates
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'off';

ALTER TABLE public.garbage_special_dates
  ADD COLUMN IF NOT EXISTS extra_first_time text;

-- 收斂：kind 只允許 'off' / 'extra'（冪等：先 DROP 再 ADD）
ALTER TABLE public.garbage_special_dates
  DROP CONSTRAINT IF EXISTS garbage_special_dates_kind_check;
ALTER TABLE public.garbage_special_dates
  ADD CONSTRAINT garbage_special_dates_kind_check
  CHECK (kind IN ('off', 'extra'));

COMMIT;
