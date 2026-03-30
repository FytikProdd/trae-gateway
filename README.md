# Trae Gateway

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
- template-based forwarding still exists as a fallback for reverse-engineering and private endpoint drift

What is still missing before `1.0`:

- full tool-call loop: receive tool call, execute it, return result through `/api/agent/v3/commit_toolcall_result`
- stable Trae SSE/event parsing without heuristic text extraction
- token refresh and correct handling of expired Trae sessions
- stable session mapping between OpenAI requests and Trae `session_id` / `task_id` / `message_id`
- consistent streaming and non-streaming behavior
- proper upstream error mapping for auth, rate limit, timeout, and invalid payload cases
- model/capability discovery instead of static placeholder models
- tests for auth loading, template rendering, SSE parsing, and upstream failure paths

Detailed roadmap: [docs/ROADMAP.md](./docs/ROADMAP.md)

That means you can use it in two ways:

1. Debug/reverse mode

- `GET /debug/auth`
- `GET /debug/detail-param?function=chat_v3`
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
- The built-in auto payload currently targets standard text chat first; tool execution is still incomplete.
- Tool-call continuation usually goes through `/api/agent/v3/commit_toolcall_result`.
- The gateway includes heuristics for extracting text from Trae SSE chunks, but exact event schemas can vary.
