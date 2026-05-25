# Model capabilities vocabulary

Canonical reference for the 16-tag capability vocabulary used across the
BlackCEO Command Center model registry, filter UI, and provider connectors.

The source of truth for the union itself is `src/lib/model-providers/types.ts`
(`ModelCapability`) re-exported via `src/lib/model-registry.ts` as
`MODEL_CAPABILITIES`. The capability filter bar in Intelligence Settings
groups these tags into 4 categories purely as a UI affordance; the wire
contract is the flat string union.

## Categories

The filter UI groups the 16 tags into 4 buckets. The grouping lives in
`src/components/settings/ModelFilterBar.tsx` (`CAPABILITY_GROUPS`).

| Category | Tags |
|---|---|
| Input modalities | `text`, `vision`, `audio_input` |
| Output modalities | `image_generation`, `video_generation`, `audio_generation`, `audio_transcription` |
| Capabilities | `tool_use`, `reasoning`, `streaming`, `structured_output`, `long_context`, `code_execution`, `computer_use`, `web_search` |
| Other | `embeddings` |

## Tag reference

### Input modalities

#### `text`
Model accepts plain text input. The baseline tag carried by virtually every
LLM. Example models: `gpt-4o-mini`, `claude-sonnet-4`, `grok-2`, `llama-3.3-70b`.

#### `vision`
Model accepts image input alongside text (multimodal vision). Example models:
`gpt-4o`, `claude-sonnet-4-5`, `gemini-2.5-pro`, `grok-vision-beta`.

#### `audio_input`
Model accepts raw audio input (for transcription, audio understanding, or
voice-to-voice). Example models: `gpt-4o-audio-preview`, `gemini-2.5-pro`,
`whisper-1`.

### Output modalities

#### `image_generation`
Model produces image output from text or image+text prompts. Example models:
`dall-e-3`, `imagen-3`, `flux-pro-1.1` (Fal), `stable-diffusion-xl` (Replicate).

#### `video_generation`
Model produces video output. Example models: `veo-2` (Google), `kling-1.5`
(KIE), `runway-gen-3`, `luma-dream-machine`.

#### `audio_generation`
Model produces audio output (TTS or music synthesis). Example models:
`gpt-4o-mini-tts`, `eleven-multilingual-v2` (ElevenLabs), `suno-v4`.

#### `audio_transcription`
Model converts speech audio into text (ASR). Example models: `whisper-1`
(OpenAI), `whisper-large-v3` (Groq), `nova-2` (Deepgram).

### Capabilities

#### `tool_use`
Model supports structured function/tool calling. Example models:
`gpt-4o-mini`, `claude-sonnet-4-5`, `gemini-2.5-pro`, `grok-2`.

#### `reasoning`
Model exposes chain-of-thought / extended reasoning (separate "thinking"
budget). Example models: `o1`, `o3-mini`, `claude-sonnet-4-5` (extended
thinking), `gemini-2.5-pro` (thinking mode), `deepseek-r1`.

#### `streaming`
Model supports incremental Server-Sent Events / streamed token delivery.
Example models: `gpt-4o-mini`, `claude-sonnet-4-5`, `gemini-2.5-pro`,
most chat-oriented LLMs.

#### `structured_output`
Model can be constrained to emit valid JSON conforming to a provided
schema (response_format / JSON mode). Example models: `gpt-4o-mini`
(strict mode), `gemini-2.5-pro`, `claude-sonnet-4-5`.

#### `long_context`
Model accepts >= 200k tokens of context in a single request. Example
models: `claude-sonnet-4-5` (1M beta), `gemini-2.5-pro` (2M), `gpt-4.1`
(1M), `grok-4` (256k).

#### `code_execution`
Model can run code in a sandboxed interpreter as part of the response.
Example models: `gpt-4o` (Code Interpreter), `gemini-2.5-pro` (code
execution tool), `claude-sonnet-4-5` (Bash/Code tools).

#### `computer_use`
Model can drive a computer (screenshots, mouse, keyboard) via the
Anthropic Computer Use protocol. Example models: `claude-sonnet-4-5`
(computer-use beta), `claude-opus-4`.

#### `web_search`
Model has first-party access to live web search results inside the model
call. Example models: `grok-2` (Live Search), `gemini-2.5-pro` (grounding
with Google Search), `gpt-4o-search-preview`.

### Other

#### `embeddings`
Model produces vector embeddings rather than generative output. Example
models: `text-embedding-3-small`, `text-embedding-3-large`,
`voyage-3-large`, `cohere-embed-v3`.

## Adding a new capability

1. Add the new tag to the `ModelCapability` union in
   `src/lib/model-providers/types.ts`.
2. Add an icon + label + Tailwind class entry to `CAPABILITY_META` in
   `src/components/settings/CapabilityBadge.tsx` so badges render.
3. Add the new tag to exactly one group in `CAPABILITY_GROUPS` in
   `src/components/settings/ModelFilterBar.tsx` so the filter chip
   surfaces.
4. Document the new tag in this file under the matching category with a
   1-line description and 1-3 example models.
5. Audit the 13 provider connector files under `src/lib/model-providers/`
   and add the tag to any model that supports it.
