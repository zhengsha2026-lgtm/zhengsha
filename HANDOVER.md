# HANDOVER.md
正砂里里長候選人 LIFF 應用 — 專案交接說明

> 任何新的開發者（人或 AI）請先完整閱讀本文件，再開始修改程式。  
> 以本文件與 GitHub 程式碼為準，不要依對話記憶自行假設。

> **術語對照（2026-09-13 起）**：裡民端「許願池」對外顯示名稱已改為**「有事找里長」**（分段「我要反映／我的案件」、管理端模組名「反映管理」、列表欄位「反映內容」、行程通知按鈕「通知曾反映過的里民」）。**對內代號不變**：API 路徑（`/api/feedback` 等）、資料表（`user_feedback`）、deep-link `?tab=wish`、Storage bucket `wish-photos` 全部保留。本文件中「許願／許願池／wish」字樣一律指同一模組。LINE webhook 關鍵字新增「找里長」「有事找里長」，舊「許願池」「表單」保留。

---

## 1. 專案是什麼

這是基隆市中正區「正砂里」里長候選人（曾思容）的 LINE LIFF 應用。

目標：
- 競選期間：政見、候選人介紹、行程、里民許願
- 當選後：可延伸為里民服務系統（許願追蹤、公告等）

目前網址部署於 Vercel（zhengsha.vercel.app）。

---

## 2. 技術棧

| 層級 | 技術 |
|------|------|
| 前端 | 單一主要檔案 `public/liff.html`（LINE LIFF） |
| 後端 | `app.js`（Node.js） |
| 資料庫 | Supabase Postgres |
| 檔案儲存 | Supabase Storage（private bucket: `wish-photos`、`platform-covers`、`event-covers`） |
| 身分驗證 | LINE LIFF ID Token（後端驗證） |
| 管理員驗證 | LINE 白名單（環境變數 `ADMIN_LINE_USER_IDS`） |
| 部署 | GitHub → Vercel 自動部署 |

---

## 3. 目前已完成的功能

### 頁面
- 核心政見（單欄主打卡 + 左圖右文卡，有封面圖、摘要、支持數；詳情視窗為**底部位板動畫**：遮罩淡入 300ms、卡片自螢幕下緣升起 420ms ease-out，關閉滑回 380ms ease-in，僅 `#platformModal` 生效、其他 modal 維持 `modal-in`）
- 候選人介紹（英雄區照片放大前置 + 真情信獨立主打卡 + 初心過渡 + 三張能力卡條列）
- 有事找里長（原「里民許願池」；表單層次優化：身分卡縮為一列、切換加強、內容框為主體、送出鈕紫色）
- 我的案件列表（原「我的許願」；依狀態分組、卡片層次、時間精簡、身分列隱藏）
- 我的案件列表上方**進度篩選**（全部 / 處理中 / 已完成，與「我要反映／我的案件」同套 segmented control 視覺）：
  - 純前端過濾 `state.wish.list`，不打新 API；處理中 = `已收到`/`處理中`/`已回覆`，已完成 = `已結案`（含未來可能的 `已取消`）
  - 按鈕顯示筆數 `(N)`：列表**載入完成後**（`finally`、`loading=false` 之後）才重算；從未載入不顯示、載入中顯示 `—`（避免 `(0)` 誤導）
  - 空狀態依篩選顯示（「目前沒有處理中的反映」等）
- 我的案件（列表 + 詳情）
- 競選行程（里民端：主打 hero 卡 + 即將到來/過往足跡分組 + 詳情 modal + 16:9 封面與相簿 + 影片外連 + 報名/取消報名；管理端可看到報名人數）
- 報平安（?tab=safety 直開，不進底部導覽：每日簽到 + 個人資料/緊急聯絡人管理；管理端有待關懷名單與關懷紀錄）

### 許願相關（重點）
- 里民可填寫並送出許願
- 支援上傳最多 **3 張照片**；照片入口為**兩顆按鈕**：「拍照」（`capture="environment"`，單張，解決 LINE WebView 單一 file input 不出相機的問題）與「從相簿選擇」（可多選）；滿 3 張兩顆都停用，兩者走同一壓縮/預覽/刪除流程
- 前端壓縮為 webp 後，透過 signed URL 直傳 Supabase Storage
- 送出後寫入狀態「已收到」
- 「我的許願」可查看自己的歷史許願、照片、**完整處理時間軸**（對齊後端 `status_timeline` / `changed_at`）
- 所有相關 API 都需驗證 LINE ID Token
- 許願表單上方使用者卡片：移除「使用者識別」標題，隱私說明改為「？」彈窗（不佔大塊版面）

### 許願池後台管理（管理員專用）
- 管理員 LINE 白名單驗證（環境變數 `ADMIN_LINE_USER_IDS`）
- 前端 LIFF 登入後呼叫 `/api/admin/me` 判斷是否為管理員
- 管理入口：header 右上角盾牌圖示（僅管理員可見），點擊進入管理首頁
- 底部導覽永遠維持 4 個 Tab（核心政見/候選人介紹/里民許願池/競選行程），不再有第 5 個管理 Tab
- 管理首頁：模組列表（許願管理、政見管理可用、行程管理可用）
- 許願管理為子頁：管理首頁 → 許願列表 → 詳情處理，各層級有返回按鈕
- 許願列表頁：狀態 chips（全部/已收到/處理中/已回覆/已結案，含計數）、搜尋（姓名/電話/內容）、分頁
- 許願詳情頁：案件摘要、里民資訊（含複製電話/撥打）、完整內容、照片、目前回覆、操作區（狀態變更 + 回覆填寫 + 儲存）、處理歷程時間軸
- 變更狀態或回覆後，自動新增一筆 `user_feedback_status_logs`，`changed_by` 填入管理員 LINE user id
- 儲存成功後自動同步詳情與列表計數
- 管理 API 與里民 API 路徑與權限完全分隔

### 政見管理（管理員專用）
- 里民端政見改版：單欄主打卡（`is_featured` 筆，16:9 封面圖 + 摘要 + 支持數）+ 其餘左圖右文卡
- 每張卡（主打與小卡）都有「查看政見 →」提示：主打卡在右下（`text-xs`）、小卡在右欄底部與支持數同行靠右（`text-[11px]` 紫色，hover 箭頭微開）；**點擊區域仍是整張卡**（`data-platform-open`），非獨立按鈕
- 沒封面圖時用 `theme_color` + `icon` 做 fallback 色塊
- 詳情 modal 頂部可顯示封面圖，全文改用 `content` 欄位（fallback `description`）
- 政見管理列表：封面縮圖、標題、分類、支持數、排序、主打標記；可上移/下移、設為主打、進入編輯
- 政見編輯頁：封面上傳（前端壓縮 WebP → signed URL 直傳）/更換/刪除、分類（subtitle）、標題、列表摘要、完整內容、是否主打、是否上架
- 設為主打時自動取消其他筆主打（partial unique index 保證唯一性）
- 排序交換：PATCH sort_order 時後端自動與佔用者交換
- `is_published = false` 的政見里民端不顯示

