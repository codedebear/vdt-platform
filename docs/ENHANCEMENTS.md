# VDT Platform — Enhancement Backlog

Deferred enhancements / nice-to-haves captured during use. Not bugs; prioritize separately from the QAX/feature roadmap.

| # | Item | Why | Notes |
|---|------|-----|-------|
| E-1 | **Edit project description** | Description is fed into every Claude prompt (PLANNER + QA scenario/step/compile gen via `domain/prompts.ts` + `domain/qaPrompts.ts` `Description:` line). It steers AI generation, so users must be able to fix/refine it after creation — currently set-once at create. | Add `PATCH /api/projects/:id` for description (+ name?), owner-or-SUPER_ADMIN. FE: editable field on project detail. |
| E-2 | **Delete project** | Clean up throwaway / test data (e.g. full-loop verify projects, seed projects). Currently no delete → data accumulates. | Add `DELETE /api/projects/:id`, owner-or-SUPER_ADMIN. Must cascade: PhaseExecutions, TestRun/Scenario/Step/Result, TargetEnvironment, Secrets, Attachments. Consider soft-delete vs hard-delete; confirm-gate in UI. |
| E-3 | **Target / Secrets settings UI (endpoint + credentials)** | Backend routes exist (`GET/PUT /api/projects/:id/target`, `GET/PUT/DELETE .../secrets`) since QAX-3A, but there is NO frontend — users must curl the API to set baseUrl/hostAllowlist AND any credentials (username/password/API key) before a QA run can start. Blocks self-service QA_ONLY usage. | FE settings panel on project detail: target form (baseUrl/endpoint, hostAllowlist, non-prod toggle) + secrets manager to enter user/password/key etc. (add/list names/delete, never shows values, referenced as `${VAR}` in steps). Gated owner/SUPER_ADMIN. |

## Already-noted polish (from QAX-7, see memory)
- Sign-off UI: make it a clearer modal (currently inline form), and/or let PROJECT_OWNER download the report (currently QA/SUPER_ADMIN only).
- xlsx 0.18.5 security debt (encode-only, low risk) — consider exceljs or CDN-pinned SheetJS.
