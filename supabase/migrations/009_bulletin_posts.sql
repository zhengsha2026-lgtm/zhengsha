-- 009：公布欄（2026-10-08）
-- 里民展示用公告：不進底部四格，?tab=bulletin 直開；選後才考慮進底部。
-- 冪等設計：CREATE TABLE IF NOT EXISTS / 先 DROP 再 ADD CHECK / seed 只在空表插入。

BEGIN;

-- 公布欄文章
CREATE TABLE IF NOT EXISTS public.bulletin_posts (
  id           bigserial    PRIMARY KEY,
  title        text         NOT NULL,
  category     text         NOT NULL,
  summary      text,
  content      text         NOT NULL,
  is_pinned    boolean      NOT NULL DEFAULT false,
  is_published boolean      NOT NULL DEFAULT false,
  expires_at   timestamptz, -- NULL = 永不過期；里民端只顯示上架且未過期
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT bulletin_posts_category_check
    CHECK (category IN ('緊急', '垃圾回收', '里務', '補助申請', '其他'))
);

CREATE INDEX IF NOT EXISTS idx_bulletin_posts_listing
  ON public.bulletin_posts (is_published, is_pinned DESC, created_at DESC);

-- 放寬 admin_notifications.type：加入 bulletin_new（公布欄上架通知）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'admin_notifications'
  ) THEN
    ALTER TABLE public.admin_notifications DROP CONSTRAINT IF EXISTS admin_notifications_type_check;
    ALTER TABLE public.admin_notifications
      ADD CONSTRAINT admin_notifications_type_check
      CHECK (type IN ('feedback_new', 'safety_pending', 'event_rsvp', 'bulletin_new'));
  END IF;
END $$;

-- 3 則範例公告（僅空表時插入，方便現場展示；重跑安全）
INSERT INTO public.bulletin_posts (title, category, summary, content, is_pinned, is_published, expires_at)
SELECT * FROM (VALUES
  (
    '【緊急】豪雨特報：低窪地區請加強防範積水',
    '緊急',
    '氣象署發布豪雨特報，請里民加強防範積水，並注意收聽里辦公室最新通知。',
    E'氣象署已對本地區發布豪雨特報，提醒各位里民：\n\n一、低窪地區請提前將貴重物品移至高處，並檢查排水溝是否阻塞。\n二、外出請注意路況，行經積水路段請勿強行通過。\n三、如有災情或需要協助，請立即聯繫里辦公室。\n\n里辦公室將持續關注天氣動態，最新資訊將公布於本公布欄。',
    true,
    true,
    NULL
  ),
  (
    '本週垃圾清運時間調整公告',
    '垃圾回收',
    '因清潔隊調度，本週三晚間垃圾清運時間提前至晚間六點，請里民留意。',
    E'各位里民大家好：\n\n因清潔隊人力調度，本週三晚間垃圾清運時間將提前至「晚間六點」開始沿線收運，請各位里民提早將垃圾拿出，以免錯過清運時間。\n\n週一、週二、週四至週日維持原時間不變。\n\n造成不便，敬請見諒。',
    false,
    true,
    NULL
  ),
  (
    '里民活動中心借用須知',
    '其他',
    '里民活動中心開放借用申請，相關規定與注意事項請參閱內文。',
    E'里民活動中心即日起開放借用申請，說明如下：\n\n一、開放時間：每日上午八時至晚上十時。\n二、借用資格：本里里民或社區團體，憑身分證件至里辦公室申請。\n三、借用費用：里民活動性質免費，營利性質不受理。\n四、注意事項：使用後請恢復原狀並帶走垃圾，嚴禁施放鞭炮及從事危險活動。\n\n如有疑問，歡迎洽詢里辦公室。',
    false,
    true,
    NULL
  )
) AS seed(title, category, summary, content, is_pinned, is_published, expires_at)
WHERE NOT EXISTS (SELECT 1 FROM public.bulletin_posts);

COMMIT;
