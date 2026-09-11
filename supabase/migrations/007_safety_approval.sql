-- ============================================================================
-- 007_safety_approval.sql
-- 報平安第四期：申請＋核准（approval_status / applied_at / reviewed_* / birth_year / reject_reason）
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. 「有效會員」= left_at IS NULL 且 approval_status='approved'
--      （可簽到、可改資料、可退出、進晚間催本人與早上幹部通知、計待關懷/今日未簽）
--   2. 新申請一律 pending：不能簽到（403）、不進任何催簽/通知、不算待關懷/今日未簽、
--      不可改資料、不可撤回（第一期無撤回功能）
--   3. 同一人只保留一列（line_user_id UNIQUE）：rejected / 已退出者再申請 =
--      同一列改回 pending、更新表單資料、applied_at 重置 now()、清 reviewed_* 與
--      reject_reason；已退出者另清 left_at 與 admin_notify_snooze_until（殘留暫停無意義）
--   4. 核准（approve，可用於 pending 與 rejected，冪等）：approval_status='approved'、
--      reviewed_at/reviewed_by 寫入、清 reject_reason、baseline_date 重設為核准當天
--      （台灣日期，避免一核准就變待關懷）、清 admin_notify_snooze_until
--   5. 不通過（reject，僅 pending 可）：approval_status='rejected'、reject_reason 選填
--      （應用層上限 200 字）
--   6. birth_year 選填、只顯示給幹部；禁止依年齡自動核准/拒絕
--   7. 管理名單：全部 = approved + pending（rejected 不顯示，再申請才會回到 pending）；
--      pending 進「待審核」chip，不進 checked/unchecked/care，needs_care 恆 false
--   8. 舊資料回填（本 migration）：既有列（含已退出與測試帳）一律 approved、
--      applied_at/reviewed_at 回填 joined_at（reviewed_by 留 NULL，代表系統升級回填）、
--      行為與升級前完全相同；裡民端是否退出仍以 left_at 為準
--   9. 第一期不做：申請/審核結果的 LINE 通知、證明文件上傳、撤回申請、停止關懷獨立按鈕、印章
--
-- 存取控制慣例（與 001~006 一致）：
--   - 不啟用 RLS，所有讀寫經後端 Service Role + API 把關（requireAdmin / authenticateLineIdentity）
--   - 前端不直接連線
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- safety_members：新增申請審核欄位
-- 採「先加 nullable 欄位 → 回填 → 再鎖 NOT NULL/DEFAULT」三段式，
-- 確保在 Dashboard 重跑時不會把 go-live 後真正 pending 的新申請誤判成 approved
-- ----------------------------------------------------------------------------

-- 申請狀態（pending=待審核 / approved=已核准 / rejected=未通過）
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS approval_status text;

-- 申請時間（送出/重送申請時重置；與 joined_at 分開，joined_at 保留首次加入語義）
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

-- 審核紀錄（誰在何時核准/拒絕）
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by text;

-- 出生年（選填，只顯示給幹部；禁止依年齡自動核准/拒絕）
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS birth_year int;

-- 未通過原因（選填；應用層 ≤ 200 字）
ALTER TABLE public.safety_members
  ADD COLUMN IF NOT EXISTS reject_reason text;

-- ----------------------------------------------------------------------------
-- 舊資料回填：既有列一律 approved（行為與升級前完全相同）
-- WHERE ... IS NULL 保證 Dashboard 重跑安全：go-live 後新申請都會明確寫入狀態
-- （或吃到 DEFAULT 'pending'），不會是 NULL，重跑不會誤把它們改成 approved
-- ----------------------------------------------------------------------------
UPDATE public.safety_members
   SET approval_status = 'approved'
 WHERE approval_status IS NULL;

UPDATE public.safety_members
   SET applied_at = joined_at
 WHERE applied_at IS NULL;

-- 回填 reviewed_at = 加入日，讓管理端「核准時間」對舊會員也有值可看；
-- reviewed_by 留 NULL（系統升級回填，非真人審核）
UPDATE public.safety_members
   SET reviewed_at = joined_at
 WHERE approval_status = 'approved'
   AND reviewed_at IS NULL;

-- 鎖定欄位：狀態必填、預設 pending（新申請）；申請時間必填、預設 now()
ALTER TABLE public.safety_members
  ALTER COLUMN approval_status SET NOT NULL,
  ALTER COLUMN approval_status SET DEFAULT 'pending',
  ALTER COLUMN applied_at SET NOT NULL,
  ALTER COLUMN applied_at SET DEFAULT now();

-- ----------------------------------------------------------------------------
-- CHECK 約束（DO block 防重複執行撞名，手法同 006）
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.safety_members'::regclass
      AND conname = 'safety_members_approval_status_check'
  ) THEN
    ALTER TABLE public.safety_members
      ADD CONSTRAINT safety_members_approval_status_check
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.safety_members'::regclass
      AND conname = 'safety_members_birth_year_check'
  ) THEN
    ALTER TABLE public.safety_members
      ADD CONSTRAINT safety_members_birth_year_check
      CHECK (
        birth_year IS NULL
        OR (birth_year >= 1900 AND birth_year <= EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Taipei'))::int)
      );
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 管理端「待審核」篩選 / cron「已核准」撈取用（partial index，活躍列才需要）
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_safety_members_approval
  ON public.safety_members (approval_status, applied_at DESC)
  WHERE left_at IS NULL;

COMMIT;
