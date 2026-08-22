-- ============================================================================
-- 003_events_schema.sql
-- 競選行程第一版：campaign_events / campaign_event_photos / event_rsvps
-- ============================================================================
-- 應用層邏輯（不在本 migration 範圍，寫程式時務必遵守）：
--   1. 已結束行程「不擋」取消報名：DELETE /api/events/:id/rsvp 不檢查 start_at
--   2. upcoming / past 只看 start_at vs now()，不另存狀態欄位
--   3. 主打 = upcoming 第一筆，列表回傳時不重複出現
--   4. LINE 通知文案由後端寫死（不上架自動群發，管理員手動按鈕）
--   5. description 為列表摘要用；title 前後端一致
--
-- 存取控制慣例（與 001_wish / 002_platform 一致）：
--   - 表級不啟用 RLS，所有讀寫經後端 Service Role + API 把關
--   - 前端不直接連這三張表
--   - Storage bucket event-covers 啟用 RLS deny anon/authenticated
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- campaign_events：行程主表
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_events (
  id              bigint generated always as identity primary key,
  title           text        not null,
  description     text,
  content         text,
  start_at        timestamptz not null,
  end_at          timestamptz,
  location        text,
  cover_image_path text,
  video_url       text,
  rsvp_count      integer     not null default 0,
  is_published    boolean     not null default false,  -- 新增預設未上架
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 里民端列表查詢：is_published = true 且依時間排序
CREATE INDEX IF NOT EXISTS idx_campaign_events_published_start
  ON public.campaign_events (is_published, start_at);

-- 管理端列表查詢：依時間排序
CREATE INDEX IF NOT EXISTS idx_campaign_events_start_at
  ON public.campaign_events (start_at);

-- ----------------------------------------------------------------------------
-- campaign_event_photos：相簿（每場最多 6 張，應用層限制，schema 不強制）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.campaign_event_photos (
  id           bigint generated always as identity primary key,
  event_id     bigint not null,
  storage_path text   not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint campaign_event_photos_event_id_fkey
    foreign key (event_id)
    references public.campaign_events (id)
    on delete cascade
);

CREATE INDEX IF NOT EXISTS idx_campaign_event_photos_event_id
  ON public.campaign_event_photos (event_id);

CREATE INDEX IF NOT EXISTS idx_campaign_event_photos_event_sort
  ON public.campaign_event_photos (event_id, sort_order);

-- ----------------------------------------------------------------------------
-- event_rsvps：報名（同場同人不重複）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_rsvps (
  id           bigint generated always as identity primary key,
  event_id     bigint not null,
  line_user_id text   not null,   -- 後端 verify 後的 LINE sub，不信前端
  created_at   timestamptz not null default now(),
  constraint event_rsvps_event_id_fkey
    foreign key (event_id)
    references public.campaign_events (id)
    on delete cascade,
  constraint event_rsvps_event_line_unique
    unique (event_id, line_user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_rsvps_event_id
  ON public.event_rsvps (event_id);

CREATE INDEX IF NOT EXISTS idx_event_rsvps_line_user_id
  ON public.event_rsvps (line_user_id);

-- ----------------------------------------------------------------------------
-- Trigger：維護 campaign_events.rsvp_count（INSERT/DELETE 後重算）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_event_rsvp_count_maintain()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_event_id bigint;
BEGIN
  target_event_id := COALESCE(NEW.event_id, OLD.event_id);
  IF target_event_id IS NOT NULL THEN
    UPDATE public.campaign_events
      SET rsvp_count = (
        SELECT count(*) FROM public.event_rsvps
        WHERE event_id = target_event_id
      )
      WHERE id = target_event_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_event_rsvp_count_insert ON public.event_rsvps;
CREATE TRIGGER trg_event_rsvp_count_insert
  AFTER INSERT ON public.event_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_rsvp_count_maintain();

DROP TRIGGER IF EXISTS trg_event_rsvp_count_delete ON public.event_rsvps;
CREATE TRIGGER trg_event_rsvp_count_delete
  AFTER DELETE ON public.event_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.fn_event_rsvp_count_maintain();

-- ----------------------------------------------------------------------------
-- Trigger：campaign_events.updated_at 自動維護
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_campaign_events_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campaign_events_touch_updated_at ON public.campaign_events;
CREATE TRIGGER trg_campaign_events_touch_updated_at
  BEFORE UPDATE ON public.campaign_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_campaign_events_touch_updated_at();

COMMIT;

-- ============================================================================
-- Storage bucket：event-covers（private，與 platform-covers / wish-photos 一致）
--   封面 covers/{event_id}/{uuid}.webp
--   相簿 albums/{event_id}/{uuid}.webp
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('event-covers', 'event-covers', false)
ON CONFLICT (id) DO NOTHING;

-- RLS：deny anon/authenticated 直接存取（僅 service role 可用）
DROP POLICY IF EXISTS "event-covers deny anon read" ON storage.objects;
DROP POLICY IF EXISTS "event-covers deny anon write" ON storage.objects;
DROP POLICY IF EXISTS "event-covers deny authenticated read" ON storage.objects;
DROP POLICY IF EXISTS "event-covers deny authenticated write" ON storage.objects;

CREATE POLICY "event-covers deny anon read"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'event-covers' AND false);

CREATE POLICY "event-covers deny anon write"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (bucket_id = 'event-covers' AND false);

CREATE POLICY "event-covers deny authenticated read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'event-covers' AND false);

CREATE POLICY "event-covers deny authenticated write"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'event-covers' AND false);
