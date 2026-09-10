-- ============================================================================
-- 006_safety_snooze.sql
-- 報平安第三期：「暫不提醒幹部」（admin_notify_snooze_until）
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. snooze_until = 按下當天（Asia/Taipei，getTaipeiToday()）+ 3 天，後端寫死，
--      不收前端任何天數參數
--   2. 暫停中 = snooze_until >= 今天（YYYY-MM-DD 字串比較）；到期日當天仍暫停，
--      隔天早上 09:00 幹部推播自動恢復，不需等到簽到、不需任何清除動作
--   3. 只關閉兩件事：待關懷篩選（needs_care 對 filter=care 與 chip 計數為 false）
--      與早上幹部推播（admin_care 不含此人、不計入人數）
--   4. 本人晚間催簽（resident_same_day）照常發；missing_days 照算、名單仍顯示
--   5. 標記已電訪/已家訪不自動暫停；暫停是獨立按鈕（POST /api/admin/safety/:id/snooze）
--   6. 暫停中前端隱藏按鈕、顯示「幹部通知暫停至 YYYY/MM/DD」；無取消暫停功能
--   7. 暫停動作在 safety_care_logs 留一筆：method='暫停幹部通知'、
--      note='至 YYYY/MM/DD（3 天）'、created_by=按下的管理員
--   8. 到期後欄位舊值留著（無害，留下「上次暫停到哪天」痕跡），再按一次才會覆寫
--
-- 存取控制慣例（與 001~005 一致）：
--   - 不啟用 RLS，所有讀寫經後端 Service Role + API 把關（requireAdmin）
--   - 前端不直接連線
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- safety_members：加暫停到期日
-- 用 date 不用 timestamptz：全案日期比較都是台灣日曆日字串（YYYY-MM-DD），
-- 「暫停 3 天」是日曆日概念，不需時刻語義
-- ----------------------------------------------------------------------------
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS admin_notify_snooze_until date;

-- ----------------------------------------------------------------------------
-- safety_care_logs：method CHECK 放寬，加入「暫停幹部通知」
-- 004 的 inline check 預設名為 safety_care_logs_method_check；
-- 用 DO block 先拆掉任何掛在 method 上的 CHECK 再重建（通用防呆，
-- 即使約束名不同或已被改名也能正確處理）
-- ----------------------------------------------------------------------------
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.safety_care_logs'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%method%'
  LOOP
    EXECUTE format('ALTER TABLE public.safety_care_logs DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.safety_care_logs
  ADD CONSTRAINT safety_care_logs_method_check
  CHECK (method IN ('已電訪', '已家訪', '暫停幹部通知'));

COMMIT;
