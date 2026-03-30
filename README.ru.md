# Trae Gateway

Языки: [English](./README.md) | [Русский](./README.ru.md)

Этот проект поднимает локальный HTTP gateway для Trae.

Что он умеет:

- отдаёт `GET /v1/models`
- отдаёт `POST /v1/chat/completions`
- читает Trae JWT из локального профиля Trae
- читает текущий backend domain Trae из установленного `product.json`
- даёт raw debug endpoints для реверс-инжиниринга Trae во время работы
- поддерживает шаблонную отправку запросов в приватные endpoint'ы Trae

Текущее состояние:

- реализована загрузка auth и заголовков
- реализована OpenAI-совместимая API-поверхность
- реализован raw passthrough в приватные endpoint'ы Trae
- стандартный `agent-v3` чат теперь можно отправлять без захваченного template через встроенный builder payload'а
- persistence сессий теперь сохраняет стабильное сопоставление внешнего диалога с Trae `session_id` в локальном store
- SSE parser теперь умеет отдавать OpenAI `tool_calls`, когда в событиях Trae видны блоки с `tool_id` / `tool_type`
- выбор upstream domain теперь опирается на реальные Trae boot domains из установленного `product.json`, а не на один жёстко прошитый host
- `GET /v1/models` теперь возвращает недавно замеченные реальные модели Trae из локальных Trae логов вместо статических заглушек
- template-based forwarding оставлен как fallback для реверс-инжиниринга и на случай дрейфа приватной схемы upstream

Что ещё не закрыто до `1.0`:

- полный tool-call loop: принять tool call, выполнить его, вернуть результат через `/api/agent/v3/commit_toolcall_result`
- refresh токена и автоматическое восстановление протухших Trae-сессий
- полное детерминированное переиспользование Trae `task_id` / `message_id` / follow-up state
- более широкие тесты для загрузки auth, template rendering, live upstream поведения и failure paths

Подробный roadmap: [docs/ROADMAP.ru.md](./docs/ROADMAP.ru.md)

Проект можно использовать в двух режимах:

1. Debug/reverse mode

- `GET /debug/auth`
- `GET /debug/detail-param?function=chat_v3`
- `POST /debug/agent/v3/create_agent_task`
- `POST /debug/agent/v3/commit_toolcall_result`
- `POST /debug/ide/v2/llm_raw_chat`

2. OpenAI-compatible mode

- направляйте внешние инструменты на `http://127.0.0.1:4317/v1`
- можно передать любой API key, он игнорируется
- по умолчанию gateway использует режим `agent-v3-auto`
- template-режимы остаются доступными для реверс-инжиниринга и fallback-сценариев

## Быстрый старт

```powershell
node src/index.js
```

Проверка здоровья:

```powershell
Invoke-WebRequest http://127.0.0.1:4317/health
```

Список моделей:

```powershell
Invoke-WebRequest http://127.0.0.1:4317/v1/models
```

## Переменные окружения

- `PORT`
- `TRAE_PROXY_MODE`
- `TRAE_AGENT_TEMPLATE_PATH`
- `TRAE_RAW_CHAT_TEMPLATE_PATH`
- `TRAE_STORAGE_PATH`
- `TRAE_PRODUCT_PATH`
- `TRAE_SESSION_STORE_PATH`
- `TRAE_REQUEST_TIMEOUT_MS`
- `TRAE_DEBUG`

Значения `TRAE_PROXY_MODE`:

- `agent-v3-auto`
- `agent-v3-template`
- `raw-chat-template`

## Плейсхолдеры template

Gateway заменяет плейсхолдеры в любом месте JSON-шаблона:

- `{{prompt}}`
- `{{model}}`
- `{{session_id}}`
- `{{task_id}}`
- `{{message_id}}`
- `{{trace_id}}`
- `{{request_id}}`

## Fallback workflow для template

1. Захватите один реальный body запроса для `/api/agent/v3/create_agent_task`.
2. Сохраните его как JSON и замените изменяющиеся поля на плейсхолдеры.
3. Укажите путь в `TRAE_AGENT_TEMPLATE_PATH`.
4. Поставьте `TRAE_PROXY_MODE=agent-v3-template`.
5. Запустите gateway.
6. Направьте Codex / Claude Code / OpenCode на `http://127.0.0.1:4317/v1`.

## Заметки

- Trae использует приватные endpoint'ы, например `/api/agent/v3/create_agent_task`.
- Встроенный auto-payload сейчас в первую очередь рассчитан на обычный текстовый чат; выполнение tools и commit результатов пока не завершены.
- Gateway сохраняет mapping между разговором и Trae-сессией в `TRAE_SESSION_STORE_PATH` или `.trae-gateway-sessions.json`.
- `GET /v1/models` теперь строится по недавней локальной активности Trae, поэтому список отражает реально замеченные модели, а не захардкоженный каталог.
- Продолжение tool call обычно идёт через `/api/agent/v3/commit_toolcall_result`.
- Точные схемы Trae SSE всё ещё требуют стабилизации, но parser уже умеет разбирать multi-line SSE frames, вытаскивать стабильные id и распознавать tool-call блоки.
