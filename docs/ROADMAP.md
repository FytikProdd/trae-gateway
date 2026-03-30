# Roadmap

## Current status

The project is already usable as:

- a local OpenAI-compatible gateway shell
- a Trae auth/header loader
- a reverse-engineering/debug proxy for private Trae endpoints
- a template-based adapter into Trae private APIs

What it is not yet:

- a zero-config production-grade Trae adapter
- a full replacement for Trae's internal chat/task runtime

## What blocks `1.0`

### 1. Automatic `create_agent_task` payload generation

Current state:

- `POST /v1/chat/completions` now has an `agent-v3-auto` mode that builds a minimal Trae request without a captured JSON template
- template mode still exists as a fallback when the upstream private schema drifts
- the auto builder is still intentionally conservative and currently optimized for standard text chat

Why this matters:

- zero-config startup for standard chat is now possible
- upstream protocol changes can still break the builder, so schema discovery and hardening are still required

`1.0` requirement:

- the gateway must construct a valid `/api/agent/v3/create_agent_task` request automatically from OpenAI-style input

### 2. Full tool-call loop

Current state:

- raw passthrough for `/api/agent/v3/commit_toolcall_result` exists
- Trae event parsing can now surface OpenAI-style `tool_calls` when tool metadata is present in upstream events
- there is still no complete OpenAI-compatible tool execution loop

Missing pieces:

- parse tool calls from Trae events
- expose them in a predictable external format
- execute tools or hand tool calls to the client
- send results back through `/api/agent/v3/commit_toolcall_result`
- continue the same Trae task/session correctly

`1.0` requirement:

- simple text chat, streaming, and tool-calling must all work reliably

### 3. Stable Trae SSE/event parsing

Current state:

- the SSE parser now handles multi-line frames, stable id extraction, and tool-call block detection
- text extraction still depends on heuristics because the full upstream schema remains private
- reasoning/content split is still not modeled precisely

Why this matters:

- OpenAI-compatible clients expect stable chunk semantics
- heuristics are acceptable for debugging, not for `1.0`

`1.0` requirement:

- parse the actual Trae event schema and map it deterministically into streaming and non-streaming OpenAI responses

### 4. Auth lifecycle and token refresh

Current state:

- the gateway reads the current JWT from the local Trae profile
- it now detects expired local auth before sending upstream requests and returns a clear auth error
- it still does not actively refresh credentials

Risks:

- expired token breaks the gateway
- behavior depends on Trae having refreshed the token first

`1.0` requirement:

- either refresh automatically or detect expiration and recover cleanly
- return clear auth errors when recovery is impossible

### 5. Stable session mapping

Current state:

- session mapping is now persisted locally for external conversation ids
- `session_id` reuse is now stable when the client provides a repeatable conversation key
- follow-up state reuse is still incomplete for all Trae-side ids

Missing pieces:

- chat session persistence
- deterministic mapping from external chat to Trae `session_id`
- correct reuse of `task_id` / `message_id` / follow-up state

`1.0` requirement:

- one external conversation must reliably continue the same Trae-side session

### 6. Error handling and protocol hardening

Current state:

- upstream errors are now mapped into explicit auth, rate limit, timeout, server, and invalid request classes
- request timeout handling is now built into the client
- endpoint routing now falls back across Trae boot domains from the installed product config

Missing pieces:

- explicit handling for `401`, `403`, `429`, `5xx`
- timeout handling
- malformed template detection
- malformed upstream payload diagnostics
- retry strategy where safe

`1.0` requirement:

- failures must be classified and returned consistently

### 7. Real model/capability discovery

Current state:

- `GET /v1/models` now discovers recently observed models from local Trae logs
- tool capability hints can now be inferred from recent Trae tool-call activity

Missing pieces:

- discover actual available Trae models
- describe capabilities such as tool use, multimodal support, and reasoning support

`1.0` requirement:

- model list should reflect reality, not placeholders

### 8. Tests

Current state:

- automated tests now cover payload generation, SSE parsing, session persistence, and log-based model discovery

Minimum test coverage for `1.0`:

- auth loading from Trae storage
- product/domain loading
- `.env` loading
- template rendering
- SSE parsing
- OpenAI streaming adapter
- non-streaming adapter
- upstream error mapping

## Suggested milestones

## `0.2`

- keep current debug endpoints stable
- improve request/response logging with secret redaction
- document template capture workflow more precisely
- add smoke tests for server startup and auth loading

## `0.5`

- build a reliable parser for Trae SSE events
- add better session persistence and conversation mapping
- add upstream error handling and retry rules
- support one practical path end-to-end:
  simple text chat without manual debugging during normal use

## `1.0`

- no manual payload template required for standard chat
- stable OpenAI-compatible `chat/completions`
- working tool-call loop
- token lifecycle handled cleanly
- automated tests for critical paths
- documentation for Codex / Claude Code / OpenCode integration

## Definition of done for `1.0`

The gateway can be called `1.0` when all of the following are true:

- it can be started with `.env` only
- `POST /v1/chat/completions` works without a manually captured request template
- streaming and non-streaming outputs are both stable
- tool calls work through the full request/execute/commit cycle
- expired or invalid auth is handled predictably
- tests cover the critical adapter paths
- setup docs are sufficient for another user to deploy and use it without reverse-engineering Trae manually
