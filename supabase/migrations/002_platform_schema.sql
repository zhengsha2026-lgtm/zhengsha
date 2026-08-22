BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'campaign_platforms'
  ) THEN
    -- 新增欄位（冪等）
    ALTER TABLE public.campaign_platforms
      ADD COLUMN IF NOT EXISTS summary text,
      ADD COLUMN IF NOT EXISTS content text,
      ADD COLUMN IF NOT EXISTS cover_image_path text,
      ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS is_published boolean NOT NULL DEFAULT true;

    -- 回填：content 為空時取 description
    UPDATE public.campaign_platforms
    SET content = COALESCE(content, description)
    WHERE content IS NULL;

    -- 回填：summary 為空時取 description 前 50 字（含中文字元）
    UPDATE public.campaign_platforms
    SET summary = LEFT(COALESCE(description, ''), 50)
    WHERE summary IS NULL OR summary = '';

    -- 現有資料預設為已上架
    UPDATE public.campaign_platforms
    SET is_published = true
    WHERE is_published IS NULL;
  END IF;
END $$;

-- 主打唯一性：確保同一時間最多只有一筆 is_featured = true
-- 用 partial unique index 達成（只在 is_featured = true 時限制唯一）
DROP INDEX IF EXISTS idx_campaign_platforms_featured_singleton;
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_platforms_featured_singleton
  ON public.campaign_platforms (is_featured)
  WHERE is_featured = true;

COMMIT;

-- Storage bucket：政見封面圖（private，與 wish-photos 權限一致）
INSERT INTO storage.buckets (id, name, public)
VALUES ('platform-covers', 'platform-covers', false)
ON CONFLICT (id) DO NOTHING;

-- RLS policies：與 wish-photos 一致
-- anon/authenticated 不可直接讀寫；僅 service role（後端）可存取
DROP POLICY IF EXISTS "platform-covers read via service role only" ON storage.objects;
DROP POLICY IF EXISTS "platform-covers write via service role only" ON storage.objects;

-- 預設拒絕所有 anon/authenticated 存取此 bucket
CREATE POLICY "platform-covers deny anon read"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'platform-covers' AND false);

CREATE POLICY "platform-covers deny anon write"
  ON storage.objects FOR INSERT
  TO anon
  WITH CHECK (bucket_id = 'platform-covers' AND false);

CREATE POLICY "platform-covers deny authenticated read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'platform-covers' AND false);

CREATE POLICY "platform-covers deny authenticated write"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'platform-covers' AND false);
