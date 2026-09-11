# neurodeck Base — Shared Domain

> Shared facts for orchestrator AND redmine analyst. Single source of truth.
> Edit status IDs / people / pipeline HERE. **Respond ONLY in Russian.**
>
> ⚠ TEMPLATE: replace every `<PLACEHOLDER>` with your own project data.
> Status IDs are Redmine-instance specific — read them from your tracker admin.

## Project
`<YOUR_PROJECT>` — an enterprise production system. Stack: `<YOUR_STACK>` (e.g. PHP/Yii2, PG, ClickHouse, RabbitMQ, Go, Node).
Tracker: Redmine (`<YOUR_REDMINE_HOST>`). Code: GitLab. Main project: `<your-project>` (id `<PROJECT_ID>`).

## Team (core_developers = backend/web)

| Developer | id | Role |
|---|---|---|
| `<DEV_NAME_1>` (TL, your user) | `<ID>` | teamlead |
| `<DEV_NAME_2>` | `<ID>` | backend |
| `<DEV_NAME_3>` | `<ID>` | backend |
| `<DEV_NAME_4>` | `<ID>` | frontend |
| `<DEV_NAME_5>` | `<ID>` | backend |

⚠ Always use id, not name, when the mapping is ambiguous.
Task pool: service account (`<POOL_ACCOUNT>`).
Specializations: backend/web, Android, analysts, QA, devops. Map: `get_team().roles`.

## Pipeline (development flow)
`Ready(20)→In Progress(2)→Code Review(13)→Done/Dev(27)→To Testing(24)→Testing(9)→Passed(25)→Resolved(3)→In Pool(12/18)`

| Status | ID | Meaning |
|---|---|---|
| Ready | 20 | ready to pick up |
| **In Progress** | **2** | KEY. Goal: 1/dev. 🔴 0 = neglect |
| **Code Review** | **13** | waiting TL. NOT merged to develop |
| **Done/Dev** | **27** | ⚠ NOT complete! Merged to develop. Ahead: test+acceptance+master |
| To Testing | 24 | merged to RC, on stage |
| Testing | 9 | QA in progress |
| Passed | 25 | test passed |
| Failed/Rework | 26/8 | rollback to dev |
| **Paused** | **10** | 🔴 CANDIDATE FOR BURIAL. >1 = alarm |
| Resolved/In Pool | 3/12/18 | terminal. New work → new issue |
| Rotten | 31 | lost relevance |

🚫 Ignore `done_ratio`/percentages — meaningless. Judge by status + history.

Trackers: Development(7), Bug(1), Improvement(2), Incident(19), Incident-monitoring(25). Epic(26)=parent-only.
