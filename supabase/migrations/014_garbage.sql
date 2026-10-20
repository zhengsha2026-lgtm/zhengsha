-- 垃圾車查詢第一期（手動選路段）
--   garbage_routes       路段（例如：正砂路、中正路）
--   garbage_schedules    固定時間表（一週七天，每路段每天最多一筆）
--   garbage_special_dates 特殊日期（過年、連假等，優先於固定時間）
-- 冪等可重跑（IF NOT EXISTS）

BEGIN;

CREATE TABLE IF NOT EXISTS public.garbage_routes (
  id         bigint generated always as identity primary key,
  name       text        not null,                    -- 路段名稱（例如：正砂路、中正路）
  sort_order integer     not null default 0,
  is_active  boolean     not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

CREATE TABLE IF NOT EXISTS public.garbage_schedules (
  id           bigint generated always as identity primary key,
  route_id     bigint    not null references public.garbage_routes(id) on delete cascade,
  day_of_week  integer   not null,                   -- 0=週日, 1=週一 ... 6=週六
  time_text    text      not null,                   -- 例如：「18:30–19:00」
  location_text text     not null,                   -- 例如：「正砂路與中正路口」
  note         text,                                 -- 選填備註
  is_active    boolean   not null default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (route_id, day_of_week)
);

CREATE TABLE IF NOT EXISTS public.garbage_special_dates (
  id           bigint generated always as identity primary key,
  route_id     bigint    not null references public.garbage_routes(id) on delete cascade,
  special_date date      not null,                   -- 台北日期
  time_text    text,                                 -- null = 無（例如暫停）
  location_text text,
  note         text,                                 -- 例如：「春節暫停」
  is_active    boolean   not null default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (route_id, special_date)
);

CREATE INDEX IF NOT EXISTS idx_garbage_routes_active
  ON public.garbage_routes (is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_garbage_schedules_route_day
  ON public.garbage_schedules (route_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_garbage_special_dates_route_date
  ON public.garbage_special_dates (route_id, special_date);

COMMIT;
