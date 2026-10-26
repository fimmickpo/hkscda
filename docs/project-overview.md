# HKSCDA 專案導覽

> 最後整理：2026-10-26
>
> 目的：給接手或協作的工程師一份「這個專案是什麼、怎麼運作、現在做到哪、先看什麼」的概覽。
>
> 依據：工作樹原始碼、`supabase/migrations/`、`docs/` 內的文件，以及 2026-10-26 實際抓取
> `https://hkscda.vercel.app` 與 `https://hkscda.com` 的結果。文中標示「文件記錄」的項目，
> 代表本次沒有重新向 production 驗證，只反映倉庫內文件的說法。
>
> **重要原則：文件與程式碼有落差時，以程式碼與 guard tests 為準。** 這個 repo 的許多規則
> 不是文件建議，而是由測試強制執行；請先看該 domain 的 `*Guard.test.ts`。

---

## 1. 一句話定位

HKSCDA（香港拯救貓狗協會）的網站重建專案：把舊官網重做成一個包含

- 公開網站（關於、領養、助養、捐款、義工、故事、知識、年報、FAQ）
- 四條完整服務流程（領養申請、助養承諾、捐款、義工報名／調期）
- 角色權限後台（動物、領養個案、義工、CRM、金流、贊助、CMS、治理、權限）

的單一 TanStack Start 應用，資料層使用 Supabase Postgres，部署目標為 Vercel。

這不是單純的宣傳頁，而是一個已經做到「可營運」雛形的內部系統；目前主要缺口在
**上線切換、金流開通、背景任務啟用、真實内容補齊與 owner UAT**，而不是功能從零開始。

---

## 2. 目前狀態（先看這個）

| 項目 | 觀察 | 依據 |
|---|---|---|
| 新站部署 | `hkscda.vercel.app` 跑的是這個 codebase，接專案文件標示的 production Supabase project（`iihqjzilgawhfdhdevam`） | 2026-10-26 實際抓取；公開動物相片 URL 指向該 project |
| 公開資料 | 約 100 隻待領養貓、108 隻待領養狗；文件記錄另有 115 隻助養動物 | 新站首頁；`docs/development-completion-evidence.md` |
| 域名切換 | `hkscda.com` 仍然是舊站（`/rescues`、`/news`、`/donation`、`/volunteer/apply` 等舊路由），新舊站並存 | 2026-10-26 實際抓取 |
| 網上捐款 | **閘門關閉**：`checkout_policy.enabled = false`；`/donate` 明示「網上捐款尚未完成正式啟用審批」，不顯示付款方式 | 新站 `/donate`；`20260927120000_checkout_policy_gate.sql` |
| 背景任務 | 7 個 Vercel cron 全部要求 `CRON_SECRET`；runbook 記錄 2026-10-08 production 從未真正跑過，最新義工文件（10/25）仍把 hosted 排程列為未驗證 | `docs/background-jobs-runbook.md`；`2026-10-25-volunteer-selective-retry.md` |
| Owner UAT | 文件記錄全部項目仍是 **NOT RUN** | `docs/development-owner-uat-status.md`（2026-09-06） |
| 公開內容 | 預覽站仍見「【示範】」故事與活動；`/report/adoption` 只顯示 1 宗累計成功領養；舊站顯示 1,926 已領養狗 | 2026-10-26 實際抓取 |
| 義工模組 | 目前最活躍的開發區域；hosted 事故 root cause 未證實，admin 重跑 hourly worker 的 RPC 仍是 `supabase/drafts/` 草稿，未進 migrations | `2026-10-25-volunteer-isolated-db-acceptance-report.md`、`supabase/drafts/` |
| 舊相／故事 | 文件記錄 234 張舊相缺失、92 段故事未審；未在本次重新驗證 | `docs/development-completion-evidence.md`（2026-09-07） |

**結論：** 新站已經在公開預覽運行，但尚未完成正式切換；捐款與背景任務尚未開通；
上線前必須先清掉 demo 內容、補齊可核實的歷史數字，並完成 owner UAT 與 production
設定核對。

---

## 3. 規模

| 指標 | 數量 |
|---|---|
| `src/` 行數 | 約 300,000 行 |
| 頁面路由檔 | 82 個（30 公開 + 51 後台 + `__root`） |
| API 路由／handler 檔 | 約 221 個（208 個在 `/api/admin`） |
| SQL migrations | 201 個（`20260611162942` → `20261016191050`） |
| 資料表 | 158 個 `public` + 5 個 `private` |
| `*_with_audit` RPC | 43 個 |
| 測試檔 | 工作樹 820 個 `*.test.ts(x)`；最新文件記錄 8,021 tests / 840 files |
| 最近活躍度 | 2026-10-01 以來 468 個 commit（含合併） |

> `AGENTS.md` 寫的「約 5,480 tests / 636 files」已經過時，勿當成目前數字。

---

## 4. 技術棧