### 管理端電腦版（許願管理 + 報平安管理）
- **網址**：`https://zhengsha.vercel.app/admin.html`
- **登入方式**：電腦瀏覽器開啟後，透過**第二個 LIFF app**（`ADMIN_LIFF_ID`，與里民 LIFF 同一個 LINE Login 頻道）做 LINE Login（掃 QR 或用已登入的 LINE 帳號）
- **權限**：登入後打 `GET /api/admin/me` 檢查白名單（`ADMIN_LINE_USER_IDS`，後端以 LINE verify API 回傳的 `sub` 為準）；非白名單顯示「沒有管理權限」頁，**不會打任何會碰里民個資的 API**
- **登入／驗證中畫面標題**：「管理後台」（`<title>`、authScreen `<h1>`、header 三處一致）
- **頂部模組導覽**：header 內「許願池 | 報平安」segmented tabs（預留未來政見/行程）；`switchModule()` 互斥切換 `#moduleFeedback` / `#moduleSafety`，報平安**第一次切換才打 API**（惰性載入）
- **功能（許願池）**：許願列表（桌面表格：狀態 chips 含計數、搜尋、分頁）＋ 詳情（左右雙欄：案件內容/照片/時間軸 + 里民資訊/狀態變更/回覆填寫）＋ 儲存（自動寫 `status_logs`）＋ 刪除（二次確認，接 `DELETE /api/admin/feedback/:id`）
- **許願狀態 chips 計數**：一律用 API 回傳的**全域 `counts`**（各狀態總數，後端 5 個獨立 head-count，不吃 `status`/`q`/`limit`/`offset` 參數），**不隨目前篩選/搜尋/分頁變動**（例：點「已結案」後「全部」數字不變）；分頁 UI 的總筆數另用 `data.pagination.total_count`（目前篩選+搜尋下的總數，只給分頁用，**不是**全域數字）
- **功能（報平安）**：沿用 `/api/admin/safety*` 同一組 API，後端零修改；列表（四組篩選 chips 含計數 + 表格：稱呼/狀態/未簽天數/里民電話/聯絡人/最後簽到/暫停至，暫停中顯示 amber chip 且不計入待關懷）＋ 詳情（雙欄：關懷歷史時間軸 + 近期簽到；里民/聯絡人電話一鍵複製、標記已電訪/已家訪 + 備註、「暫不提醒幹部 3 天」按鈕—暫停中隱藏顯示到期日）；已退出會員只可看不可操作
- **電腦閱讀體驗**：內容最大寬度 1280px 置中左右留白；正文/表格/姓名/摘要 16px、時間與分類 14px（表格不低於 14px 的次要欄、主要欄 16px）；列高加大（py-4 + px-6）好點擊；chips/搜尋框/按鈕/狀態徽章同步放大；詳情標題 24px、正文 16px leading-8
- **API**：全部沿用既有 `/api/admin/*`，後端驗證邏輯零修改（同一 channel → 同 `aud`）；僅 `/api/client-config` 多回 `adminLiffId`
- **登出**：`liff.logout()` 後重整；ID Token 過期（401）自動重新 `liff.login()`
- **手機 LINE 內的盾牌管理入口完全不受影響**（`public/liff.html` 未動）
- **環境變數**：`ADMIN_LIFF_ID`（Vercel 與本機 `.env` 都要設）；`.env.example` 已有說明

### 競選行程（里民端 + 管理端）
- 里民端行程頁：底部第 4 個 Tab「競選行程」
  - `GET /api/events` 回傳 `{ next, upcoming, past }`：主打 `next` 為 upcoming 第一筆（start_at >= now），列表中**不重複**；`upcoming` 為其餘即將到來、`past` 為過往足跡（upcoming/past **只看 `start_at`**）
  - 主打 hero 卡（16:9 封面 + 標題 + 描述摘要 + 時間 + 地點 + 報名人數）
  - 即將到來/過往足跡分組，過往足跡視覺層次較低
  - 詳情 modal：封面（16:9 contain 預覽）、標題、時間區間、地點、`description`（列表摘要）、`content`（完整內容）、相簿縮圖、影片連結、報名人數 + 報名/取消按鈕
  - **報名規則**：已結束（`start_at < now`）不可「新」報名；但**已結束不擋取消報名**
  - 報名後同步更新詳情與列表的 `rsvp_count`
- 行程管理（管理員專用）：管理首頁「行程管理」模組卡片（可用）
  - 行程列表：標題、時間、上架狀態、報名人數；可新增、進入編輯、刪除
  - 行程編輯頁：標題、`description`（列表摘要）、`content`（完整內容）、`start_at`/`end_at`（**結束時間必須晚於開始時間，前端+後端都會檢查**）、`location`、`video_url`、封面上傳/更換/刪除、相簿上傳/刪除、`is_published` 上架、刪除此行程
  - 通知功能（後端文案寫死，**兩顆手動按鈕，上架不會自動群發**）：
    - `POST /api/admin/events/:id/notify-rsvp`（發 LINE 訊息給已報名里民）
    - `POST /api/admin/events/:id/notify-wish-pool`（發 LINE 訊息給曾使用許願池的里民）
    - 兩則通知都會消耗 LINE 官方帳號推播則數，建議謹慎使用
  - 行程時間顯示：畫面上一律 `YYYY/MM/DD HH:mm`（24 小時制，小時補零）；編輯頁的 `datetime-local` 系統挑選器可能仍是 12 小時，**下方另附 24 小時制可見文字**避免混淆
  - 上傳封面 / 相簿照片成功後，**只更新該區塊 DOM，不會重置表單其他已填欄位**（title、description、content、時間、地點、影片、上架等都保留）
- **圖文選單入口**：
  - 網址格式：`https://liff.line.me/{LIFF_ID}?tab=platforms|intro|wish|schedule|safety`（可用 search 或 hash 兩種）
  - 初始 Tab 規則：HTML 預設 4 個底部 Tab 的 panel 全部 `hidden`；**若 URL 讀不到 tab，不先顯示核心政見**
  - LIFF 啟動流程：頁面解析到 `</nav>` 時先用 inline script 把 search/hash 的 tab 提前打開（命中才顯示）；`liff.init()` 完成後再用 `location.search` → `location.hash` → `liff.permanentLink.createUrl()` 的順序重新解析一次，最後才 fallback platforms；目的是避免從 LINE 圖文選單進非政見頁時，**先閃核心政見再跳走**
  - 進哪個 Tab 才載該 Tab 的 API 資料（platforms/intro/wish/schedule），intro 以靜態為主，其餘 Tab 第一次進去時載入並快取，切回來不重抓
  - **啟動頁（splash）**：`<body>` 開頭即渲染純 CSS 啟動頁（頭像 + 名稱 + 載入轉圈，不依賴 Tailwind/Lucide/主 script），第一次開啟不再乾等空白；`bootstrap()` 中身分 + 初始 Tab + 管理員檢查都完成後才淡出移除（280ms），拿掉後直接是 `?tab=` 目標頁，**不會閃核心政見**；另有 **8 秒保險絲**（inline script `setTimeout`），主流程卡死也強制進頁，且超時時若所有面板仍 hidden 會緊急顯示 platforms 避免整頁空白
  - 政見封面、行程封面、相簿、管理列表縮圖全部 `loading="lazy"`，非當前 Tab 不急著載

