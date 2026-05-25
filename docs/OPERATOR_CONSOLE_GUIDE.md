# Operator Console Guide

The Operator Console is the operator's direct workspace inside the BlackCEO Command Center. It groups ten sub-modules that the operator uses every day. The Console lives at `/operator`. The home page card titled Operator Console (5th of 6 cards) opens it.

This guide walks through each sub-module, what it is for, and how to invoke it from the global Cmd+K palette.

The Console assumes the platform helpers in [`../src/lib/platform.ts`](../src/lib/platform.ts) for path resolution. On the operator's Mac Mini the vault lives at `~/clawd/`. On a VPS Docker deployment the vault lives at `/data/.openclaw/workspace/`. See [`PLATFORM_DETECTION.md`](./PLATFORM_DETECTION.md) for the full mapping.

## 1. Bridge

![screenshot](./images/operator-bridge.png)

Bridge is the multi-backend chat surface. From a single text input the operator can route a turn to any of seven backends: Claude Code (terminal native), Codex (OpenAI), Antigravity (xAI), Hermes (NousResearch), Gemini (Google), Free Claude Code, and OpenClaw itself. Each backend has its own scratch directory under [`operatorScratchRoot()`](../src/lib/platform.ts) so working files do not collide.

Use Bridge when the operator wants the response from a specific brain, or when the operator wants to A/B the same prompt across two backends. The backend pill at the top-left of the message strip shows which agent answered. Output streams in. Tool calls and file writes that a CLI agent performs land in the corresponding scratch directory and are surfaced in the right rail.

## 2. Workspace

![screenshot](./images/operator-workspace.png)

Workspace is the operator's file index. It shows two complementary buckets: a by-agent view (all files written by each backend, useful when chasing what Codex just produced) and a by-type view (markdown, json, image, video, audio). Selecting a file opens a preview pane. Markdown renders with syntax-highlighted code blocks. Images, video, and audio render inline with a download button.

Workspace reads from the vault root and from each agent's scratch directory. Files persist across sessions because the storage location is on the persistent volume (Mac home directory or Hostinger Docker `/data` mount).

## 3. Studio

![screenshot](./images/operator-studio.png)

Studio is the generative media surface. It exposes image generation, video generation, and audio generation behind a single panel. The provider dropdown lists every model in `model_registry` that carries the relevant capability tag (`image_generation`, `video_generation`, `audio_generation`). Recent providers include Fal.ai, Kie.ai (Sora wrapper, Veo), Replicate, Fish Audio, and ElevenLabs.

Outputs land in the vault under `Studio/<provider>/<timestamp>-<seed>.<ext>` so they are easy to grep for later. The right rail shows generation status and any model warnings (rate-limit, safety, deprecation).

## 4. Notebook

![screenshot](./images/operator-notebook.png)

Notebook is a lightweight research lab. The operator pastes URLs, PDFs, or raw text as sources. Each source is parsed, chunked, and indexed locally. Below the source list, the operator types questions or asks for summaries. The model uses the indexed sources as context.

Notebook is intentionally smaller than Research (sub-module 8). Notebook is for personal study and slow synthesis. Research is for time-bounded queries with web access.

## 5. Goals

![screenshot](./images/operator-goals.png)

Goals tracks the operator's near-term, mid-term, and long-term objectives. Each goal has a title, a target date, a status (active, paused, achieved, abandoned), and a freeform notes block. Goals write to `Goals/` under the vault root and the Memory sub-module indexes them so they are searchable.

The "today" view rolls active near-term goals into a single scrollable list. The operator can mark progress and capture a one-line journal note inline.

## 6. Journal

![screenshot](./images/operator-journal.png)

Journal is the operator's daily log. One entry per day by default, with a date header and a freeform body. Tags (hash-prefixed) are extracted and indexed. The model can answer questions like "what did I work on last Tuesday" by querying the journal index.

Journal entries write to `Journal/YYYY/MM/YYYY-MM-DD.md` under the vault. The format is plain markdown so the operator can edit the same file in Obsidian or any other editor without going through the Console.

## 7. Memory

![screenshot](./images/operator-memory.png)