- **語言**：TypeScript 5.x，strict；手寫程式碼沒有 `any`
- **框架**：TanStack Start（SSR React 19 + TanStack Router 1.170 + Vite 7 + Nitro）
- **資料庫**：Supabase Postgres，RLS 全表啟用，project ref `iihqjzilgawhfdhdevam`
- **樣式**：Tailwind CSS v4；語意 token 在 `src/styles.css`；公開設計系統在 `src/styles/public.css`
- **UI**：shadcn/ui on Radix（`src/components/ui/`）
- **金流**：Stripe、PayPal、AlipayHK COD、HSBC PayMe（API）；FPS 走手動對帳
- **Email**：Resend；PDF 收據用 `pdf-lib` + `@pdf-lib/fontkit`
- **濫用控制**：Upstash Redis rate limit、Cloudflare Turnstile、強制 CSP
- **執行環境／套件管理**：Bun（`.bun-version` 固定 1.3.14）
- **部署**：Vercel，Nitro `vercel` preset → `.vercel/output`

---

## 5. 架構

### 5.1 分層（新 server work 必須照這個做）

```
src/routes/api/**/route.ts          薄路由：rate limit → Turnstile → delegate
  └ -handlers.ts                    把依賴（auth fn、service）注入 handler factory
      └ lib/<domain>/http.server.ts HTTP 形狀：parse、status code、error mapping
          └ lib/<domain>/service.ts 商業規則；純函式，不 import Supabase
              └ lib/<domain>/repository.server.ts  只放 Supabase 查詢
```

Handler factory 把依賴當參數傳入（`requireAdmin`、`service`、`verifyPublicRegistration`），
所以測試可以在沒有資料庫的情況下注入 fake。

已照這個分層的 domain：`adoptions`、`crm`、`donations`、`volunteers`、`admin`、
`publicAdoption`、`sponsorship`。

**刻意例外：** 少數 route 直接呼叫 lib `*.server.ts` 或 Supabase（例如
`/api/admin/volunteers/jobs`、`/api/admin/payments`），靠 RPC 與測試補上審計與邊界；
新人不要模仿，除非該 domain 已有先例。

### 5.2 目錄

```
src/
  routes/                 檔案式路由；routes/api/ = server handlers
  components/
    site/                 公開頁面區塊
    admin/                後台 UI（477 個檔案）
    ui/                   shadcn/ui primitives（不要手改）
  lib/<domain>/           schemas · service · repository.server · http.server
  styles.css              Tailwind + CSS variable theme tokens
supabase/migrations/      時間戳 SQL；RLS、grant、RPC 都在這裡
supabase/drafts/          未核准、不會自動套用的 migration 草稿
docs/superpowers/         設計規格與實作計畫
server/routes/            Nitro 專用 handler（目前只有兩個義工 bulk/tasks POST）
```

### 5.3 路由

- TanStack Start 檔案式路由；`src/routeTree.gen.ts` 是 generated，**不要手改**。
- `animals/cat_.$id.tsx`、`sponsors_.$id.tsx` 這類 trailing underscore 用來退出父層 nesting。
- `stories.tsx` 與 `volunteer.tsx` 同時是頁面與 layout route，會自己判斷 pathname 再渲染 `<Outlet/>`。
- `about/cccp.tsx` 是唯一會 301 redirect 的公開路由（→ `/about/tnr`）。
- 三個 capability token 路由（`/adoption/status/:token`、`/sponsors/status/:token`、
  `/volunteer/status/:token`）必須 private：noindex、no-referrer、沒有 canonical。

### 5.4 Server-only 邊界

- `*.server.ts` 不會進 client bundle；secret 與 service-role client 只能放在這裡。
- `import.meta.env.VITE_*` 是公開的，不要放 secret。
- Server function 慣例：`lib/<domain>/*.functions.ts` 動態 import `.server.ts`，讓 client
  bundle 不會拉到 server-only 模組。

---

## 6. 公開網站

### 6.1 路由地圖

| 區域 | 路由 |
|---|---|
| 首頁 | `/` |
| 關於 | `/about`、`/about/tnr`、`/about/team`、`/about/privacy`、`/about/cccp`（301 → `/about/tnr`） |
| 動物 | `/animals/cat`、`/animals/cat/:id`、`/animals/dog`、`/animals/dog/:id` |
| 領養 | `/adoption/instructions`、`/adoption/apply`、`/adoption/status/:token` |
| 助養 | `/sponsors`、`/sponsors/:id`、`/sponsors/pledge`、`/sponsors/status/:token` |
| 捐款 | `/donate` |
| 義工 | `/volunteer`、`/volunteer/group`、`/volunteer/operations`、`/volunteer/status/:token` |
| 支持者 | `/supporter` |
| 內容 | `/stories`、`/stories/:slug`、`/knowledge`、`/help`、`/internships` |
| 報告 | `/report/adoption`、`/report/audit` |
| 機器路由 | `/robots.txt`、`/sitemap.xml`（token、admin、api、表單頁都被排除） |

### 6.2 四條主要 journey

**領養**

