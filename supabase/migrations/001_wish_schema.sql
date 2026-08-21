BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'user_feedback'
  ) THEN
    ALTER TABLE public.user_feedback
      ADD COLUMN IF NOT EXISTS updated_at timestamptz,
      ADD COLUMN IF NOT EXISTS last_status_at timestamptz,
      ADD COLUMN IF NOT EXISTS reply_summary text,
      ADD COLUMN IF NOT EXISTS photo_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS has_photos boolean NOT NULL DEFAULT false;

    ALTER TABLE public.user_feedback
      DROP CONSTRAINT IF EXISTS user_feedback_status_check;

    ALTER TABLE public.user_feedback
      ALTER COLUMN updated_at SET DEFAULT now();

    ALTER TABLE public.user_feedback
      ALTER COLUMN last_status_at SET DEFAULT now();

    ALTER TABLE public.user_feedback
      ALTER COLUMN status SET DEFAULT '已收到';

    UPDATE public.user_feedback
      SET status = '已收到'
      WHERE status = '待處理';

    UPDATE public.user_feedback
      SET last_status_at = COALESCE(last_status_at, created_at)
      WHERE last_status_at IS NULL;

    UPDATE public.user_feedback
      SET updated_at = COALESCE(updated_at, created_at)
      WHERE updated_at IS NULL;

    ALTER TABLE public.user_feedback
      ADD CONSTRAINT user_feedback_status_check
      CHECK (status IN ('已收到', '處理中', '已回覆', '已結案'));

    CREATE INDEX IF NOT EXISTS idx_user_feedback_last_status_at
      ON public.user_feedback (last_status_at DESC);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_feedback_photos (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  feedback_id bigint not null,
  line_user_id text not null,
  bucket_name text not null default 'wish-photos',
  storage_path text not null,
  file_name text,
  content_type text,
  file_size bigint,
  sort_order integer not null default 1,
  constraint user_feedback_photos_feedback_id_fkey
    foreign key (feedback_id)
    references public.user_feedback (id)
    on delete cascade
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_photos_feedback_id
  ON public.user_feedback_photos (feedback_id);

CREATE INDEX IF NOT EXISTS idx_user_feedback_photos_line_user_id
  ON public.user_feedback_photos (line_user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_feedback_photos_feedback_id_sort_order
  ON public.user_feedback_photos (feedback_id, sort_order);

CREATE TABLE IF NOT EXISTS public.user_feedback_status_logs (
  id bigint generated always as identity primary key,
  feedback_id bigint not null,
  status text not null,
  note text,
  changed_by text,
  changed_at timestamptz not null default now(),
  constraint user_feedback_status_logs_feedback_id_fkey
    foreign key (feedback_id)
    references public.user_feedback (id)
    on delete cascade,
  constraint user_feedback_status_logs_status_check
    check (status in ('已收到', '處理中', '已回覆', '已結案'))
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_status_logs_feedback_id
  ON public.user_feedback_status_logs (feedback_id);

CREATE INDEX IF NOT EXISTS idx_user_feedback_status_logs_changed_at
  ON public.user_feedback_status_logs (changed_at desc);

COMMIT;
