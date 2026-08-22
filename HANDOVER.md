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
| 檔案儲存 | Supabase Storage（private bucket: `wish-photos`） |
| 身分驗證 | LINE LIFF ID Token（後端驗證） |
| 管理員驗證 | LINE 白名單（環境變數 `ADMIN_LINE_USER_IDS`） |
| 部署 | GitHub → Vercel 自動部署 |

---

## 3. 目前已完成的功能

### 頁面
- 核心政見
- 候選人介紹
- 里民許願池（表單）
- 我的許願（列表 + 詳情）
- 競選行程（目前仍為「規劃中」狀態）

### 許願相關（重點）
- 里民可填寫並送出許願
- 支援上傳最多 **3 張照片**
- 前端壓縮為 webp 後，透過 signed URL 直傳 Supabase Storage
- 送出後寫入狀態「已收到」
- 「我的許願」可查看自己的歷史許願、照片、**完整處理時間軸**（對齊後端 `status_timeline` / `changed_at`）
- 所有相關 API 都需驗證 LINE ID Token
- 許願表單上方使用者卡片：移除「使用者識別」標題，隱私說明改為「？」彈窗（不佔大塊版面）

### 許願池後台管理（管理員專用）
- 管理員 LINE 白名單驗證（環境變數 `ADMIN_LINE_USER_IDS`）
- 前端 LIFF 登入後呼叫 `/api/admin/me` 判斷是否為管理員
- 管理員可見底部導覽第 5 個「管理」Tab；非管理員完全看不到
- 許願列表頁：狀態 chips（全部/已收到/處理中/已回覆/已結案，含計數）、搜尋（姓名/電話/內容）、分頁
- 許願詳情頁：案件摘要、里民資訊（含複製電話/撥打）、完整內容、照片、目前回覆、操作區（狀態變更 + 回覆填寫 + 儲存）、處理歷程時間軸
- 變更狀態或回覆後，自動新增一筆 `user_feedback_status_logs`，`changed_by` 填入管理員 LINE user id
- 儲存成功後自動同步詳情與列表計數
- 管理 API 與里民 API 路徑與權限完全分隔

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
   - 保持現有視覺風格一致
   - 重要變更需更新本 HANDOVER.md
   - 管理 API 與里民 API 路徑與權限必須完全分隔，不可混用

---

## 5. 主要檔案

| 檔案 | 說明 |
|------|------|
| `public/liff.html` | 前端主檔（幾乎所有 UI 與前端邏輯） |
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

### 狀態值
`已收到` / `處理中` / `已回覆` / `已結案`

### Storage
- Bucket 名稱：`wish-photos`（private）
- 路徑格式：`{line_user_id}/{feedback_id 或 temp}/{uuid}.webp`

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

### 管理員端 API（許願池後台管理）

所有 `/api/admin/*` API 都需要 `Authorization: Bearer <LIFF_ID_TOKEN>`，且 `sub` 必須在 `ADMIN_LINE_USER_IDS` 白名單內，否則回傳 403：

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/admin/me` | 回傳 `{ is_admin }` 供前端判斷是否顯示管理入口 |
| GET | `/api/admin/feedback` | 全部許願列表，支援 `status` / `q` / `limit` / `offset`，並回傳各狀態計數 |
| GET | `/api/admin/feedback/:id` | 單筆許願詳情（含照片 signed read URL、`status_logs` 含 `changed_by`、`reply_summary`） |
| PATCH | `/api/admin/feedback/:id` | 變更狀態與/或回覆，body `{ status, reply_summary }`，自動寫入一筆狀態歷程（`changed_by` = 管理員 LINE user id） |

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
- 以及其他既有的 LINE / LIFF 相關變數

> `.env` 只存在本機，禁止提交到 GitHub。

---

## 8.1 許願池後台管理運作說明

### 管理員白名單設定
1. 在 LINE Developers 開 LIFF 與 LINE Login 頻道（已存在）
2. 管理員先以一般 LIFF 流程登入應用並送出一筆測試許願
3. 至 Supabase Dashboard → `user_feedback` 表 → 複製自己的 `line_user_id`（即 LINE 的 `sub`）
4. 將此 id 加入 Vercel 與本機 `.env` 的 `ADMIN_LINE_USER_IDS`（多個以逗號分隔）
5. 重新部署後，該 LINE 帳號再次開啟 LIFF 時，底部會自動出現「管理」Tab

### 前端管理入口的運作邏輯
- `bootstrap()` → `initializeIdentity()` 完成後，再呼叫 `checkAdminIdentity()`
- `checkAdminIdentity()` 內部呼叫 `GET /api/admin/me`：
  - 200 + `is_admin: true` → 顯示管理 Tab、grid 由 4 欄變 5 欄
  - 403（非管理員或白名單未設定）→ 靜默隱藏管理 Tab，維持 4 欄
  - 401（未登入）→ 靜默隱藏管理 Tab
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
  - 全部許願列表（含狀態 chips 計數、搜尋、分頁）
  - 許願詳情（含照片 signed URL、處理歷程時間軸）
  - 狀態變更與回覆填寫（自動寫入 `changed_by`）
  - 前端動態管理入口（僅管理員可見）

### 仍可優化 / 尚未完成
- 競選行程頁仍為「規劃中」
- 核心政見互動深度可再加強
- 許願案件狀態變更後的 **LINE 主動通知里民**（推播進度）尚未做
- 後台管理的進階功能：批次變更狀態、匯出 CSV、依日期區間篩選
- 後台管理員身分的**動態新增/移除**（目前需改環境變數重新部署）

---

## 10. 新開發者（含 AI）接手流程

1. 先完整閱讀本 `HANDOVER.md`
2. 閱讀 `app.js` 與 `public/liff.html` 的現有實作
3. 向使用者確認你理解的現況
4. 等待使用者指定下一個任務後再開始修改
5. 完成一個階段後，更新本 HANDOVER.md 的「已完成」與「下一步」

**禁止**：在未理解現況前重寫專案或大幅重構。