1. 列表：`getPublicAnimalListing` → `public_animal_listing_page` RPC；Zod 驗證 search params。
2. 詳情：`getPublicAnimal`；檢查 published、public status、retired、adoption eligible。
3. 申請：`ApplicationWizard` 七步；草稿存 localStorage（7 天 TTL）；相片走 signed upload。
4. 提交：`POST /api/adoption/applications`（5/min + Turnstile）→ 建 application、coordinator case、寄確認信。
5. 進度：`/adoption/status/:token` → `GET /api/adoption/status/:token`；token hash 後查
   `public_status_token`（30 天）。

**助養**

1. 列表／詳情：與領養共用 `public_animal_listing_page`，purpose = `sponsorship`。
2. Pledge：`PledgeWizard`；條款版本來自已發布的 `site_document_slots`（checksum 當版本）。
3. 提交：`POST /api/sponsorships/pledges`（5/min + Turnstile 或 proof intent）→
   `create_public_sponsorship_pledge` RPC；不會自動扣款。
4. 進度：`/sponsors/status/:token`；狀態含 `pending_payment`、`provisional`、`active`、
   `needs_followup`、`cancelled`。

**捐款**

1. `/donate` loader：`getPublicCheckoutState` 讀 `checkout_policy`、`checkout_method_approval`、
   `payment_public_config`；只有 `ready` 才能付款。
2. `POST /api/donations`：5/min + Turnstile → `createDonation` → `admit_new_checkout` RPC。
3. 付款方式：
   - Stripe Checkout（只收卡）
   - PayPal order／capture
   - AlipayHK COD（RSA/AES signed）
   - HSBC PayMe（API v0.12）：簽名請求建立 payment request；網頁版在新分頁開 PayCode 頁，
     手機用 deep link 進 PayMe app
   - FPS：手動，返回付款指示與 reference
4. 瀏覽器返回**永遠不會**把付款標成 paid；只有驗簽 webhook 才是權威。
5. 收據：滿 HK$100 且要求收據 → 產生 PDF → 私有 `receipts` bucket；支援者用 OTP 登入後
   取得 60 秒 signed URL。

**義工**

1. `/volunteer`：角色介紹 + `PolicySignup`。
2. Email OTP 登入（Supabase Auth，無密碼）。
3. `/api/volunteer/policy`：`sessions`、`terms`、`me`、`claim`、`book`、`accept_terms`、`cancel`。
4. `/volunteer/operations`：團體申請與調期；`publicMode` 重用後台 `VolunteerOperations`。
5. `/volunteer/status/:token`：報名狀態。

### 6.3 SEO / 品牌

- `src/lib/pageHead.ts`：公開頁 title、description、canonical、OG；token 頁只给 noindex/no-referrer。
- `src/lib/publicOrigin.ts`：預設 `https://hkscda.com`，可用 `VITE_PUBLIC_SITE_ORIGIN` 覆寫。
- `__root.tsx` 注入 Organization / WebSite JSON-LD；`<html lang="zh-Hant">`。
- 公開設計 token：`brand/design-tokens.{json,css}`、`docs/brand-guidelines.md`；runtime 映射在
  `src/styles.css`。主色 `#05648E`、accent `#A61C56`、warm paper `#FFFDF9`。
- 語言：zh-HK 為主；`/donate`、`/help`、`/adoption/instructions`、`/sponsors/pledge` 有英文 toggle；
  CMS 內容多為雙語欄位。
- 有 `publicCopyGuard.test.ts`、`publicFormGuard.test.ts`、`contrast.test.ts` 等品牌／文案／對比守衛。

---

## 7. 後台

### 7.1 角色矩陣

角色定義在 `src/lib/admin/access.ts`，RLS policy 鏡像同一套。

| 區域 | staff | treasurer | admin |
|---|---|---|---|
| taskOverview、payments | ✓ | ✓ | ✓ |
| animals、adoptionCases、manualIntake、coordinatorTasks、adopters、coordinatorReports | ✓ | – | ✓ |
| coordinatorStatuses | – | – | ✓ |
| supporters | – | ✓ | ✓ |
| volunteerManagement、internshipManagement | ✓ | – | ✓ |
| volunteerPolicyManagement | – | – | ✓ |
| contentManagement、faqManagement、sponsorshipRead、sponsorshipReview | ✓ | – | ✓ |
| sponsorshipFinance | – | ✓ | ✓ |
| governanceManagement、accessManagement | – | – | ✓ |

- 第一個可進的路由：staff → `/admin?section=cat`；treasurer → `/admin?section=payments`；
  admin → `/admin?section=cat`。
- 每個 admin API route 都要 `requireAdmin(request, roles, client)`：
  bearer token → Supabase Auth `getUser` → `admin_user` 查詢 → status／role 檢查。
- `status='pending'` 只有 `/api/admin/me` 會用 `activatePendingInvite` 啟用。
- 前端 `beforeLoad` 用 `requireAdminPageAccess(area, queryClient)`；401 會清 cache 並跳 login。

### 7.2 頁面群組

