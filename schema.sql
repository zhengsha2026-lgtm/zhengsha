create table if not exists public.user_feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  line_user_id text not null,
  user_name text,
  phone text,
  category text not null check (category in ('治安', '環境', '銀髮', '親子', '其他')),
  content text not null,
  status text not null default '待處理' check (status in ('待處理', '處理中', '已結案'))
);

create index if not exists idx_user_feedback_line_user_id
  on public.user_feedback (line_user_id);

create index if not exists idx_user_feedback_status
  on public.user_feedback (status);

create index if not exists idx_user_feedback_created_at
  on public.user_feedback (created_at desc);

create table if not exists public.campaign_platforms (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  sort_order integer not null,
  subtitle text not null,
  title text not null,
  description text not null,
  icon text not null,
  theme_color text not null check (
    theme_color in (
      'blue',
      'pink',
      'emerald',
      'amber',
      'indigo',
      'violet',
      'rose',
      'sky',
      'cyan',
      'teal',
      'orange'
    )
  ),
  agree_count integer not null default 0
);

create unique index if not exists idx_campaign_platforms_sort_order
  on public.campaign_platforms (sort_order);

create index if not exists idx_campaign_platforms_agree_count
  on public.campaign_platforms (agree_count desc);
