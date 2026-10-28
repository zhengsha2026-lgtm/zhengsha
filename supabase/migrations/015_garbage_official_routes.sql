-- 垃圾車第二期：改用基隆市官方清運路線資料（34-1 / 37-1 / 38-1）
-- 資料來源：基隆市垃圾清運路線 route_klepb.csv
-- 冪等可重跑（INSERT 用 WHERE NOT EXISTS / ON CONFLICT DO NOTHING）

BEGIN;

-- 1. 刪除第一期驗收測試路段（cascade 一併刪其時間表／特殊日期）
DELETE FROM public.garbage_routes
WHERE name IN ('正砂路', '中正路');

-- 2. 舊「每週固定時間表」由「休運日規則＋清運點固定時刻」取代
DROP TABLE IF EXISTS public.garbage_schedules;

-- 3. 路線新欄位
ALTER TABLE public.garbage_routes
  ADD COLUMN IF NOT EXISTS code text,                                      -- 路線代碼（'34-1'）
  ADD COLUMN IF NOT EXISTS recycling_days integer[] NOT NULL DEFAULT '{}', -- 回收日（{1,4,5}=週一四五有資源回收車）
  ADD COLUMN IF NOT EXISTS off_days integer[] NOT NULL DEFAULT '{0,3}';    -- 休運日（{0,3}=週日週三）

-- 4. 清運點新表（完整路線所有點，含正砂里以外；正砂里點可填別名）
CREATE TABLE IF NOT EXISTS public.garbage_stops (
  id           bigint generated always as identity primary key,
  route_id     bigint not null references public.garbage_routes(id) on delete cascade,
  stop_code    integer,              -- 官方清運點編號（例如 1344）
  name         text not null,        -- 清運點名稱（例如：東信路258巷）
  alias        text,                 -- 別名（例如：郵局、二信），里民端優先顯示，可空
  longitude    double precision,     -- 經度（之後定位用）
  latitude     double precision,     -- 緯度
  arrival_time text,                 -- 預估到達時間（'18:49'）
  is_zhengsha  boolean not null default false,  -- 是否正砂里清運點
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (route_id, stop_code)
);

CREATE INDEX IF NOT EXISTS idx_garbage_stops_route
  ON public.garbage_stops (route_id, is_active, sort_order);

-- 5. seed 三條官方路線（冪等）
INSERT INTO public.garbage_routes (code, name, sort_order, recycling_days, off_days)
SELECT '34-1', '中正區正榮街', 0, ARRAY[1,4,5], ARRAY[0,3]
WHERE NOT EXISTS (SELECT 1 FROM public.garbage_routes WHERE code = '34-1');

INSERT INTO public.garbage_routes (code, name, sort_order, recycling_days, off_days)
SELECT '37-1', '中正區祥豐街', 1, ARRAY[1,4,5], ARRAY[0,3]
WHERE NOT EXISTS (SELECT 1 FROM public.garbage_routes WHERE code = '37-1');

INSERT INTO public.garbage_routes (code, name, sort_order, recycling_days, off_days)
SELECT '38-1', '中正區豐稔街', 2, ARRAY[1,4,5], ARRAY[0,3]
WHERE NOT EXISTS (SELECT 1 FROM public.garbage_routes WHERE code = '38-1');