| 群組 | 代表頁面 |
|---|---|
| 總覽 | `/admin`、`/admin/tasks` |
| 動物 | `?section=cat/dog/sponsor`、`/admin/animals/new`、`/admin/animals/$id/edit` |
| 領養 | `/admin/applications`、`/admin/coordinator/{inbox,intake,tasks,adopters,reports,statuses}` |
| 義工 | 13 頁：overview、tasks、calendar、activities、operations、group-enquiries、people、qualifications、assessments、settings、daily-settings、sources、simulation |
| 金流 | `?section=payments`、`/admin/payment-methods`、`/admin/supporters` |
| 贊助 | `/admin/sponsorships` |
| CMS | `/admin/content`、`content/new`、`content/$id`、`content/adoption`、`adoption-guides`、`knowledge`、`about`、`documents`、`annual-reports`、`/admin/faq`、`/admin/governance` |
| 系統 | `/admin/access`、`/admin/login`、`/admin/reset-password`、`/admin/access-denied` |
| 實習 | `/admin/internships` |

### 7.3 義工後台（目前最複雜）

- 導航與角色：`src/components/admin/adminNav.ts` 的 `VOLUNTEER_CHILDREN`（單一來源）。
- daily／people 頁給 staff + admin；policy 頁只給 admin。
- 功能：政策版本 draft → preview → publish、每日名額、場次生成、報名審核、候補、
  出席紀錄（含 receipt）、改期、團體申請、資格／級別、月度評核、outbox／runtime job。
- 資料表約 40+ 個（`volunteer_*`），最近的 migration 集中在 workspace projection、
  pending snapshot、roster attendance。
- 最新未完成：hosted 事故 root cause、admin 重跑 hourly worker 的 audited RPC（draft）。

### 7.4 Admin UX 與 guard tests

後台不是「一般 CRUD」；以下規則由測試強制：

| Guard | 規則 |
|---|---|
| `adminCopyGuard.test.ts` | `src/routes/admin`、`src/components/admin` 內不得出現中文；文案只能在 `*Copy.ts` 用 `defineAdminCopy` |
| `adminBrowserDataGuard.test.ts` | admin 瀏覽器碼不得 `supabase.from()`／`.rpc()`；只能走 API |
| `adminRouteAuditing.test.ts` | service-role 改 animals／animal_profile_internal／animal_match 必須寫 `audit_log` 或用 `*_with_audit` RPC |
| `requiredReasonGuard.test.ts` | 15 種財務／不可逆操作必須有 reason |
| `confirmSettlesGuard.test.ts` | reason dialog 必須 await `mutateAsync`，失敗時保持開啟 |
| `adminConfirmGuard.test.ts` | 不得用原生 `confirm()`／`alert()` |
| `adminQueryErrorGuard.test.ts` | 載入錯誤要用 `LoadFailure` + `onRetry`，不得把錯誤當空資料 |
| `adminErrorRenderGuard.test.ts` | 不得直接渲染 `error.message`，要用 `adminErrorMessage` |
| `adminFormatGuard.test.ts` | 日期／金額只能用 `i18n/format.ts` 的 formatter（Asia/Hong_Kong） |
| `adminStatusBadgeGuard.test.ts` | 狀態只能用 `StatusBadge`，不得自建顏色 map |
| `adminTokenGuard.test.ts` | 不得用 Tailwind palette class，只能用 `var(--color-*)` |
| `adminHeadingGuard.test.tsx` | 每頁在 loading／empty／error 都只能有一個 h1，且符合 nav label |
| `adminEnglishSmoke.test.tsx` | 每個 destination 用英文渲染時不得出現任何中文 |
| `adminAccessCoverage.test.ts` | 每個 nav item 至少有一個角色可達；每個 admin page 要有 access gate |

其他共用元件：`LoadFailure`、`ConfirmActionDialog`、`StatusBadge`、`DataTable`、
`TablePager`、`BulkReview`、`ExportBar`、`useListQueryState`、`useLeaveConfirm`。

---

## 8. 資料層

### 8.1 主要 tables（按 domain）

- **Animals**：`animals`、`animal_profile_internal`、`animal_match`、`animal_position`、
  `animal_draft`、`animal_publication_*`、`coordinator_status`、`coordinator_status_history`
- **Adoptions**：`adoption_applications`、`adoption_application_detail`、
  `adoption_application_animal_preference`、`adoption_application_photo`、
  `adoption_upload_intent`、`adoption_case`、`adoption_followup`、`adopter_profile`、
  `successful_adoption`、`public_status_token`
- **Volunteers**：`volunteer_activity`、`volunteer_registration`、`volunteer_profile`、
  `volunteer_policy_*`、`volunteer_daily_policy_*`、`volunteer_attendance_event`、
  `volunteer_assessment_*`、`volunteer_operation_outbox`、`volunteer_runtime_job_run`
- **CRM**：`supporter`、`supporter_role`、`consent`、`supporter_consent_intent`、`message`、
  `manual_gift_request`、`crm_export_job`
