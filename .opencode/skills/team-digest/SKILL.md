---
name: team-digest
description: Analyze team workload and produce a digest report from Redmine data
---

# Team Digest Analyst

Ты — аналитик команды neurodeck. Твоя задача: собрать данные из Redmine, проанализировать
нагрузку и проблемы команды, выдать структурированный дайджест для тимлида.

## Шаг 1 — Данные команды

Используй Redmine API:
```bash
# Состав команды и специализации
curl -s -u "$REDMINE_LOGIN:$REDMINE_PASSWORD" \
  "$REDMINE_BASE_URL/projects/<your-project>/memberships.json?limit=100"

# Задачи в работе (статус 2)
curl -s -u "$REDMINE_LOGIN:$REDMINE_PASSWORD" \
  "$REDMINE_BASE_URL/issues.json?project_id=<PROJECT_ID>&status_id=2&limit=100"

# Задачи на паузе (статус 10) — критично
curl -s -u "$REDMINE_LOGIN:$REDMINE_PASSWORD" \
  "$REDMINE_BASE_URL/issues.json?project_id=<PROJECT_ID>&status_id=10&limit=50"

# Задачи на ревью (статус 13)
curl -s -u "$REDMINE_LOGIN:$REDMINE_PASSWORD" \
  "$REDMINE_BASE_URL/issues.json?project_id=<PROJECT_ID>&status_id=13&limit=50"

# Просроченные задачи
curl -s -u "$REDMINE_LOGIN:$REDMINE_PASSWORD" \
  "$REDMINE_BASE_URL/issues.json?project_id=<PROJECT_ID>&status_id=2&due_date=%3C%3D$(date +%Y-%m-%d)&limit=50"
```

## Шаг 2 — Анализ

### Состав команды (core_developers = backend/web)
| Разработчик | ID | Роль |
|------------|-----|------|
| `<DEV_NAME_1>` (TL) | `<ID>` | teamlead |
| `<DEV_NAME_2>` | `<ID>` | backend |
| `<DEV_NAME_3>` | `<ID>` | backend |
| `<DEV_NAME_4>` | `<ID>` | frontend |
| `<DEV_NAME_5>` | `<ID>` | backend |

⚠ Devops-аккаунт — НЕ TL. Task pool: service account.

### Pipeline (development flow)
`Ready(20)→In Progress(2)→Code Review(13)→Done/Dev(27)→To Testing(24)→Testing(9)→Passed(25)→Resolved(3)→In Pool(12/18)`

### Аналитические акценты
- **Workload**: у кого >3 задач в работе → перегруз. У кого 0 → недоиспользование.
- **Paused (10)**: >1 задачи на паузе → тревога. Каждая >7 дней → кандидат на захоронение.
- **Code Review (13)**: сколько задач ждут ревью, кто автор, сколько дней висят.
- **Bottleneck**: где затор в пайплайне — какая стадия самая загруженная.
- **Overdue**: просроченные задачи, на сколько дней.
- **Velocity**: тренд — throughput за последние 2 недели, rework %.

## Шаг 3 — Формат вывода

```
# Дайджест команды neurodeck — <дата>

## Нагрузка
| Разработчик | В работе | На ревью | На паузе | Всего активных |
|------------|----------|----------|----------|----------------|
| ... | | | | |

## Задачи на паузе (🔴 тревога если >0)
| # | Задача | Дней на паузе | Причина |
|---|--------|--------------|---------|

## Ожидает ревью
| # | Задача | Автор | Дней в статусе |
|---|--------|-------|----------------|

## Просрочено
| # | Задача | Исполнитель | Просрочено дней |
|---|--------|-------------|-----------------|

## Тренды
- Throughput: X задач/неделю (↓/↑ относительно прошлой)
- Rework: X%
```

Кратко, только существенное. Тимлид читает с телефона.
