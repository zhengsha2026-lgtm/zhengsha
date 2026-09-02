# HANDOVER.md
正砂里里長候選人 LIFF 應用 — 專案交接說明

> 任何新的開發者（人或 AI）請先完整閱讀本文件，再開始修改程式。  
> 以本文件與 GitHub 程式碼為準，不要依對話記憶自行假設。

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
- 核心政見（單欄主打卡 + 左圖右文卡，有封面圖、摘要、支持數）
- 候選人介紹（英雄區照片放大前置 + 真情信獨立主打卡 + 初心過渡 + 三張能力卡條列）
- 里民許願池（表單層次優化：身分卡縮為一列、切換加強、內容框為主體、送出鈕紫色）
- 我的許願列表（依狀態分組、卡片層次、時間精簡、身分列隱藏）
- 我的許願列表上方**進度篩選**（全部 / 處理中 / 已完成，與「我要許願／我的許願」同套 segmented control 視覺）：
  - 純前端過濾 `state.wish.list`，不打新 API；處理中 = `已收到`/`處理中`/`已回覆`，已完成 = `已結案`（含未來可能的 `已取消`）
  - 按鈕顯示筆數 `(N)`：列表**載入完成後**（`finally`、`loading=false` 之後）才重算；從未載入不顯示、載入中顯示 `—`（避免 `(0)` 誤導）
  - 空狀態依篩選顯示（「目前沒有處理中的許願」等）
- 我的許願（列表 + 詳情）
- 競選行程（里民端：主打 hero 卡 + 即將到來/過往足跡分組 + 詳情 modal + 16:9 封面與相簿 + 影片外連 + 報名/取消報名；管理端可看到報名人數）

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
- 沒封面圖時用 `theme_color` + `icon` 做 fallback 色塊
- 詳情 modal 頂部可顯示封面圖，全文改用 `content` 欄位（fallback `description`）
- 政見管理列表：封面縮圖、標題、分類、支持數、排序、主打標記；可上移/下移、設為主打、進入編輯
- 政見編輯頁：封面上傳（前端壓縮 WebP → signed URL 直傳）/更換/刪除、分類（subtitle）、標題、列表摘要、完整內容、是否主打、是否上架
- 設為主打時自動取消其他筆主打（partial unique index 保證唯一性）
- 排序交換：PATCH sort_order 時後端自動與佔用者交換
- `is_published = false` 的政見里民端不顯示

### 管理端電腦版（第一期：許願管理）
- **網址**：`https://zhengsha.vercel.app/admin.html`
- **登入方式**：電腦瀏覽器開啟後，透過**第二個 LIFF app**（`ADMIN_LIFF_ID`，與里民 LIFF 同一個 LINE Login 頻道）做 LINE Login（掃 QR 或用已登入的 LINE 帳號）
- **權限**：登入後打 `GET /api/admin/me` 檢查白名單（`ADMIN_LINE_USER_IDS`，後端以 LINE verify API 回傳的 `sub` 為準）；非白名單顯示「沒有管理權限」頁，**不會打任何會碰里民個資的 API**
- **功能**：許願列表（桌面表格：狀態 chips 含計數、搜尋、分頁）＋ 詳情（左右雙欄：案件內容/照片/時間軸 + 里民資訊/狀態變更/回覆填寫）＋ 儲存（自動寫 `status_logs`）＋ 刪除（二次確認，接 `DELETE /api/admin/feedback/:id`）
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
  - 網址格式：`https://liff.line.me/{LIFF_ID}?tab=platforms|intro|wish|schedule`（可用 search 或 hash 兩種）
  - 初始 Tab 規則：HTML 預設 4 個底部 Tab 的 panel 全部 `hidden`；**若 URL 讀不到 tab，不先顯示核心政見**
  - LIFF 啟動流程：頁面解析到 `</nav>` 時先用 inline script 把 search/hash 的 tab 提前打開（命中才顯示）；`liff.init()` 完成後再用 `location.search` → `location.hash` → `liff.permanentLink.createUrl()` 的順序重新解析一次，最後才 fallback platforms；目的是避免從 LINE 圖文選單進非政見頁時，**先閃核心政見再跳走**
  - 進哪個 Tab 才載該 Tab 的 API 資料（platforms/intro/wish/schedule），intro 以靜態為主，其餘 Tab 第一次進去時載入並快取，切回來不重抓
  - 政見封面、行程封面、相簿、管理列表縮圖全部 `loading="lazy"`，非當前 Tab 不急著載

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
| `public/admin.html` | 管理端電腦版（第一期：許願管理，LINE Login via 第二個 LIFF app） |
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
- 以及其他既有的 LINE / LIFF 相關變數

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
- 管理首頁有三個模組卡：許願管理（可用）、政見管理（可用）、行程管理（可用）
- 許願管理流程：管理首頁 → 許願列表（返回管理首頁）→ 詳情處理（返回列表）
- 政見管理流程：管理首頁 → 政見列表（返回管理首頁，可上移/下移/設主打/進入編輯）→ 編輯頁（返回列表）
- 行程管理流程：管理首頁 → 行程列表（返回管理首頁，可新增/編輯/刪除）→ 編輯頁（返回列表，封面/相簿/時間/影片/文案/上架/通知；**封面/相簿上傳後只更新自己那塊 DOM，不會清空其他已填欄位**）
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
  - 圖文選單網址：`https://liff.line.me/{LIFF_ID}?tab=platforms|intro|wish|schedule`（search 或 hash 兩種都支援）
  - HTML 預設 4 個底部 Tab panel 全部 `hidden`；頁面解析到 `</nav>` 後立即執行一段 inline script，先以 search+hash 命中的 tab 開啟對應頁面，**若沒讀到 tab 就全部保持 hidden，不落回 platforms**
  - `liff.init()` 成功後再解析一次：來源優先序 `location.search` → `location.hash` → `liff.permanentLink.createUrl()`（圖文選單參數常藏在這），最後才 fallback platforms
  - 深度連結非政見 tab 時，第一眼不再出現核心政見列表或政見骨架
  - 進哪個 Tab 才載該 Tab API：platforms/wish/schedule 第一次進去時載入並快取，切回來不重抓；intro 以靜態為主
  - 政見封面、行程封面、相簿、管理列表縮圖：全部 `loading="lazy"`

### 仍可優化 / 尚未完成
- 管理端電腦版**第二期**：政見管理、行程管理的電腦版（第一期只有許願管理）
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