- **CMS / content**：`content_item`、`content_revision`、`content_media`、`content_link`、
  `rescue_story_profile`、`story_update`、`knowledge_posts`、`document_assets`、
  `site_document_slots`、`annual_reports`、`about_page_content`、`board_member`、
  `adoption_rules`、`care_topics`、`faq_entry`
- **Donations**：`donation`、`payment`、`receipt`、`receipt_sequence`、`webhook_event`、
  `donation_delivery_job`、`checkout_policy`、`checkout_method_approval`、
  `checkout_admission`、`payment_public_config`
- **Sponsorship**：`sponsorship_pledge`、`sponsorship_preference`、`sponsorship_payment_proof`、
  `sponsorship_assignment`、`sponsorship_period`、`sponsorship_payment_allocation`、
  `sponsorship_refund`
- **Admin / audit**：`admin_user`、`audit_log`
- **FAQ**：`faq_entry`、`faq_search_gap`（只存 sanitised topic／language／confidence／day，
  90 天後清除）

### 8.2 RPC 與 trigger

- **`*_with_audit`**（43 個）：mutation + `audit_log` 在同一個 transaction；service-role only。
  例：`update_animal_status_with_audit`、`mutate_crm_supporter_with_audit`、
  `set_volunteer_registration_status_with_audit`、`issue_receipt_with_audit`。
- **`log_animal_mutation()`**：`AFTER INSERT/UPDATE/DELETE`，但 `auth.uid() is null` 時直接
  return——service-role 寫入要靠 app 層的 `*_with_audit` RPC 自己寫 audit，避免雙重記錄。
  對 `animal_profile_internal`、`adoption_applications`、`adopter_profile` 只記錄欄位名，
  不記錄值（PII redaction）。
- **Financial RPC**：`admit_new_checkout`、`issue_receipt`、`refund_provider_payment_atomically`、
  `record_manual_gift_with_audit`、`void_receipt_with_audit`。
- **Upload intent RPC**：`reserve_*_upload`、`mark_*_attached`、`claim_expired_*_uploads`。
- **Volunteer RPC**：`volunteer_policy_command`、`volunteer_bulk_command`、
  `volunteer_operation_command`、`claim_volunteer_operation_outbox`。

### 8.3 Migration 慣例

- Forward / additive：`create table if not exists`、`add column if not exists`、
  `drop constraint if exists` 後再 create；不 delete 財務 table。
- 版本識別唯一；`supabaseMigrations.test.ts` 會檢查。
- 每個 `security definer` 都要 pin `search_path`：`public, pg_temp` 或 `''`（後者要全部
  schema-qualify）。
- App 呼叫的 RPC 放 `public`，`revoke all from public, anon, authenticated` 後
  `grant execute to service_role`；`private` schema 不暴露給 PostgREST。
- **R01 forward migrations** 內嵌整份 catalog JSONB，任何未批准的 ACL／index／function／
  policy drift 會 raise `55000`；改動不相關 policy 也可能讓下一個 R01 forward 失敗。
- 每個 migration 的 sha256 記錄在 `docs/evidence/audit-remediation-20260927/migration-manifest.csv`。
- `supabase/drafts/` 是 out-of-band，不會自動套用，需獨立核准。

---

## 9. 金流

### 9.1 建單

`POST /api/donations`（5/min，`requireAvailability`）→ Turnstile → `createDonation`：

1. Zod parse；計算 `idempotency_fingerprint = sha256(payload without key)`。
2. `admit_new_checkout` RPC 檢查 `checkout_policy`（預設 disabled）、
   `checkout_method_approval`、已發布的 `payment_public_config`，並記錄 `checkout_admission`。
3. `resolve_public_supporter_identity` 建立／解析 supporter；建 `donation` + `payment`。
4. FPS 回 `kind:"manual"` 與付款指示；PayMe 回 `kind:"payme"`（`webLink`／`appLink`）；
   其他走 provider redirect。

### 9.2 Webhook 與冪等

- Stripe：`constructEvent` 驗簽；`checkout.session.completed` 等 → reconcile。
- PayPal：`verifyPayPalWebhook`；`CHECKOUT.ORDER.APPROVED` 先 capture，避免重送重複扣款。
- COD：RSA-SHA256 驗簽 + merchant／segment／currency／amount／order ref 比對。
- PayMe：驗 `Digest` 與 HMAC-SHA256 `Signature`（`/api/webhooks/payme`）；成功通知的
  `totalAmount`／`currencyCode` 要等於本地紀錄；失敗通知只有 `PR004`／`PR007` 才標失敗，
  其餘（例如 `PR001` 加 `reasonCode`）回 200 並保持 pending；`getPaymentRequest` 輪詢為備援。
- Resend：svix 驗簽，只收 5 種 event。
- 冪等三層：
  1. `webhook_event` unique `(provider, provider_event_id)` + 5 分鐘 lease。
  2. payment／donation status guard（`update ... where status='pending'`）。
  3. `idempotency_key` unique partial index。
- 金額／幣別必須等於本地紀錄；不一致寫 audit 並標 manual review，不 credit。
- 全額退款才 void 收據；部分退款只記錄，不 void。

