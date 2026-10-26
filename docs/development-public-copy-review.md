# Public copy review proposal

> **Historical — 2026-09-05 source inventory.** Owner approval was never recorded
> here; current public copy lives in the components/CMS, and current status is in
> `docs/project-overview.md`.

Source inventory only, 2026-09-05. No production CMS data or content was changed. Owner approval is still required for public copy replacement and factual rescue records.

| Source | Current copy | Proposed owner-review copy |
|---|---|---|
| `src/components/site/home/AdoptionStepsBand.tsx:21` | 四步看懂，七步申請流程保持不變。 | 了解領養申請流程 |
| `src/components/site/home/AdoptionStepsBand.tsx:6` | 完成七步申請、相片上載與驗證。 | 填寫申請、上載相片並完成驗證。 |
| `src/components/site/home/FeaturedStory.tsx:62` | 故事庫暫未有可顯示的精選內容，因此保留真實救援相片與故事入口，不以示例個案代替真實經歷。 | 暫時未有精選故事。您可瀏覽故事庫或了解領養資訊。 |

The proposals remove implementation commentary while describing existing UI states/actions. They do not invent animal outcomes, donation totals, dates, or owner approvals. Rendering and line numbers should be rechecked at final release review if these files change.

The supplied audit observed demo-labeled public content. A current production record count/title inventory cannot be established from source or synthetic fixtures. Obtain correct-project read-only access and list only public content identifiers, titles, status and demo markers for owner review before any authorized remediation. Do not copy supporter records or private media into the review document.