### 報平安（里民端 + 管理端；?tab=safety 獨立頁，不進底部導覽）
- **定位**：里民每日簽到「我今天平安」；幹部從管理端看誰連續多天沒簽到（待關懷，見核心規則門檻），主動電訪/家訪並留下關懷紀錄
- **入口**：`?tab=safety` deep-link（圖文選單/官方帳號導流用）；**底部導覽維持 4 個 Tab**，safety 是隱藏第 5 個 panel，只有 URL 帶 tab 才會開
- **里民端（public/liff.html `safetyPanel`）**（第四期起為「申請 → 幹部核准」制，四態）：
  - 未加入／未通過：說明卡 + 申請表單（稱呼、本人電話、出生年〔**選填**，西元 1900–今年〕、緊急聯絡人姓名/電話）；**電話驗證與許願池同一套**：選填空白直接通過、非空只檢查長度 ≤ 30 不驗格式，過長時錯誤訊息區分「您的電話」/「聯絡人電話」；**稱呼預填 LINE 顯示名稱**（與許願表單 `#user_name` 同一來源，僅欄位為空時帶入、里民可改），稱呼欄下方有小字提示「建議填寫正確姓名或熟悉的外號，方便里辦聯繫」；**「您的電話」預填** `localStorage['zhengsha_resident_phone']`（與許願池送出後儲存同一 key，僅欄位為空時帶入）；未通過（rejected）者表單預填原資料、上方顯示幹部留的不通過原因（`reject_reason`），可修改後重新申請
  - 審核中（pending）：顯示「申請已送出、等候里辦審核」狀態卡，**不可簽到、不可改資料、不可撤回**
  - 已加入（approved）：大顆「我今天平安」簽到鈕（**冪等**：同日再按回 200 不報錯、不重複計次）、今日簽到時間、上次簽到日；**今日已簽時另顯示「連續 N 天」**（text-2xl emerald，給長者看的大字；後端現算 `streak`，今日未簽 = 0 不顯示）；「設定」可摺疊編輯稱呼/電話/聯絡人；「退出報平安」= soft delete（`left_at` 設時間），簽到歷史保留
  - 送出申請即本人同意，`line_user_id` 取自 LINE verify `sub`（不信前端）；核准或重新加入會**重設 `baseline_date`**（舊簽到不影響未簽天數計算；pending 申請時不重設，**核准當天才重設**）
- **管理端（管理首頁第 4 張模組卡「報平安」）**：
  - 名單（`GET /api/admin/safety`）：只列活躍會員（`left_at IS NULL`），同時顯示**本人電話與緊急聯絡人電話**（可點擊撥打）
  - 篩選 chips 五組含計數：全部 / **待審核** / 今日已簽 / 今日未簽 / **待關懷**（第四期起「全部」= approved + pending；**rejected 不進名單**）
  - 排序：待關懷優先（未簽天數多者在前）→ 其餘未簽 → 已簽；`missing_days` 與 `needs_care` 由後端計算
  - 名單上可一鍵標記「已電訪/已家訪」（備註可留空）；詳情頁（`GET /api/admin/safety/:id`）看完整關懷歷史 + 近期簽到紀錄，也可補備註標記關懷（`POST /api/admin/safety/:id/care`）；詳情頁另有「**暫不提醒幹部 3 天**」按鈕（見第三期），暫停中改顯示「幹部通知暫停至 YYYY/MM/DD」狀態、名單列顯示 amber chip
  - 後台徽章仍是主要看板（管理員自己上後台看）；第二期新增**排程通知**（見下方，只發本人提醒與幹部彙總，不對外群發）
- **核心規則（後端唯一可信）**：
  - 「今天」一律用 `Asia/Taipei` 時區由後端計算（`getTaipeiToday()`），不信前端傳的日期
  - 一天一筆簽到：`safety_checkins` 有 `UNIQUE(member_id, checkin_date)`
  - `missing_days` = 今天 − max(最後簽到日, baseline_date)；今日已簽 = 0
  - `streak` 連續簽到天數（`calculateSafetyStreak`，**只做顯示、不影響任何既有邏輯**）：從今天往回數 `safety_checkins.checkin_date`，日期須一天天相連、缺一天就停；今天未簽 = 0、已簽至少 1；**不跨過 `baseline_date`**（更早的舊簽到不接）；只數本會員的列；不存欄位不加表，status/checkin 回傳時現算
  - 待關懷 = 活躍 且 今日未簽 且 `missing_days >= SAFETY_CARE_MISSING_DAYS(3)`（且**未處於幹部通知暫停中**，見第三期）；**門檻常數單一來源**（`app.js` 頂部），chips 待關懷／`filter=care`／排序置頂／cron admin 全讀 `buildSafetyAdminItem` 的 `needs_care`，改一處全部同步。例：**週一簽過 → 週二(1)、週三(2) 仍不算 → 週四(3) 早上 09:00 才通知幹部、才進待關懷**（即兩個完整日沒簽，隔天早才提醒）；晚間催本人不受門檻影響（今日未簽 20:00 照催）
  - 關懷方式為「已電訪 / 已家訪 / 暫停幹部通知」三種（DB CHECK 約束；第三種由暫停按鈕自動寫入，不開放手動選）
- **第二期排程通知（Vercel Cron；已上線）**：
  - 端點：`GET /api/cron/safety-reminders/:type`（**路徑式 = Vercel Cron 用**，因 **Cron 不保留 query string**，Logs 只見路徑）＋ `GET|POST /api/cron/safety-reminders`（`?type=` 或 body `{ type }`，本機手動測試用，保留）；驗證 `Authorization: Bearer <CRON_SECRET>`：**未設 CRON_SECRET 回 503、錯誤回 401**
  - 每天**台北 20:00**（`0 12 * * *` UTC）`/resident`：對活躍且今日未簽的里民（**含今天剛加入尚未簽到者**）發本人提醒，文案固定「今天還沒報平安，點這裡補按即可。」+ `?tab=safety` LIFF 連結；已簽到者不發
  - 每天**台北 09:00**（`0 1 * * *` UTC）`/admin`：有待關懷（`missing_days >= 3`〔`SAFETY_CARE_MISSING_DAYS`〕，**沿用既有 `buildSafetyAdminItem` 計算，不重寫**）時通知 `ADMIN_LINE_USER_IDS` 每位管理員「報平安：目前有 N 位待關懷（前 3 筆稱呼，更多加「等」），請至後台查看。」+ `?tab=admin` 連結；**當天沒有待關懷就不發**（文案不變，門檻提高後人變少、通知變晚：週一簽 → 週四早才發）
  - 冪等：`safety_notification_logs` 的 `UNIQUE(notify_type, line_user_id, notify_date)` 保證每人每天每類型最多 1 則，cron 重跑不重發；**成功才寫 log**（push 失敗不佔當天額度、當天不重試）；單人 push 失敗不阻塞其他人，回傳 `attempted/succeeded/failed/skipped`
  - **家人（contact_phone）永遠不通知**；文案溫和，禁用「出事／意外」等字眼
  - 已於 2026-09-10 線上端到端驗證：401 擋未授權、新路徑 `/resident` 與 `/admin` 正確解析 type、真實推播成功（里民 1/1、管理員 2/2）、重跑冪等略過不重發
  - Hobby 方案 cron 上限 2 jobs/天各一次，本設計已貼滿（未來要加排程需升 Pro 或合併）
- **第三期「暫不提醒幹部」（已上線）**：
  - 背景：已電訪/家訪確認平安後，里民未簽到仍是待關懷 → 幹部每天被同一筆打擾；暫停讓幹部靜音 3 天、里民留在系統
  - 端點：`POST /api/admin/safety/:id/snooze`（requireAdmin；**天數後端寫死 3 天**（`SAFETY_SNOOZE_DAYS`），不收前端參數；已退出會員回 400）
  - 語義：`snooze_until = 按下當天（Asia/Taipei）+ 3`；**暫停中 = `snooze_until >= 今天`**（到期日當天仍暫停，隔天早上 09:00 推播自動恢復，不需等簽到、不需清除動作）；到期後按鈕才會再出現，**要再停必須再按一次**；無「取消暫停」功能（誤按頂多等 3 天）
  - **只關閉兩件事**：`needs_care`（→ 待關懷篩選/chip 計數不含此人 + 早上幹部推播 `admin_care` 不含、不計入 N）與排序置頂；**本人晚間催簽（`resident_same_day`）照常發**、`missing_days` 照算、名單仍顯示（顯示 amber「通知暫停至 YYYY/MM/DD」chip）、詳情/關懷歷史照常
  - 實作：`buildSafetyAdminItem` 加 `snoozeActive` 條件與 `admin_notify_snoozed` / `admin_notify_snooze_until` 回傳欄位（cron 與名單共用同一計算，**不重寫**）；3 個 select 欄位清單（名單/詳情/cron admin）補 `admin_notify_snooze_until`；電訪/家訪**不自動**暫停（兩個獨立操作）
  - 關懷歷史自動寫一筆：`method='暫停幹部通知'`、`note='至 YYYY/MM/DD（3 天）'`、`created_by`=按下管理員（前端徽章 amber + bell-off 圖示）；先 UPDATE 到期日再 INSERT 紀錄，紀錄寫入失敗會回 500 提示重按補寫（不留假紀錄）
  - 前端（僅 liff.html）：詳情「標記關懷」卡內 — 暫停中顯示 amber 狀態文字（隱藏按鈕）、未暫停顯示「暫不提醒幹部 3 天」按鈕 + 說明小字；名單列顯示暫停 chip；成功後 toast + 重抓名單與詳情
  - 新增欄位（migration `006_safety_snooze.sql`，已於 Supabase 執行）：`safety_members.admin_notify_snooze_until date`（NULL=從未暫停；舊值到期後留著無害）+ `safety_care_logs` method CHECK 放寬為三值（DO block 重建約束）