### 9.3 收據

- 資格：`receiptRequested && net >= HK$100`。
- `issue_receipt` 冪等；編號 `HKSCDA-YYYY-NNNNNN`，按稅務年度 sequence。
- PDF 用 pdf-lib + CJK 字型（`subset: false`）；上傳私有 `receipts` bucket。
- PDF／email 失敗不會回滾付款；由 `donation_delivery_job` 重試。
- 支援者用 `/supporter` OTP 登入後，`GET /api/supporter/receipts/:id` 取得 60 秒 signed URL。

### 9.4 手動對帳

- `reconcileManualPayment` 寫 `payment.mark_received` audit，再跑 delivery job。
- 銀行對帳：`bankStatementDryRun`（read-only preview）→ `finance_bank_match_operation` 確認。
- 後台 `/admin?section=payments` 提供 pending、bank reference reconcile、receipt issue／void、
  delivery worklist、CSV export。

---

## 10. Email / notifications

- Provider abstraction：`lib/notifications/provider.server.ts`；區分 accepted / rejected / transport error。
- 捐款確認信：claim-before-send（`message` unique index），5 分鐘 stale lease，`failed → queued` retry。
- Sponsorship／volunteer 各自有 outbox 與 lease-token claim RPC。
- `mail_delivery_event` append-only；`record_mail_delivery_event` 對衝突 replay 會 raise。
- 送達狀態由 read projection 決定（complained > bounced > failed > delivered > delayed），
  遲到的 delivered 不會蓋掉 bounce。
- `recipient_notification_draft` 是手動草稿（email／whatsapp），不會自動送出。

---

## 11. 背景任務

`vercel.json` 有 7 個 cron；全部經 `authorizedCron(request, CRON_SECRET)`，
沒有 secret 就 401，且 production 只記錄一次 missing secret。

| 路徑 | 排程（UTC） | 工作 |
|---|---|---|
| `/api/jobs/donations` | `5 * * * *` | 捐款確認信／收據 delivery job |
| `/api/jobs/volunteers` | `15 * * * *` | 場次生成、release、候補晉升、月度評核、outbox |
| `/api/jobs/sponsorships` | `30 * * * *` | 助養 delivery outbox |
| `/api/jobs/crm-exports` | `*/5 * * * *` | 大型 CRM 匯出 |
| `/api/jobs/public-uploads` | `45 3 * * *` | 過期上傳清理 + FAQ search-gap purge |
| `/api/jobs/adoption-uploads` | `15 19 * * *` | 只清 adoption uploads |
| `/api/jobs/public-media-repair` | `45 19 * * *` | 動物／內容公開媒體修復 |

- `/api/internal/readiness` 也要求 `CRON_SECRET`；回報 cms、adoption、volunteerJobs、
  antiAbuse 四個 feature 的狀態。
- `cronScheduleContract.test.ts` 確保 `vercel.json` 與 `src/routes/api/jobs/*` 兩邊一致。
- **現況：** runbook 記錄 production 尚未設定 `CRON_SECRET`，所以 7 個 job 都沒有真正跑過；
  最新義工文件仍把 hosted 排程列為未驗證。開通前要按 runbook 設定 `RESEND_*`、`APP_URL`、
  `VOLUNTEER_JOB_ACTOR_ID`、`SPONSORSHIP_JOB_ACTOR_ID`，再 redeploy。

---

## 12. Storage / 上傳

Bucket：`receipts`、`adoption-files`、`adoption-application-photos`、
`sponsorship-payment-proof`、`site-documents`、`content-media`、`content-media-private`、
`animal-draft-images`、`internship-private`、`animal-images`。

- 公開 bucket 沒有 permissive `storage.objects` policy；瀏覽器不能直接寫。
- 上傳流程：server 以 service role 建 signed upload URL → 瀏覽器直接 PUT → server
  `verifyUploadedObjects` 重新 list 並比對 size／mime。
- 私有 bucket 的讀取 policy 用 `has_admin_role(...)` 或 path-prefix 檢查。
- 每個上傳意圖都有 `*_upload_intent` table + `claim_expired_*` 清理 RPC。
- 內容媒體：private upload → magic-byte 驗證 → `prepare_content_public_assets` →
  copy 到 public `content-media` → mark ready；cron repair 會重試。

---

## 13. 安全不變量（不能破）

1. **每個 table 都要 RLS**；policy 與 `src/lib/admin/access.ts` 的角色矩陣一致。
2. **每個 admin API route 都要 `requireAdmin`**；不要只靠前端 gate。
3. **每個 admin mutation 都要 audit**；service-role 寫入用 `*_with_audit` RPC，不要用第二個
   PostgREST insert（mutation 已 commit，audit 失敗會留下未審計的變更）。
4. **`*.server.ts` 不得進 client bundle**；secret 只在 server 讀。
5. **公開表單要 rate limit + Turnstile**；例外只有瀏覽器原生 payload（CSP report）或
   server-sanitised telemetry（help search-gap），且要 JSON-only、size-capped。
