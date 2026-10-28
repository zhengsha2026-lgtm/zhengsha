-- ============================================================================
-- 016：垃圾車路線別名（LINE 兩層選擇：路線別名 → 清運點 → 到達時間）
-- ⚠️ 需手動於 Supabase SQL Editor 執行（冪等可重跑）
-- ============================================================================

-- 1. garbage_routes 加 alias 欄位（text，可空；里民端按鈕顯示用，未填 fallback 用 name）
ALTER TABLE garbage_routes ADD COLUMN IF NOT EXISTS alias text;

-- 2. 預設別名 seed（只填空白，不覆蓋後台已填的值；之後可在管理後台修改）
UPDATE garbage_routes SET alias = '正榮街' WHERE code = '34-1' AND (alias IS NULL OR btrim(alias) = '');
UPDATE garbage_routes SET alias = '祥豐街' WHERE code = '37-1' AND (alias IS NULL OR btrim(alias) = '');
UPDATE garbage_routes SET alias = '豐稔街' WHERE code = '38-1' AND (alias IS NULL OR btrim(alias) = '');