Memory is the cross-vault full-text search. It indexes every markdown file in `Goals/`, `Journal/`, `Notebook/`, `Workspace/` (markdown only), and any operator-curated subfolder. Queries support FTS5 syntax: phrase queries with quotes, AND/OR/NEAR, and prefix matching with `*`.

The result list shows file path, snippet with the matched terms highlighted, and a one-click open. Behind the scenes Memory uses SQLite FTS5 on the dashboard's mission-control database with a periodic indexer (registered via the cron scheduler from P0-6) rebuilding the index hourly.

## 8. Research

![screenshot](./images/operator-research.png)

Research wraps Grok Live Search (xAI). The operator types a research question. The provider performs a live web search, fetches and reads the top sources, and synthesizes an answer with citations. Each citation is a clickable link plus the original snippet that supported it.

Research results write to `Research/<YYYY-MM-DD>/<slug>.md` in the vault so they can be re-opened, edited, and surfaced later by Memory search. Research requires `X_AI_API_KEY` to be set in the env file. If the key is missing, the sub-module shows a "configure key" prompt instead of the search box.

## 9. Call Mode

![screenshot](./images/operator-call.png)

Call Mode is half-duplex voice. The operator speaks. Speech-to-text transcribes. The selected text model responds. Text-to-speech synthesizes the answer and plays it. The interaction is push-to-talk: hold the mic button to record, release to send. Half-duplex (versus full-duplex) is intentional for v4.0.1 so that latency stays predictable and the operator can interrupt mid-response by tapping the mic again.

TTS provider priority is configurable. Defaults are OpenAI first (broadest coverage, requires `OPENAI_API_KEY`), then ElevenLabs (best voice quality, requires `ELEVENLABS_API_KEY` plus voice id), then Fish Audio (natural prosody, requires `FISH_AUDIO_API_KEY` plus voice id), then xAI Grok voice (only on plans with voice access), then browser-native as the last resort.

## 10. Web Agent

![screenshot](./images/operator-webagent.png)

Web Agent dispatches Anthropic Computer Use to operate a real browser on the operator's behalf. The operator types a task ("find the cheapest flight from Atlanta to Lisbon next Friday and screenshot the booking page"). The agent opens a sandboxed browser, navigates, clicks, types, and returns a transcript plus screenshots.

Web Agent runs against the Anthropic API directly. It requires `ANTHROPIC_API_KEY` in the env file. The transcript and any screenshots write to `WebAgent/<YYYY-MM-DD>/<task-slug>/` in the vault. Long-running tasks stream progress to the UI so the operator can intervene or abort.

## Cmd+K palette

The global command palette (Cmd+K on Mac, Ctrl+K on Linux/Windows) is mounted at the root layout as of v4.0.1 P0-3, so it works from any page including the home screen.

The palette accepts free-text and surfaces the most relevant sub-module or action. Built-in shortcuts:

  - `bridge` -> open Bridge
  - `workspace` or `files` -> open Workspace
  - `studio` -> open Studio
  - `notebook` -> open Notebook
  - `goals` -> open Goals
  - `journal` -> open Journal (creates today's entry if missing)
  - `memory` or `search` -> open Memory with the query prefilled
  - `research` -> open Research with the query prefilled
  - `call` or `voice` -> open Call Mode
  - `web agent` or `browser` -> open Web Agent

The palette also lists global actions: "Open Intelligence Settings", "Open Departments", "Open CEO Board", "Re-run bootstrap" (calls `/api/system/bootstrap`, see P1-13), and "View system status".

If you type a query that does not match a known command, the palette routes to Memory full-text search with the query as the seed. This makes Cmd+K the universal "find anything I've ever written" entry point.

## Where things live

  - Vault root on Mac Mini: `~/clawd/`
  - Vault root on VPS Docker: `/data/.openclaw/workspace/`
  - Agent scratch root on Mac Mini: `~/clawd/scratch/`
  - Agent scratch root on VPS Docker: `/data/.openclaw/scratch/`
  - Memory full-text index: `mission-control.db` (SQLite, in the repo root)
  - All paths are resolved through helpers in [`../src/lib/platform.ts`](../src/lib/platform.ts)

See [`PLATFORM_DETECTION.md`](./PLATFORM_DETECTION.md) for the platform-aware path logic.