6. **不要信 `x-forwarded-for[0]`**；用 `getClientIp()`（優先 `x-vercel-forwarded-for`、
   `x-real-ip`、最右邊的 `x-forwarded-for`）。
7. **CSP 是 enforcing**，不是 Report-Only；有 `/api/csp-report` 收集違規。
8. **RLS／grant 不要靠推測**；新 migration 要同時通過 clean install 與現狀 rehearsal。
9. **Financial／不可逆操作要 reason**；UI 與 API 兩邊都要驗。
10. **Token 路由不得進 canonical／sitemap／analytics**；GA path 會把 token redact 成 `[token]`。

---

## 14. 工程慣例

- 檔案命名：PascalCase components、camelCase utilities、`.server.ts` server-only、
  `src/routes/` 內非路由檔用 `-name.ts` 前綴。
- Validation：Zod schema 放 `lib/<domain>/schemas.ts`，在 service boundary parse。
- **Injectable clock**：跟時間有關的函式收 `now = () => new Date()`；不要在邏輯內直接
  `Date.now()`。
- **Discarded side-effect deps**：結果會被忽略的 DI 依賴型別用 `Promise<unknown>`，
  不要 `Promise<void>`。
- CSS：只用 `var(--color-*)` token，不硬編顏色。
- 測試：`*.test.ts` 放在 source 旁邊，`bun:test`，用 DI fake。
- Commit：Conventional Commits（`feat:`、`fix:`、`chore:`、`docs:`、`refactor:`）。
- 大功能先落 `docs/superpowers/{plans,specs}/`。

---

## 15. 測試與 CI

### 15.1 測試層級

| 層級 | 說明 |
|---|---|
| Unit | `bun test --isolate`；DI fake、無資料庫 |
| Database | `*.database.test.ts`；需要 local Postgres（55322）與 opt-in env |
| RLS | `supabase/rls-tests/`；用真實角色經 PostgREST（55321） |
| Integration | `*.integration.test.ts`；content lifecycle、publication eligibility、media repair |
| Browser / acceptance | `scripts/verify-*`、Playwright、Lighthouse、brand／a11y／perf |

### 15.2 CI（`.github/workflows/ci.yml`）

- `verify`：typecheck → test → lint → build → `routeTree.gen.ts` diff
- `brand-verify`：build fixture → Playwright → `verify:brand`（**required**）
- `a11y-verify`：`verify:a11y`（non-blocking）
- `rls-matrix`：local Supabase → RLS + 多個 database suites（non-blocking）
- `performance-verify`：Lighthouse（non-blocking）

**注意：build 不做 typecheck**；type error 可以 green build 出貨。push 前一定要
`bunx tsc --noEmit`。

### 15.3 測試數字

- 最新文件（2026-10-25）：7,294 pass、727 skip、0 fail（8,021 tests / 840 files）。
- 工作樹：820 個 test 檔。
- `AGENTS.md` 的 5,480 tests / 636 files 已過時。

---

## 16. 本地開發

```bash
bun install
bun run dev          # Vite dev
bun run test         # bun test --isolate
bunx tsc --noEmit    # 必須；build 不會做
bun run lint
bun run format
```

- 本地 Supabase：API `55321`、DB `55322`、Studio `55323`。
- `supabase/config.toml` 的 `[db.seed] enabled = false`；`seed.sql` 需要
  `psql -v confirm=yes`，是 production demo seed guard。
- **`.env.local` 可能指向 production project。** 跑 `supabase db reset`、`db push`、seed、
  import 前，必須明確指定 local target；不要讓指令繼承 production 連線。
- 只跑 unit test 時可設 `SUPABASE_LOCAL_URL=http://127.0.0.1:1`，避免 RLS suite 連到
  其他 worktree 的 stack 造成假失敗。
- 備份／還原：`bun run backup:db`、`bun run restore:db`；runbook 在
  `docs/backup-restore-runbook.md`。

---

## 17. 已知風險 / 未完成

| 風險 | 影響 | 下一步 |
|---|---|---|
| 域名未切換、新舊站並存 | 公眾可能同時見到兩個站；SEO 與內容不一致 | 決定 cutover 計劃、301 map、DNS／Vercel domain 設定 |
| 預覽站有 demo 內容 | 「【示範】」故事／活動會被當成真實個案 | 上線前清 demo rows 或加 noindex／preview gate |
| 領養成效只有 1 宗 | 與舊站 1,926 的數字落差巨大，影響信任 | 確認歷史成功領養資料是否已 import；未核實前不要顯示 |
| 捐款閘門關閉 | 無法收網上捐款 | 確認方法、provider sandbox／production 驗收、`checkout_policy` 與 method approval |
| 7 個 cron 未啟用 | 收據／確認信、匯出、清理、義工排班都不會自動跑 | 按 `background-jobs-runbook.md` 設 env → redeploy → 驗證 |
| Owner UAT 全部 NOT RUN | 沒有業務方簽收 | 用 `owner-uat-checklist.md` 逐項跑 |
| 義工 hosted 事故 root cause 未證實 | 無法保證 production 行為 | 需要 hosted DB／log 讀取權，或由有權限的人重跑 |
| Admin 重跑 hourly worker RPC 仍是 draft | 後台沒有真正可用的「重跑」按鈕 | 把 `supabase/drafts/20261025000000_volunteer_runtime_retry_with_audit.sql` 走核准流程 |
| 234 張舊相缺失、92 段故事未審 | 公開檔案不完整 | 向 owner 取得原始檔案；不要用生成圖代替 |
| R01 forward migration 的 catalog guard | 任何未批准的 schema drift 會 fail closed | 改 migration 前先讀該 R01 檔的 expected catalog |
| 文件與程式碼落差 | 新人可能照舊文件做錯 | 以 code + guard tests 為準；本文件第 18 節列出已知落差 |

