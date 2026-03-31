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
- follow-up запросы OpenAI с `role: "tool"` теперь переводятся в экспериментальный payload для `/api/agent/v3/commit_toolcall_result`
- выбор upstream domain теперь опирается на реальные Trae boot domains из установленного `product.json`, а не на один жёстко прошитый host
- `GET /v1/models` теперь читает реальный каталог моделей и выбранную модель из локального Trae state в `state.vscdb`, а затем объединяет это с недавними наблюдениями из renderer logs
- `GET /debug/models` теперь отдаёт объединённое состояние discovery моделей для runtime-отладки
- OpenAI-запросы с `model: "trae-agent"` или пустой моделью теперь автоматически резолвятся в текущую выбранную builder-модель Trae
- `agent-v3-auto` теперь добавляет в `create_agent_task` более полный runtime profile
- template-based forwarding оставлен как fallback для реверс-инжиниринга и на случай дрейфа приватной схемы upstream

Что ещё не закрыто до `1.0`:

- полностью добитый tool-call loop: gateway уже умеет продолжать client-driven tool results, но встроенное выполнение tools и живая валидация схемы ещё не завершены
- refresh токена и автоматическое восстановление протухших Trae-сессий
- полное детерминированное переиспользование Trae `task_id` / `message_id` / follow-up state
- live-разрешение model config для выбранной Trae-модели теперь работает через корректный `get_detail_param` bootstrap, но `agent-v3` path всё ещё требует дополнительного runtime state сверх одного model config
- покрытие live upstream-интеграции на реальных Trae-сессиях, диагностика malformed upstream payload и recovery-сценарии для refresh auth

Подробный roadmap: [docs/ROADMAP.ru.md](./docs/ROADMAP.ru.md)

Проект можно использовать в двух режимах:

1. Debug/reverse mode

- `GET /debug/auth`
- `GET /debug/detail-param?function=chat_v3`
- `GET /debug/runtime`
- `GET /debug/models`
- `POST /debug/agent/v3/create_agent_task`
- `POST /debug/agent/v3/commit_toolcall_result`
- `POST /debug/ide/v2/llm_raw_chat`

2. OpenAI-compatible mode

- по умолчанию gateway слушает `http://127.0.0.1:4317/v1`
- поставьте `TRAE_BIND_HOST=0.0.0.0`, если нужен доступ с другой машины или из контейнера
- можно передать любой API key, он игнорируется
- по умолчанию gateway использует режим `agent-v3-auto`
- template-режимы остаются доступными для реверс-инжиниринга и fallback-сценариев

## Быстрый старт

```powershell
node src/index.js
```

Bind для LAN / внешнего доступа:

```powershell
$env:TRAE_BIND_HOST="0.0.0.0"
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
- `TRAE_BIND_HOST`
- `HOST` (алиас для `TRAE_BIND_HOST`)
- `TRAE_PROXY_MODE`
- `TRAE_AGENT_TEMPLATE_PATH`
- `TRAE_RAW_CHAT_TEMPLATE_PATH`
- `TRAE_STORAGE_PATH`
- `TRAE_PRODUCT_PATH`
- `TRAE_LOGS_PATH`
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
- `{{conversation_id}}`
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
- `/health` теперь возвращает `listenHost`, так что можно сразу проверить, слушает gateway только localhost или уже открыт на нужном bind address.
- Если нужен доступ извне этой машины, поставьте `TRAE_BIND_HOST=0.0.0.0`, направьте удалённый клиент на `http://<ip-этой-машины>:4317/v1` и проверьте, что Windows Firewall или ваш reverse proxy пропускает порт.
- Встроенный auto-payload теперь покрывает обычный чат и экспериментальный client-driven путь для tool-result continuation, но server-side выполнение tools пока не реализовано.
- Gateway сохраняет mapping между разговором и Trae-сессией в `TRAE_SESSION_STORE_PATH` или `.trae-gateway-sessions.json`.
- `GET /v1/models` теперь в первую очередь опирается на локальный Trae state из `C:\Users\Admin\AppData\Roaming\Trae\User\globalStorage\state.vscdb`, а уже потом дополняется наблюдениями из логов.
- Выбранная builder-модель читается из `*_ai-chat:sessionRelation:globalModelMap`, hints по режиму идут из `*_ai-chat:sessionRelation:globalModeMap`, а каталог моделей берётся из `*_AI.agent.model.model_list_map`.
- `GET /debug/models` показывает сырое объединённое состояние discovery, которое реально использует gateway.
- `GET /debug/runtime` читает свежие локальные `ai-agent_*_stdout.log` и сводит оставшийся desktop-runtime блокер на основе реальных сигналов Trae.
- Если клиент отправляет `model: "trae-agent"` или вообще не передаёт `model`, gateway теперь автоматически использует выбранную в Trae builder-модель.
- Продолжение tool call обычно идёт через `/api/agent/v3/commit_toolcall_result`.
- Точные схемы Trae SSE всё ещё требуют стабилизации, но parser уже умеет разбирать multi-line SSE frames, вытаскивать стабильные id и распознавать tool-call блоки.
- Проверено 31 марта 2026 года: прямые внешние вызовы `get_detail_param` больше не требуют старого `mode_type: "Max"` / `agent_type: "builder_v3"` bootstrap и могут возвращать валидный `config_info_list`.
- Оставшийся live-блокер в `agent-v3` глубже: если подставить resolved runtime `model_name`, upstream уже проходит стадию `model config is empty`, но затем упирается в `failed to get summary config`, то есть desktop Trae использует дополнительный приватный runtime context сверх одного model config.
- Практически это значит следующее: если gateway уже доступен с другой машины, но `/v1/chat/completions` всё ещё отвечает `failed to get summary config`, то сеть больше не главный блокер; для этой сборки Trae нужен `TRAE_PROXY_MODE=agent-v3-template` с захваченным реальным payload.

## Подтверждённые runtime-наблюдения

Проверено 31 марта 2026 года:

- локальный Trae state уже содержит активную builder-модель и большую часть реально доступного каталога моделей, так что discovery больше не зависит только от renderer logs
- gateway теперь резолвит дефолтную OpenAI-модель из той же выбранной builder-модели Trae, которую использует desktop app
- на этой машине `trae-agent` сейчас резолвится в `gemini-3.1-pro`
- выбранный model config теперь можно получить внешне через `get_detail_param`, так что bootstrap модели больше не является главным блокером
- оставшийся блокер теперь в полном воссоздании desktop `agent-v3` runtime для внешних запросов
