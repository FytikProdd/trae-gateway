# Trae Gateway

Languages: [English](./README.md) | [Русский](./README.ru.md)

This project gives you a local HTTP gateway for Trae.

What it does:

- exposes `GET /v1/models`
- exposes `POST /v1/chat/completions`
- reads the Trae JWT from the local Trae profile
- reads the current Trae backend domain from the installed `product.json`
- exposes raw debug endpoints for reverse-engineering Trae at runtime
- supports template-based forwarding into private Trae endpoints

Current status:

- auth/header plumbing is implemented
- OpenAI-compatible API surface is implemented
- raw passthrough to Trae private endpoints is implemented
- agent-v3 standard chat can now be sent without a captured template using the built-in payload builder
- session persistence now keeps stable external conversation to Trae `session_id` mappings in a local store
- SSE parsing now emits OpenAI `tool_calls` when Trae events expose `tool_id` / `tool_type`-style blocks
- OpenAI follow-up requests with `role: "tool"` are now translated into an experimental `/api/agent/v3/commit_toolcall_result` payload
- upstream routing now prefers Trae boot domains from the installed `product.json` instead of a single hard-coded host
- `GET /v1/models` now reads the real model catalog and selected model from local Trae state in `state.vscdb`, then merges that with recent renderer-log observations
- `GET /debug/models` now exposes the merged model discovery state for runtime debugging
- OpenAI requests with `model: "trae-agent"` or an empty model now resolve to the currently selected Trae builder model
- `agent-v3-auto` now includes a richer runtime profile in the generated `create_agent_task` payload
- template-based forwarding still exists as a fallback for reverse-engineering and private endpoint drift

What is still missing before `1.0`:

- fully proven tool-call loop: the gateway can now continue client-driven tool results, but built-in tool execution and live schema validation are still incomplete
- token refresh and automatic recovery of expired Trae sessions
- complete deterministic reuse of Trae `task_id` / `message_id` follow-up state
- live model-config resolution for the selected Trae model; the current upstream blocker is still external `get_detail_param` requests failing before the gateway can bootstrap a valid config
- richer tests for auth loading, template rendering, live upstream behavior, and failure paths

Detailed roadmap: [docs/ROADMAP.md](./docs/ROADMAP.md)

That means you can use it in two ways:

1. Debug/reverse mode

- `GET /debug/auth`
- `GET /debug/detail-param?function=chat_v3`
- `GET /debug/models`
- `POST /debug/agent/v3/create_agent_task`
- `POST /debug/agent/v3/commit_toolcall_result`
- `POST /debug/ide/v2/llm_raw_chat`

2. OpenAI-compatible mode

- point external tools at `http://127.0.0.1:4317/v1`
- use any API key value, it is ignored
- by default the gateway uses `agent-v3-auto` mode
- optional template modes still exist for reverse-engineering and fallback operation

## Quick start

```powershell
node src/index.js
```

Health check:

```powershell
Invoke-WebRequest http://127.0.0.1:4317/health
```

List models:

```powershell
Invoke-WebRequest http://127.0.0.1:4317/v1/models
```

## Environment

- `PORT`
- `TRAE_PROXY_MODE`
- `TRAE_AGENT_TEMPLATE_PATH`
- `TRAE_RAW_CHAT_TEMPLATE_PATH`
- `TRAE_STORAGE_PATH`
- `TRAE_PRODUCT_PATH`
- `TRAE_SESSION_STORE_PATH`
- `TRAE_REQUEST_TIMEOUT_MS`
- `TRAE_DEBUG`

`TRAE_PROXY_MODE` values:

- `agent-v3-auto`
- `agent-v3-template`
- `raw-chat-template`

## Template placeholders

The gateway replaces placeholders anywhere in the JSON template:

- `{{prompt}}`
- `{{model}}`
- `{{session_id}}`
- `{{task_id}}`
- `{{message_id}}`
- `{{trace_id}}`
- `{{request_id}}`

## Template fallback workflow

1. Capture one real Trae request body for `/api/agent/v3/create_agent_task`.
2. Save it as JSON and replace the changing fields with placeholders.
3. Set `TRAE_AGENT_TEMPLATE_PATH` to that file.
4. Set `TRAE_PROXY_MODE=agent-v3-template`.
5. Start the gateway.
6. Point Codex / Claude Code / OpenCode at `http://127.0.0.1:4317/v1`.

## Notes

- Trae uses private endpoints such as `/api/agent/v3/create_agent_task`.
- The built-in auto payload now covers standard chat plus an experimental client-driven tool-result continuation path, but server-side tool execution is still not implemented.
- The gateway persists conversation-to-session mapping in `TRAE_SESSION_STORE_PATH` or `.trae-gateway-sessions.json`.
- `GET /v1/models` now prefers local Trae state from `C:\Users\Admin\AppData\Roaming\Trae\User\globalStorage\state.vscdb` and then merges recent log observations.
- The selected builder model is read from `*_ai-chat:sessionRelation:globalModelMap`, mode hints come from `*_ai-chat:sessionRelation:globalModeMap`, and the model catalog comes from `*_AI.agent.model.model_list_map`.
- `GET /debug/models` shows the merged raw discovery result the gateway is using.
- If the client sends `model: "trae-agent"` or omits `model`, the gateway now uses the currently selected Trae builder model automatically.
- Tool-call continuation usually goes through `/api/agent/v3/commit_toolcall_result`.
- Exact Trae SSE schemas still vary, but the parser now handles multi-line SSE frames, stable id extraction, and tool-call block detection.
- The current live upstream blocker is still model-config bootstrap: direct external `get_detail_param` requests return `HTTP 400` with an empty body, and the chat path then surfaces `model config is empty for model name: <selected-model>`.

## Runtime findings

Validated on March 30, 2026:

- local Trae state already contains the active builder model and most of the usable model catalog, so model discovery no longer has to rely on renderer logs alone
- the gateway now resolves the default OpenAI model from the same Trae-selected builder model the desktop app is using
- this machine currently resolves `trae-agent` to `gemini-3.1-pro`
- the remaining blocker is not model selection anymore; it is missing live model config bootstrap from Trae's private runtime