- **第四期「申請＋核准」制（本次變更）**：
  - 背景：新加入者須幹部審核才生效，避免匿名亂填直接進名單；既有簽到／催簽／暫停邏輯**零改動**，只在上面加狀態閘門
  - 狀態機：`approval_status` ∈ `pending`（新申請預設）→ `approved`（核准，行為與第四期前完全相同）／`rejected`（不通過，可修改後重新申請）；**核准前：不能簽到、不進晚間催本人（`resident_same_day`）、不進早上幹部通知（`admin_care`）、不算待關懷／今日未簽**；兩個 cron 與名單/care/snooze 端點一律加 `approval_status = 'approved'` 條件
  - 端點（皆 requireAdmin）：`POST /api/admin/safety/:id/approve`（適用 pending 與 rejected〔幹部反悔可直接核准〕；核准動作 = 寫 `reviewed_at`/`reviewed_by`、清 `reject_reason`、**`baseline_date` 重設為核准當天**〔避免一核准就待關懷〕、清殘留暫停 `admin_notify_snooze_until`；已 approved 回 200 冪等）與 `POST /api/admin/safety/:id/reject`（**僅 pending 可不通過**，approved 要移除請走里民自行退出；body `{ reason }` 選填 ≤ 200 字、rejected 可再改 reason 維持 rejected）
  - 里民端 `/api/safety/join` 改為送出申請：approved 未退出 → 409 已加入；pending → 409 審核中；rejected／已退出／無列 → 同一列寫成 pending（更新表單資料、`applied_at` 重置、清 `reviewed_*`/`reject_reason`；已退出者清 `left_at` 與殘留暫停）；**pending 期間不可改資料（`PATCH /api/safety/profile` 與 `DELETE /api/safety/membership` 均回 403/400 擋下）、不可撤回**；出生年 `birth_year int` 選填（1900 ≤ 值 ≤ 今年）
  - 管理端（liff.html 盾牌 + admin.html 電腦版同步）：chips 加「待審核」；pending 列顯示 sky「待審核」badge、未簽天數與最後簽到顯示「—」、稱呼後綴「（YYYY 年生）」、最後簽到欄改顯示申請時間；詳情頁 pending 顯示「審核申請」卡（核准／不通過＋原因 textarea），pending 時「標記關懷」與「暫不提醒幹部」皆唯讀隱藏；核准/不通過後重抓詳情與列表同步計數
  - 新增欄位（migration `007_safety_approval.sql`，已於 Supabase 執行）：`safety_members` 加 `approval_status text NOT NULL DEFAULT 'pending'`（CHECK 三值；**既有列 migration 內一律 backfill 為 `approved`**，行為不變）、`applied_at timestamptz NOT NULL DEFAULT now()`、`reviewed_at timestamptz`、`reviewed_by text`、`birth_year int`、`reject_reason text`

---

## 4. 重要架構規則（必須遵守）

1. **身分驗證**
   - 前端使用 `liff.getIDToken()` 取得 token
   - 請求時放在 Header：`Authorization: Bearer <ID_TOKEN>`
   - 後端呼叫 LINE 官方 verify API 驗證
   - 以驗證後的 `sub` 作為唯一可信的 `line_user_id`
   - **絕對不信任**前端 body 傳來的 `line_user_id`

2. **照片上傳流程**
   - 前端先壓縮成 webp
   - 呼叫 `POST /api/feedback/upload-urls` 取得 signed upload URL
   - 前端用 PUT 直傳 Storage
   - 再呼叫 `POST /api/feedback` 建立許願並關聯照片

3. **權限**
   - 里民只能查看自己的許願
   - Service Role Key 只存在後端，不可暴露到前端
   - 管理員 API（`/api/admin/*`）必須通過 LINE ID Token 驗證 + `ADMIN_LINE_USER_IDS` 白名單雙重檢查
   - 非管理員呼叫管理 API 會收到 403，前端管理入口對非管理員完全不可見

4. **開發原則**
   - 在現有架構上迭代，不要重寫整個專案
   - 保持現有視覺風格一致（暖白背景 + 白色卡片 + 紫色主色 + 柔和陰影，避免深色與螢光粉）
   - 重要變更需更新本 HANDOVER.md
   - 管理 API 與里民 API 路徑與權限必須完全分隔，不可混用
   - 圖文選單 deep-link 優先序：`location.search` → `location.hash` → `liff.permanentLink.createUrl()`；URL 無 tab 時**決不可**在 `liff.init()` 前預設顯示核心政見
   - 頁面資料載入遵循「進哪個 Tab 才載哪個」：platforms/wish/schedule 皆為第一次切到該 Tab 才打 API，並做快取；intro 以靜態為主，不觸發額外 API
   - 所有政見/行程封面、相簿、列表縮圖皆使用 `loading="lazy"`，非當前畫面不急著載

---

## 5. 主要檔案

| 檔案 | 說明 |
|------|------|
| `public/liff.html` | 前端主檔（里民端 + 手機管理端，幾乎所有 UI 與前端邏輯） |
| `public/admin.html` | 管理端電腦版（許願管理 + 報平安管理，LINE Login via 第二個 LIFF app） |
| `app.js` | 後端 API 與 LINE 身分驗證 |
| `schema.sql` / `supabase/migrations/` | 資料庫結構 |
| `.env` | 本機環境變數（不可提交 Git） |
| `.env.example` | 環境變數範本 |

---

## 6. 資料庫與 Storage

### 主要資料表
- `user_feedback`：許願主表
- `user_feedback_photos`：照片紀錄
- `user_feedback_status_logs`：狀態歷程
- `campaign_platforms`：核心政見
- `campaign_events`：競選行程主表（title/description/content/start_at/end_at/location/cover_image_path/video_url/rsvp_count/is_published）
- `campaign_event_photos`：行程相簿照片
- `event_rsvps`：行程報名紀錄（`UNIQUE(event_id, line_user_id)`）
- `safety_members`：報平安會員（`line_user_id` UNIQUE、`baseline_date` 起算日、`left_at` soft delete；重新加入重設 baseline_date；`admin_notify_snooze_until` 幹部通知暫停到期日，NULL=從未暫停；第四期審核欄位：`approval_status`〔CHECK：`pending`/`approved`/`rejected`，DEFAULT `pending`〕、`applied_at` 申請時間、`reviewed_at`/`reviewed_by` 審核時間與審核人、`birth_year` 出生年〔選填〕、`reject_reason` 不通過原因〔≤ 200 字，里民看得到〕）
- `safety_checkins`：每日簽到（`UNIQUE(member_id, checkin_date)`，一天一筆；CASCADE 刪除）
- `safety_care_logs`：關懷紀錄（`method` CHECK：`已電訪`/`已家訪`/`暫停幹部通知`、`note` 備註、`created_by` 管理員 LINE id；CASCADE 刪除）
- `safety_notification_logs`：報平安通知發送紀錄（`notify_type` CHECK：`resident_same_day`/`admin_care`、`UNIQUE(notify_type, line_user_id, notify_date)` 冪等；**成功才寫**；不 FK `safety_members`，管理員收件人不一定是會員）