-- 6. seed 清運點（冪等；is_zhengsha 依里界標記）
-- 34-1 中正區正榮街（15 點，正砂里：1345–1349）
INSERT INTO public.garbage_stops (route_id, stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
SELECT r.id, v.stop_code, v.name, v.longitude, v.latitude, v.arrival_time, v.is_zhengsha, v.sort_order
FROM (VALUES
  (1344, '東明路77巷',       121.761399, 25.126020, '17:20', false,  0),
  (1345, '東信路258巷',      121.762500, 25.130150, '17:28', true,   1),
  (1346, '中正路364號',      121.761810, 25.143875, '18:00', true,   2),
  (1347, '正榮街28號~6',     121.762024, 25.144390, '18:04', true,   3),
  (1348, '正榮街31號~38',    121.762092, 25.144644, '18:06', true,   4),
  (1349, '正榮街77巷口',     121.762344, 25.146242, '18:10', true,   5),
  (1350, '正榮街110巷口',    121.763344, 25.143286, '18:15', false,  6),
  (1351, '正榮街125號',      121.763641, 25.142714, '18:17', false,  7),
  (1352, '正榮街93號',       121.763800, 25.142600, '18:20', false,  8),
  (1353, '祥豐街68巷內',     121.765495, 25.140688, '18:26', false,  9),
  (1354, '祥豐街68巷外',     121.764435, 25.141400, '18:30', false, 10),
  (1355, '立德路34號',       121.768440, 25.144359, '18:40', false, 11),
  (1356, '立德路166號',      121.769341, 25.144081, '18:47', false, 12),
  (1357, '立德路二信前門',   121.770134, 25.143765, '18:49', false, 13),
  (1358, '立德路二信後門',   121.771507, 25.143381, '18:52', false, 14)
) AS v(stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
JOIN public.garbage_routes r ON r.code = '34-1'
ON CONFLICT (route_id, stop_code) DO NOTHING;

-- 37-1 中正區祥豐街（13 點，正砂里：1450–1452）
INSERT INTO public.garbage_stops (route_id, stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
SELECT r.id, v.stop_code, v.name, v.longitude, v.latitude, v.arrival_time, v.is_zhengsha, v.sort_order
FROM (VALUES
  (1448, '祥豐街43號旁空地',          121.761765, 25.141459, '17:26', false,  0),
  (1449, '祥豐街13號前',              121.761047, 25.141535, '17:47', false,  1),
  (1450, '中正路119巷口',             121.758613, 25.140902, '17:51', true,   2),
  (1451, '中正路103號公車管理處',     121.758399, 25.140670, '18:06', true,   3),
  (1452, '中正路99號',                121.757099, 25.141190, '18:08', true,   4),
  (1453, '中正路218號',               121.757935, 25.140419, '18:11', false,  5),
  (1454, '中正路264巷32號小兒科',     121.759911, 25.140644, '18:16', false,  6),
  (1455, '豐稔街54巷口',              121.760971, 25.140447, '18:26', false,  7),
  (1456, '豐稔街100巷',               121.761391, 25.139713, '18:36', false,  8),
  (1457, '豐稔街108號前',             121.761339, 25.139050, '18:41', false,  9),
  (1458, '豐稔街112號(蔚來家)',       121.761199, 25.138670, '18:43', false, 10),
  (1459, '豐稔街130號前',             121.760009, 25.137960, '18:46', false, 11),
  (1460, '新豐街408號(海洋世界)',     121.786700, 25.135970, '19:05', false, 12)
) AS v(stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
JOIN public.garbage_routes r ON r.code = '37-1'
ON CONFLICT (route_id, stop_code) DO NOTHING;

-- 38-1 中正區豐稔街（13 點，正砂里：1470–1477）
INSERT INTO public.garbage_stops (route_id, stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
SELECT r.id, v.stop_code, v.name, v.longitude, v.latitude, v.arrival_time, v.is_zhengsha, v.sort_order
FROM (VALUES
  (1469, '豐稔街11號',        121.760673, 25.141332, '17:25', false,  0),
  (1470, '中正路308巷',       121.760696, 25.142132, '17:35', true,   1),
  (1471, '中正路330號',       121.760910, 25.142714, '17:40', true,   2),
  (1472, '中正路正榮街口',    121.761284, 25.143362, '17:45', true,   3),
  (1473, '中正路394號',       121.761664, 25.144728, '17:53', true,   4),
  (1474, '中正路400之5號',    121.761497, 25.145477, '17:55', true,   5),
  (1475, '中正路434號',       121.761528, 25.146715, '18:00', true,   6),
  (1476, '中正路458號',       121.761810, 25.147836, '18:03', true,   7),
  (1477, '中正路武昌街口',    121.762657, 25.148678, '18:05', true,   8),
  (1478, '中正路516號',       121.763496, 25.149128, '18:11', false,  9),
  (1479, '中正路武昌街尾',    121.764595, 25.149972, '18:12', false, 10),
  (1480, '中正路580號',       121.765334, 25.150434, '18:18', false, 11),
  (1481, '中正路640巷口',     121.767075, 25.151306, '18:20', false, 12)
) AS v(stop_code, name, longitude, latitude, arrival_time, is_zhengsha, sort_order)
JOIN public.garbage_routes r ON r.code = '38-1'
ON CONFLICT (route_id, stop_code) DO NOTHING;

COMMIT;