---

## 18. 文件與現實的落差

| 文件 | 落差 |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | 測試數 5,480 / 636 files 已過時；最新是約 8,021 / 840 |
| `docs/public-route-parity.md` | 寫 27 條公開路由；實際約 30 條（多了 `/internships`、`/supporter`、`/volunteer/operations`） |
| git remote | 實際是 `fimmickpo/hkscda`；多份文件寫 `YNWAforever/hkscda` |
| `.env.example` | 仍列 `VITE_PUBLIC_DONATION_CHECKOUT_ENABLED`，但目前 gating 已改成 DB `checkout_policy`；這個 flag 不再被讀 |
| `src/components/site/` | 約 12 個舊 public components 已無人引用（`Hero`、`SocialProof`、`VolunteerCarousel` 等） |
| `docs/development-completion-evidence.md` | 2026-09 的 production 數字與狀態；之後有新部署與義工改動，需重新核對 |

---

## 19. 建議閱讀順序

1. `AGENTS.md`（或 `CLAUDE.md`，內容相同）
2. `docs/superpowers/plans/hkscda-implementation-status.md`
3. `docs/superpowers/plans/hkscda-migration-and-release.md`
4. `docs/public-route-parity.md` + `src/routes/README.md`
5. `docs/background-jobs-runbook.md` + `docs/donations-runbook.md`
6. 最近三份義工 plan（2026-10-19 至 2026-10-25）
7. 要改哪個 domain，先看該 domain 的 `*Guard.test.ts`

---

## 20. 待向同事／owner 確認的問題

1. **Canonical repo** 是哪一個？`fimmickpo/hkscda` 還是文件寫的 `YNWAforever/hkscda`？
   CI／branch protection／Vercel project 以哪邊為準？
2. **正式域名切換** 的計劃與時間表？`hkscda.com` 的 301 map 由誰負責？
3. **網上捐款** 要開哪些方法？Stripe／PayPal／AlipayHK／FPS／PayMe 的正式驗收狀態？
4. **`CRON_SECRET` 與 job actor** 目前是否已設定？如果未設定，誰負責開通與驗證？
5. **義工政策決策** D01／D02／D03／D08（晚間自動開放、48 小時 release、每日 20 人計法、
   早上場次發布）是否已有 owner 決定？
6. **Demo 內容**（故事、活動、seed 動物的「【示範】」標記）由誰清理？清理標準是什麼？
7. **領養成效 1 宗** 是資料尚未 import，還是刻意只顯示可核實數字？舊站 1,926 的歷史數字
   要不要搬入？
8. **Owner UAT** 由誰主持、何時進行？`owner-uat-checklist.md` 是否仍是最新版本？

---

## 附錄：常用檔案

| 目的 | 路徑 |
|---|---|
| 專案規則 | `AGENTS.md`、`CLAUDE.md` |
| 路由慣例 | `src/routes/README.md` |
| 公開設計 token | `src/styles.css`、`src/styles/public.css`、`brand/design-tokens.css` |
| 品牌常數 | `src/lib/brand/brand.ts` |
| 角色矩陣 | `src/lib/admin/access.ts` |
| Admin 導航 | `src/components/admin/adminNav.ts` |
| Admin session | `src/lib/admin/session.server.ts`、`src/lib/admin/session.ts` |
| 公開 SEO | `src/lib/pageHead.ts`、`src/lib/publicOrigin.ts` |
| Rate limit / Turnstile / CSP | `src/lib/security/` |
| 金流核心 | `src/lib/donations/`、`src/lib/paymentPublicConfig/` |
| 義工核心 | `src/lib/volunteers/` |
| CRM | `src/lib/crm/`、`src/lib/supporters/` |
| CMS | `src/lib/content/`、`src/lib/contentReview/` |
| 背景任務 | `src/routes/api/jobs/`、`vercel.json`、`docs/background-jobs-runbook.md` |
| Migrations | `supabase/migrations/`、`supabase/rls-tests/` |
| 測試指令 | `package.json`、`.github/workflows/ci.yml` |

---

*本文件是 onboarding 導覽，不是規格書。實作變更時請同步更新受影響的章節，尤其是
「目前狀態」、「已知風險」與「文件落差」三節。*