> 報平安 schema 詳見 `supabase/migrations/004_safety_schema.sql`、通知紀錄表詳見 `005_safety_notifications.sql`、暫停欄位詳見 `006_safety_snooze.sql`、申請審核欄位詳見 `007_safety_approval.sql`（皆已於 Supabase 執行）

### 狀態值
`已收到` / `處理中` / `已回覆` / `已結案`

### Storage
- Bucket 名稱：`wish-photos`（private）— 路徑格式 `{line_user_id}/{feedback_id 或 temp}/{uuid}.webp`
- Bucket 名稱：`platform-covers`（private）— 政見封面
- Bucket 名稱：`event-covers`（private）— 行程封面，路徑格式 `{event_id}/{uuid}.webp`

---

## 7. 主要 API

### 里民端 API

所有以下 API 都需要 `Authorization: Bearer <LIFF_ID_TOKEN>`：

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/feedback/upload-urls` | 取得照片上傳用 signed URL |
| POST | `/api/feedback` | 建立許願（含照片關聯） |
| GET | `/api/my-feedback` | 我的許願列表 |
| GET | `/api/my-feedback/:id` | 我的許願詳情（含照片 signed URL、狀態時間軸） |
| GET | `/api/events` | 公開行程列表（`is_published = true`），回傳 `{ next, upcoming, past }` |
| GET | `/api/events/:id` | 單筆行程詳情（含封面 signed URL、相簿 signed URL、`my_rsvp`） |
| POST | `/api/events/:id/rsvp` | 報名行程（已結束 `start_at < now` 擋新增） |
| DELETE | `/api/events/:id/rsvp` | 取消報名（**不擋已結束**） |
| GET | `/api/safety/status` | 我的報平安狀態（joined、`approval_status`〔null/pending/rejected/approved，前端據此切四態〕、rejected 時附 `reject_reason`、今日是否已簽、上次簽到日、approved 時另附 `streak` 連續簽到天數〔後端現算，今日未簽 = 0〕） |
| POST | `/api/safety/join` | 送出加入申請（第四期：新申請/重新申請寫成 `pending`；已 approved → 409 已加入、pending → 409 審核中；出生年選填 1900–今年） |
| PATCH | `/api/safety/profile` | 修改稱呼/本人電話/緊急聯絡人（**僅 approved**；pending 回 403） |
| POST | `/api/safety/checkin` | 今日簽到（**冪等**：同日再按回 200 不重複計次；**僅 approved**，pending/rejected 回 403；成功 payload 一律帶更新後的 `streak`） |
| DELETE | `/api/safety/membership` | 退出報平安（soft delete，簽到歷史保留；**僅 approved**，pending/rejected 回 403 無需退出） |

### 管理員端 API（許願池後台管理）

所有 `/api/admin/*` API 都需要 `Authorization: Bearer <LIFF_ID_TOKEN>`，且 `sub` 必須在 `ADMIN_LINE_USER_IDS` 白名單內，否則回傳 403：

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/admin/me` | 回傳 `{ is_admin }` 供前端判斷是否顯示管理入口 |
| GET | `/api/admin/feedback` | 全部許願列表，支援 `status` / `q` / `limit` / `offset`，並回傳各狀態計數 |
| GET | `/api/admin/feedback/:id` | 單筆許願詳情（含照片 signed read URL、`status_logs` 含 `changed_by`、`reply_summary`） |
| PATCH | `/api/admin/feedback/:id` | 變更狀態與/或回覆，body `{ status, reply_summary }`，自動寫入一筆狀態歷程（`changed_by` = 管理員 LINE user id） |
| DELETE | `/api/admin/feedback/:id` | 刪除單筆許願（requireAdmin；刪前確認存在；CASCADE 刪 photos/status_logs 並移除 Storage `wish-photos` 檔案） |
| GET | `/api/admin/platforms` | 全部政見列表（含未上架），含封面 signed read URL |
| GET | `/api/admin/platforms/:id` | 單筆政見完整資料 |
| PATCH | `/api/admin/platforms/:id` | 更新標題/分類/摘要/內文/排序/主打/上架；設新主打時自動取消其他主打 |
| POST | `/api/admin/platforms/:id/cover-upload-url` | 取得封面 signed upload URL |
| PATCH | `/api/admin/platforms/:id/cover` | 回寫封面 storage_path（上傳後呼叫，自動刪舊封面） |
| DELETE | `/api/admin/platforms/:id/cover` | 刪除封面圖 |
| GET | `/api/admin/events` | 全部行程列表（含未上架），含封面 signed URL |
| GET | `/api/admin/events/:id` | 單筆行程完整資料（含封面、相簿 signed URL） |
| POST | `/api/admin/events` | 新增行程（最小 payload 建立未上架草稿） |
| PATCH | `/api/admin/events/:id` | 更新標題/description/content/start_at/end_at/location/video_url/is_published |
| DELETE | `/api/admin/events/:id` | 刪除行程（一併移除封面、相簿、報名紀錄） |
| POST | `/api/admin/events/:id/cover-upload-url` | 取得封面 signed upload URL |
| PATCH | `/api/admin/events/:id/cover` | 回寫封面 storage_path（自動刪舊封面） |
| DELETE | `/api/admin/events/:id/cover` | 刪除封面 |
| POST | `/api/admin/events/:id/album-upload-url` | 取得相簿照片 signed upload URL |
| POST | `/api/admin/events/:id/album` | 回寫相簿照片 storage_path |
| DELETE | `/api/admin/events/:id/album/:photoId` | 刪除單張相簿照片 |
| POST | `/api/admin/events/:id/notify-rsvp` | 發訊給已報名里民（文案後端寫死） |
| POST | `/api/admin/events/:id/notify-wish-pool` | 發訊給許願池里民（文案後端寫死） |
| GET | `/api/admin/safety` | 報平安名單（活躍會員），支援 `filter=all/pending/checked/unchecked/care`，回傳各組計數與 derived 欄位（checked_in_today / missing_days / needs_care / latest_care；pending 成員 missing_days 為 0、needs_care 恆 false） |
| GET | `/api/admin/safety/:id` | 單筆詳情（會員資料 + 審核欄位 + 近期簽到紀錄 + 完整關懷歷史） |
| POST | `/api/admin/safety/:id/care` | 標記關懷，body `{ method: '已電訪'\|'已家訪', note }`（**僅 approved**，否則 400） |
| POST | `/api/admin/safety/:id/approve` | 核准加入申請（第四期；pending/rejected → approved，重設 `baseline_date` 為核准當天、清 `reject_reason` 與殘留暫停；已 approved 冪等回 200） |
| POST | `/api/admin/safety/:id/reject` | 不通過申請（第四期；**僅 pending**，approved 回 400；body `{ reason }` 選填 ≤ 200 字） |

### 排程任務 API（Cron）

`/api/cron/*` **不走 LINE ID Token**，改用 `Authorization: Bearer <CRON_SECRET>` 驗證（`CRON_SECRET` 未設定回 503、錯誤回 401）：

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/cron/safety-reminders/resident` | 台北每天 20:00 催本人（Vercel Cron 用；**Cron 不保留 query string，故 cron 路徑一律用路徑區分**） |
| GET | `/api/cron/safety-reminders/admin` | 台北每天 09:00 通知幹部待關懷（Vercel Cron 用） |
| GET | `/api/cron/safety-reminders?type=resident\|admin` | 同上功能，本機 curl 測試用（保留） |
| POST | `/api/cron/safety-reminders` | 同上，body `{ type }`，本機 curl 測試用（保留） |

---

## 8. 部署與環境變數

### GitHub
- 倉庫：`zhengsha2026-lgtm/zhengsha`
- 主分支：`main`

### Vercel
- 專案名稱：`zhengsha`
- 已設定 Git 整合，push 到 main 後應自動部署

### 必要環境變數（Vercel 與本機 .env 都要有）
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`（僅後端）
- `LINE_LOGIN_CHANNEL_ID`
- `ADMIN_LINE_USER_IDS`（逗號分隔多個 LINE user id，即 LINE verify API 回傳的 `sub`；管理員從 LIFF 登入後可從 `user_feedback.line_user_id` 或後端 log 查得自己的 sub）
- `ADMIN_LIFF_ID`（管理端電腦版用的第二個 LIFF app ID，Endpoint URL = `https://zhengsha.vercel.app/admin.html`，與里民 LIFF 同一個 LINE Login 頻道；记得也把該網址加入頻道 Callback URL）
- `CRON_SECRET`（報平安排程通知的 Bearer token，亂數字串如 `openssl rand -hex 32`；Vercel Cron 呼叫 `/api/cron/*` 時自動帶 `Authorization: Bearer <CRON_SECRET>`；未設定 = 排程停用）
- 以及其他既有的 LINE / LIFF 相關變數

### Vercel Cron（已寫進 `vercel.json`，部署即生效）
- `0 12 * * *` UTC（= 台北 20:00）→ `GET /api/cron/safety-reminders/resident`：催本人
- `0 1 * * *` UTC（= 台北 09:00）→ `GET /api/cron/safety-reminders/admin`：通知幹部
- **教訓：Vercel Cron 不保留 query string**（Dashboard Logs 只會看到路徑），cron 端點一律用路徑參數，不靠 `?type=`
- Hobby 方案上限 2 個 cron jobs（每天各一次），目前已用滿；執行紀錄可在 Vercel Dashboard → Deployments → Cron Jobs 查看

> `.env` 只存在本機，禁止提交到 GitHub。

---

## 8.1 許願池後台管理運作說明

### 管理員白名單設定
1. 在 LINE Developers 開 LIFF 與 LINE Login 頻道（已存在）
2. 管理員先以一般 LIFF 流程登入應用並送出一筆測試許願
3. 至 Supabase Dashboard → `user_feedback` 表 → 複製自己的 `line_user_id`（即 LINE 的 `sub`）
4. 將此 id 加入 Vercel 與本機 `.env` 的 `ADMIN_LINE_USER_IDS`（多個以逗號分隔）
5. 重新部署後，該 LINE 帳號再次開啟 LIFF 時，header 右上角會自動出現盾牌管理圖示

### 前端管理入口的運作邏輯
- `bootstrap()` → `initializeIdentity()` 完成後，再呼叫 `checkAdminIdentity()`
- `checkAdminIdentity()` 內部呼叫 `GET /api/admin/me`：
  - 200 + `is_admin: true` → 顯示 header 右上角管理圖示
  - 403（非管理員或白名單未設定）→ 靜默隱藏管理圖示
  - 401（未登入）→ 靜默隱藏管理圖示
- 底部導覽永遠維持 4 個 Tab，不再動態切換 grid-cols
- 點 header 圖示 → `switchTab('admin')` → 顯示 adminPanel → `switchAdminView('home')`
- 管理首頁有四個模組卡：許願管理（可用）、政見管理（可用）、行程管理（可用）、報平安（可用）
- 許願管理流程：管理首頁 → 許願列表（返回管理首頁）→ 詳情處理（返回列表）
- 政見管理流程：管理首頁 → 政見列表（返回管理首頁，可上移/下移/設主打/進入編輯）→ 編輯頁（返回列表）
- 行程管理流程：管理首頁 → 行程列表（返回管理首頁，可新增/編輯/刪除）→ 編輯頁（返回列表，封面/相簿/時間/影片/文案/上架/通知；**封面/相簿上傳後只更新自己那塊 DOM，不會清空其他已填欄位**）
- 報平安流程：管理首頁 → 簽到名單（返回管理首頁；篩選 chips 全部/今日已簽/今日未簽/待關懷、可一鍵標記已電訪/已家訪）→ 詳情頁（返回名單；完整關懷歷史 + 近期簽到 + 補備註標記關懷）
- 行程通知兩顆手動按鈕：`notify-rsvp`（已報名里民）、`notify-wish-pool`（許願池里民），不會自動發，會消耗 LINE 官方帳號推播則數
- 行程時間 24 小時制統一顯示；編輯頁 `datetime-local` 之下另附 `YYYY/MM/DD HH:mm` 文字；**結束時間必須晚於開始時間，前後端雙重檢查**
- 若 URL 帶有 `?tab=admin` 且確認為管理員，自動切換到管理面板
- 若 URL 帶有 `?tab=admin` 但非管理員，自動導回 `platforms`
- 非管理員無法透過任何方式（包含手動切換）進入管理面板：`switchTab('admin')` 會被導回 `platforms`

---

## 9. 目前已知狀態與下一步

### 已完成
- 許願送出（含照片）
- 我的許願列表與詳情
- LINE ID Token 身分驗證
- 基本部署流程
- 里民端許願 UI 優化：移除「使用者識別」標題、隱私說明改「？」彈窗、我的許願詳情改顯示完整處理時間軸（修正欄位對齊 `status_timeline` / `changed_at`）
- **許願池後台管理**（第一階段）
  - 管理員 LINE 白名單驗證
  - 管理入口：header 右上角盾牌圖示（僅管理員可見），底部永遠 4 個 Tab
  - 管理首頁：模組列表（許願管理可用、政見管理可用、行程管理可用）
  - 許願管理子頁：列表（含狀態 chips 計數、搜尋、分頁）+ 詳情（照片 signed URL、處理歷程時間軸、狀態變更/回覆填寫、自動寫入 `changed_by`）
  - **刪除案件**：詳情頁危險區「刪除此許願」，確認視窗顯示編號／申請人／內容摘要（前 40 字）；`DELETE /api/admin/feedback/:id`（requireAdmin）會刪 `user_feedback` 主表（`user_feedback_photos`、`user_feedback_status_logs` 依 CASCADE 一併刪）並清除 Storage `wish-photos` 對應檔案；成功後回管理列表並重抓；失敗 toast 顯示原因。里民端無刪除入口
- **核心政見改版**
  - 里民端：單欄主打卡（`is_featured`，16:9 封面 + 摘要 + 支持數）+ 其餘左圖右文卡；沒圖用 `theme_color` + `icon` fallback；詳情 modal 頂部加封面圖
  - 管理端：政見管理列表（封面縮圖、排序上移/下移、設為主打）+ 編輯頁（封面上傳/更換/刪除、文案、主打、上架）
  - 新增欄位：`summary`, `content`, `cover_image_path`, `is_featured`, `is_published`
  - 新增 Storage bucket：`platform-covers`（private，RLS 拒絕 anon/authenticated）
  - 政見管理 API：list / detail / patch / cover-upload-url / cover patch / cover delete
- **競選行程模組（已上線）**
  - 里民端：底部第 4 個 Tab「競選行程」；主打 hero 卡（`upcoming` 第一筆，列表不重複）+ 即將到來/過往足跡分組（兩者只看 `start_at`）+ 詳情 modal（16:9 封面 contain 預覽、`description` 為列表摘要、`content` 為完整內文）+ 相簿縮圖 + 影片外連 + 報名/取消（已結束 `start_at < now` 擋**新**報名、不擋取消報名）
  - 管理端：管理首頁「行程管理」已可用；行程列表（標題/時間/上架/報名人數）+ 編輯頁（標題、description/content、start_at/end_at 結束必須晚於開始前後端都查、location、video_url、封面、相簿、is_published 上架、刪除）
  - LINE 通知：兩顆管理員手動按鈕（`notify-rsvp` 提醒已報名者、`notify-wish-pool` 通知曾使用許願池的里民）；上架**不會自動群發**；文案後端寫死；會消耗 LINE 官方帳號推播則數
  - 行程時間：畫面顯示統一 `YYYY/MM/DD HH:mm`（24 小時制，小時補零）；編輯頁 `datetime-local` 系統挑選器可能仍是 12 小時，下方另附 24 小時制文字避免誤判
  - 上傳封面 / 相簿成功後只更新該區塊 DOM，不清空 title/description/content/時間/地點/影片/上架等已填欄位
  - 新增資料表：`campaign_events`、`campaign_event_photos`、`event_rsvps`（`UNIQUE(event_id, line_user_id)`）
  - 新增 Storage bucket：`event-covers`（private，RLS 拒絕 anon/authenticated）
  - 行程 API：里民 list/detail/rsvp join/rsvp cancel；管理 list/detail/create/patch/delete/cover/album/notify-rsvp/notify-wish-pool
- **LIFF 啟動與載入速度優化（防閃政見 + 分頁載入）**
  - 圖文選單網址：`https://liff.line.me/{LIFF_ID}?tab=platforms|intro|wish|schedule|safety`（search 或 hash 兩種都支援）
  - HTML 預設 4 個底部 Tab panel 全部 `hidden`；頁面解析到 `</nav>` 後立即執行一段 inline script，先以 search+hash 命中的 tab 開啟對應頁面，**若沒讀到 tab 就全部保持 hidden，不落回 platforms**
  - `liff.init()` 成功後再解析一次：來源優先序 `location.search` → `location.hash` → `liff.permanentLink.createUrl()`（圖文選單參數常藏在這），最後才 fallback platforms
  - 深度連結非政見 tab 時，第一眼不再出現核心政見列表或政見骨架
  - **啟動頁（splash）**：`<body>` 開頭純 CSS 啟動頁（`#appSplash`，頭像 + 名稱 + spinner + 「載入中…」，z-70 蓋全頁不透明），不依賴 Tailwind/Lucide/主 script，HTML 一落地即顯示；`bootstrap()` 中 `liff.init` + 初始 Tab 解析 + `checkAdminIdentity()` 完成後呼叫 `window.__zhengshaDismissSplash()` 淡出移除；inline script 掛 **8 秒保險絲** `setTimeout`，超時強制進頁（若面板全 hidden 緊急顯示 platforms）
  - 進哪個 Tab 才載該 Tab API：platforms/wish/schedule/safety 第一次進去時載入並快取，切回來不重抓；intro 以靜態為主
  - 政見封面、行程封面、相簿、管理列表縮圖：全部 `loading="lazy"`
- **報平安模組（已上線；?tab=safety 獨立頁）**
  - 里民端：未加入（說明 + 加入表單：稱呼/本人電話/緊急聯絡人；稱呼預填 LINE 顯示名稱、電話預填許願池 localStorage，皆可改）/ 已加入（大顆「我今天平安」簽到鈕、冪等、設定摺疊編輯、退出 soft delete）兩種畫面；底部導覽維持 4 Tab 不變，safety 僅 deep-link 進入
  - 管理端：管理首頁第 4 張模組卡「報平安」→ 名單（四組篩選 chips 含計數、待關懷優先排序、顯示本人與緊急聯絡人電話、一鍵標記關懷）→ 詳情（完整關懷歷史 + 近期簽到 + 補備註關懷）
  - 後端規則：台灣時區後端算今天、`UNIQUE(member_id, checkin_date)` 一天一筆、簽到冪等、missing_days = 今天 − max(最後簽到日, baseline_date)、待關懷 = 活躍且今日未簽且 missing_days ≥ 3（`SAFETY_CARE_MISSING_DAYS`，2026-09-12 起；原為 ≥ 2，週一簽→週四早才通知幹部）、重新加入重設 baseline_date、退出為 soft delete
  - 新增資料表（migration `004_safety_schema.sql`，已於 Supabase 執行）：`safety_members` / `safety_checkins` / `safety_care_logs`
  - API：里民 status/join/profile/checkin/membership（DELETE）；管理 list/detail/care/snooze
- **報平安第二期：排程通知（已上線；Vercel Cron）**
  - `GET /api/cron/safety-reminders/:type`（**Cron 用路徑式** — Vercel Cron 不保留 query string）＋ 舊 `?type=`／POST body 端點保留手動測試；`Bearer <CRON_SECRET>` 驗證（未設 503、錯誤 401）
  - 台北 20:00 催本人（活躍且今日未簽，含當日新加入；文案固定 + `?tab=safety` 連結）；台北 09:00 通知幹部（待關懷人數 + 前 3 筆稱呼 + `?tab=admin` 連結，沒有待關懷不發）
  - 冪等 `safety_notification_logs`（UNIQUE 類型+人+日期，成功才寫）；push 失敗不阻塞、家人永不通知
  - 新增資料表（migration `005_safety_notifications.sql`，已於 Supabase 執行）；`vercel.json` 已加 crons、`.env.example` 已加 `CRON_SECRET`；簽到/加入/退出/待關懷計算零修改
  - 電腦版 admin.html **本期未動**（報平安僅手機 LIFF）
- **報平安第三期：「暫不提醒幹部」（已上線）**
  - `POST /api/admin/safety/:id/snooze`：天數後端寫死 3 天（`SAFETY_SNOOZE_DAYS` 常數），不收前端參數；`snooze_until = 當天+3`，`>= 今天` 即暫停中，到期日當天仍暫停、隔天早上幹部推播自動恢復；要再停必須再按一次，無取消暫停功能
  - 暫停只關閉：待關懷篩選（`needs_care=false`，chip 計數/排序/早上幹部推播都不含）；**晚間催本人照常發**、`missing_days` 照算、名單仍顯示 + amber「通知暫停至 YYYY/MM/DD」chip；電訪/家訪不自動暫停
  - 關懷歷史自動寫 `method='暫停幹部通知'`、`note='至 YYYY/MM/DD（3 天）'`；實作改動集中在 `buildSafetyAdminItem`（+snooze 條件與兩個回傳欄位）與 3 個 select 欄位清單，**簽到/加入/退出/晚間催本人邏輯零修改**
  - migration `006_safety_snooze.sql`（已於 Supabase 執行）：`safety_members.admin_notify_snooze_until date` + `safety_care_logs` method CHECK 放寬三值（DO block 重建）
  - 驗證：單元測試 11/11（+3 跨月/跨年/閏年、到期日當天仍暫停、過期自動恢復、missing_days 不受影響）；新端點無/假 token 401、既有端點回歸 401；liff.html 全部 inline script 語法檢查通過；電腦版 admin.html 本期未動
- **管理端電腦版第二期：報平安管理（已上線，僅改 public/admin.html，後端零修改）**
  - 頂部模組導覽：許願池 | 報平安（segmented tabs，預留政見/行程）；報平安第一次切換才打 API
  - 列表：四組篩選 chips 含計數（暫停中不計入待關懷，後端保證）+ 表格（稱呼/狀態/未簽天數/里民電話/聯絡人/最後簽到/暫停至）+「更新」手動重抓；暫停中的人列上仍顯示（amber 暫停中 chip + 暫停至日期）
  - 詳情（雙欄 3:2）：左欄關懷歷史時間軸（三種 method 徽章）+ 近期簽到 30 筆；右欄會員資訊（里民/聯絡人電話一鍵複製、未簽天數、加入日、最後簽到）+ 標記關懷（已電訪/已家訪 + 備註 ≤200 字）+ 幹部通知卡（暫不提醒幹部 3 天按鈕，confirm 後打 snooze API；暫停中隱藏按鈕顯示到期日）
  - 暫停語義與手機版一致：只關待關懷篩選與早上幹部推播、晚間催本人照常、電訪/家訪不自動暫停、未簽天數照算；已退出會員只可看不可操作（前後端雙重擋）
  - 不做：刪除會員、通知家人、電腦版里民簽到；inline script 語法檢查通過
  - 後續修正（commit `f09f1cf`）：登入／驗證中畫面標題統一「管理後台」；模組分頁切換事件綁定補齊；許願狀態 chips 計數改用 API 回傳**全域 `counts`**（不隨篩選/搜尋/分頁變動）、分頁總數改讀 `data.pagination.total_count`（原誤讀不存在的 `data.total`，會讓「全部」chip 數字跟著篩選跑）
  - 後續修正（commit `21edb59`）：報平安稱呼與許願里民姓名過長時 `max-w-[12rem] truncate` 單行省略 + hover `title` 顯示全名，不再擠壓後方欄位；詳情頁仍顯示完整名稱
- **報平安第四期：「申請＋核准」制（已上線）**
  - 里民端四態：未加入/未通過（表單 + 出生年選填）/ 審核中（不可簽到改資料撤回）/ 已加入（既有行為）；未通過顯示原因可重新申請
  - 管理端（手機 liff.html + 電腦 admin.html 同步）：chips 加「待審核」、pending 列待審核 badge + 申請時間、詳情審核卡（核准/不通過＋原因）、pending 時關懷/暫停唯讀
  - 後端：`POST /api/admin/safety/:id/approve`（pending/rejected → approved、`baseline_date` 重設核准當天、清 reject_reason 與殘留暫停、冪等）與 `POST /api/admin/safety/:id/reject`（僅 pending、reason ≤ 200 字）；裡民 join 改送申請、profile/checkin/membership/care/snooze/兩個 cron 全部加 approved 閘門
  - migration `007_safety_approval.sql`（已於 Supabase 執行）：`safety_members` 加 6 欄（`approval_status` CHECK 三值 DEFAULT `pending`、既有列 backfill `approved`、`applied_at`、`reviewed_at`、`reviewed_by`、`birth_year int`、`reject_reason`）
  - 驗證：`node --check app.js` 通過；admin.html/liff.html 全部 inline script 語法檢查通過（檢查器需先剝除 HTML 註解，否則註解內 `<script>` 字樣會誤判）
- **政見詳情視窗動畫：底部位板升起／收起（已上線）**
  - 只動 `#platformModal`：HTML 加 `platform-modal-anim`；CSS 用 transition（非 keyframes，中途打斷不跳位）——遮罩淡入 300ms ease-out、卡片 `translateY(100vh)→0` 420ms ease-out；關閉 380ms ease-in 滑回螢幕下緣後才 `hidden`
  - `#platformModal .glass-modal` 覆寫 `animation: none`（停用共用的 `modal-in`，避免 transform 打架）；行程／隱私等其他 modal 不受影響
  - `renderPlatformModal` 僅 `wasHidden` 時觸發升起（詳情 API 回來的原地重繪不重播動畫，避免閃爍）；`closePlatformModal` 用 `platformModalCloseTimer` 擋重複關閉（X／遮罩／ESC 連點），支援收起中途折返（自動取消動畫滑回）
  - 支援 `prefers-reduced-motion`；政見內容、支持按鈕、封面、API、底部 4 Tab 全未動
- **政見詳情封面閃爍修復（已上線）**
  - 現象：點卡升起時封面已在，詳情 API 回來整卡重繪把 img 節點銷毀重載 → 封面「出現→空白→再載入」
  - 修復（`renderPlatformModal`，改法 A 非破壞式更新）：封面以**去 query 的路徑**（`new URL(src).pathname`）比對——詳情 API 的 signed URL 每次 token 都不同，同一張圖不動 img 節點，真的換圖才重建；圖示以 signature 比對不重複重建；標題／正文／支持數維持 textContent 更新。`openPlatformModal` 的「快取先畫骨架 → 詳情補文字」流程與 API 契約未動
- **政見詳情關閉按鈕樣式改善 + 頁面大標文案更新（已上線）**
  - 關閉鈕（`#closeModalButton`，僅 #platformModal）：32→**44px**（`h-11 w-11`＋flex 置中、`shrink-0` 防壓縮）、X 圖示 `h-5 w-5` 深紫 `text-violet-950`（原淡灰）、`bg-white/95`＋`ring-1 ring-violet-200/80` 細紫邊＋`shadow-md` 輕陰影；hover `bg-violet-50` 微加深、`active:scale-95` 按下輕縮；位置維持標題列右側（封面與標題列交界）；行程／隱私等其他 modal 關閉鈕未動
  - 核心政見頁大標（liff.html 唯一一處，DB 的 title/content 未動）：改為「以超高的執行力，落實每一件重要的事」
- **顯示名稱改版：許願池 → 有事找里長（已上線）**
  - 只改人看得到的中文文案；API 路徑／資料表／`?tab=wish`／bucket `wish-photos`／程式碼識別字（wish、feedback）全部不變，無 migration
  - 裡民端（liff.html）：底部 Tab「有事找里長」、面板標籤與分段「我要反映／我的案件」、送出中／成功橫幅／toast、三組空狀態文案、詳情「里民心聲」標籤里民端保留
  - 管理端：liff 盾牌模組名「反映管理」＋詳情內容標籤「反映內容」；admin.html header／模組分頁「有事找里長」＋列表欄位「反映內容」＋空狀態與刪除文案
  - 後端訊息（app.js）：feedback 相關 API 回傳 message 全部改「反映」用語；行程通知按鈕與相關訊息改「通知曾反映過的里民」；邀請文案（webhook 預設回覆）改「有事找里長」表單
  - LINE webhook 關鍵字：新增「找里長」「有事找里長」，舊「許願池」「表單」保留可用

### 仍可優化 / 尚未完成
- 管理端電腦版**第三期**：政見管理、行程管理的電腦版（已有許願管理與報平安管理）
- 報平安排程通知的**推播則數成本監控**（每日 20:00 催本人會消耗官方帳號推播額度，人數多時需留意；Hobby 方案 cron 2 jobs/天上限已用滿）
- 許願案件狀態變更後的 **LINE 主動通知里民**（推播進度）尚未做
- 後台管理的進階功能：批次變更狀態、匯出 CSV、依日期區間篩選
- 後台管理員身分的**動態新增/移除**（目前需改環境變數重新部署）
- 政見的新增/刪除功能（目前只能編輯既有的 8 筆）
- 行程通知現為手動觸發（notify-rsvp / notify-wish-pool），未來可視需求加行程上架/即將到來前自動提醒（需注意 LINE 官方帳號推播則數成本）

---

## 10. 新開發者（含 AI）接手流程

1. 先完整閱讀本 `HANDOVER.md`
2. 閱讀 `app.js` 與 `public/liff.html` 的現有實作
3. 向使用者確認你理解的現況
4. 等待使用者指定下一個任務後再開始修改
5. 完成一個階段後，更新本 HANDOVER.md 的「已完成」與「下一步」

**禁止**：在未理解現況前重寫專案或大幅重構。
