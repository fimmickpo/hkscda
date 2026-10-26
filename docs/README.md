# Docs index

這個目錄混合了**現行 runbook**、**帶日期的狀態／驗收報告**、**已完成的計畫**與**審計證據**。
請先看這頁，再決定要讀哪個檔案；不要假設每個 `.md` 都是最新指示。

> Last reviewed: 2026-10-26

## Start here

| 文件 | 用途 |
|---|---|
| [`project-overview.md`](./project-overview.md) | 專案全景：架構、功能地圖、現況、風險、閱讀順序 |
| [`../AGENTS.md`](../AGENTS.md) | 專案規則（與 `CLAUDE.md` 內容相同） |
| [`superpowers/plans/hkscda-implementation-status.md`](./superpowers/plans/hkscda-implementation-status.md) | 六階段實作現況與 blocker |
| [`superpowers/plans/hkscda-migration-and-release.md`](./superpowers/plans/hkscda-migration-and-release.md) | Migration、切換、回滾規則 |

## 現行 runbook／參考

| 文件 | 用途 |
|---|---|
| [`background-jobs-runbook.md`](./background-jobs-runbook.md) | 7 個 Vercel cron 的開關、驗證、暫停 |
| [`donations-runbook.md`](./donations-runbook.md) | 捐款／provider／收據的營運邊界 |
| [`backup-restore-runbook.md`](./backup-restore-runbook.md) | 備份與還原 |
| [`rls-testing.md`](./rls-testing.md) | RLS 測試怎麼跑 |
| [`admin-glossary.md`](./admin-glossary.md) | 後台中英術語對照 |
| [`brand-guidelines.md`](./brand-guidelines.md) | 現行品牌與設計方向 |
| [`owner-uat-checklist.md`](./owner-uat-checklist.md) | Owner 驗收清單 |
| [`volunteer-public-registration-api.md`](./volunteer-public-registration-api.md) | 義工公開報名 API |
| [`volunteer-operational-launch.md`](./volunteer-operational-launch.md) | 義工營運啟用記錄（多數項目仍待核准） |

設計 token 的權威來源是 [`../brand/design-tokens.json`](../brand/design-tokens.json)、
[`../brand/design-tokens.css`](../brand/design-tokens.css) 與 [`../src/styles.css`](../src/styles.css)。

## 設計（含歷史）

| 文件 | 狀態 |
|---|---|
| [`brand-guidelines.md`](./brand-guidelines.md) | **現行** |
| [`DESIGN-SPEC.md`](./DESIGN-SPEC.md) | 歷史參考（Poofyco study，已被現行品牌取代） |
| [`assets/brand-redesign/`](./assets/brand-redesign/) | 2026-07 改版前後截圖（歷史） |

> 2026-10-26 cleanup: removed the 2026-07 brand reports
> (`HKCSDA_BRAND_AUDIT.md`, `HKCSDA_COLOR_SYSTEM.md`, `HKCSDA_REDESIGN_REPORT.md`),
> the `poofyco-study/` screenshots and the historical `layout-branch-stack.md`.
> They remain in git history; `DESIGN-SPEC.md` is kept as provenance.

## 狀態、驗收與發布記錄

| 文件 | 日期／狀態 |
|---|---|
| [`development-completion-evidence.md`](./development-completion-evidence.md) | 2026-09-06；本地完成證據，production 仍有多個外部 gate |
| [`development-owner-uat-status.md`](./development-owner-uat-status.md) | 2026-09-06；全部 owner 項目 **NOT RUN** |
| [`development-release-proposal.md`](./development-release-proposal.md) | 2026-09-06；本機 release candidate／rollback 提案 |
| [`development-public-copy-review.md`](./development-public-copy-review.md) | 2026-09-05；公開文案審查提案 |
| [`volunteer-cold-file-open-findings.md`](./volunteer-cold-file-open-findings.md) | 2026-10-17；義工效能診斷，仍未結案 |
| [`volunteer-local-performance-runtime.md`](./volunteer-local-performance-runtime.md) | 2026-10-17；量測條件 |
| [`volunteer-etw-pilot-execution-2026-10-17.md`](./volunteer-etw-pilot-execution-2026-10-17.md) | 2026-10-17；ETW pilot，partial |
| [`evidence/`](./evidence/) | 大量帶日期的審計／驗收證據；**不是現行狀態** |

> `docs/evidence/` 內含 1.4 GB 檔案（5,100 個 `.source` blob、14 個 zip、大量
> JSON／log／截圖），其中 `evidence/audit-remediation-20260927/migration-manifest.csv`
> 被 `src/lib/operations/migrationManifest.test.ts` 直接引用。**不要在未確認的情況下
> 刪除或改寫這個目錄**；若只保留摘要，必須先建立 manifest 並取得 owner 同意。

## 計畫與規格

| 目錄 | 內容 |
|---|---|
| [`superpowers/plans/`](./superpowers/plans/) | 122 個實作計畫，檔名 `YYYY-MM-DD-topic.md` |
| [`superpowers/specs/`](./superpowers/specs/) | 73 個設計規格 |

- 新計畫／規格放這兩個目錄，依 `AGENTS.md` 的慣例。
- 計畫內的 checkbox **不代表目前狀態**；有些已完成但沒有回填，有些從一開始就是提案。
- 判斷是否仍有效，請看該計畫的日期、實作現況與 `project-overview.md` 的「目前狀態」。

## 已知過時／易誤導

| 位置 | 問題 |
|---|---|
| [`public-route-parity.md`](./public-route-parity.md) | 寫 27 條公開路由；2026-10-26 實際約 30 條（多了 `/internships`、`/supporter`、`/volunteer/operations`）。已加歷史標記 |
| [`../AGENTS.md`](../AGENTS.md) | 測試數 5,480／636 files 已過時；最新記錄約 8,021／840 |
| [`../.env.example`](../.env.example) | 仍列 `VITE_PUBLIC_DONATION_CHECKOUT_ENABLED`，但目前 gating 已改成 DB `checkout_policy` |
| `docs/evidence/**` | 帶日期的歷史證據，不要當成 production 現況 |

## 新增文件時

- 現行 runbook 放 `docs/` 頂層；帶日期的計畫放 `docs/superpowers/plans/`；設計放 `specs/`。
- 狀態／驗收文件請在標題下寫日期與範圍，並明確標示「local only」或「production verified」。
- 文件被取代時，在頂部加一行 banner：`Historical — superseded by <path>`。
- 不要把原始截圖、zip、大量 log 直接加進 git；放在 `docs/evidence/<date>-<topic>/` 並附
  manifest，或只保留摘要與 mail 可追溯的 reference。
- 改動 `AGENTS.md`／`project-overview.md` 的數字時，順便更新這頁的「已知過時」表。
