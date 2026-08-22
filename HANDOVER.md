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
- 「我的許願」可查看自己的歷史許願、狀態時間軸、照片
- 所有相關 API 都需驗證 LINE ID Token

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

4. **開發原則**
   - 在現有架構上迭代，不要重寫整個專案
   - 保持現有視覺風格一致
   - 重要變更需更新本 HANDOVER.md

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

所有以下 API 都需要 `Authorization: Bearer <LIFF_ID_TOKEN>`：

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/feedback/upload-urls` | 取得照片上傳用 signed URL |
| POST | `/api/feedback` | 建立許願（含照片關聯） |
| GET | `/api/my-feedback` | 我的許願列表 |
| GET | `/api/my-feedback/:id` | 我的許願詳情（含照片 signed URL、狀態時間軸） |

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
- 以及其他既有的 LINE / LIFF 相關變數

> `.env` 只存在本機，禁止提交到 GitHub。

---

## 9. 目前已知狀態與下一步

### 已完成
- 許願送出（含照片）
- 我的許願列表與詳情
- LINE ID Token 身分驗證
- 基本部署流程

### 仍可優化 / 尚未完成
- 競選行程頁仍為「規劃中」
- 核心政見互動深度可再加強
- 後台管理（狀態變更、回覆）尚未做
- 許願案件的正式處理流程與通知

---

## 10. 新開發者（含 AI）接手流程

1. 先完整閱讀本 `HANDOVER.md`
2. 閱讀 `app.js` 與 `public/liff.html` 的現有實作
3. 向使用者確認你理解的現況
4. 等待使用者指定下一個任務後再開始修改
5. 完成一個階段後，更新本 HANDOVER.md 的「已完成」與「下一步」

**禁止**：在未理解現況前重寫專案或大幅重構。
