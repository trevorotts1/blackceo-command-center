# Chat approvals

The owner can approve from three places: the Command Center page (`/approvals/<request_id>`), Telegram, or the OpenClaw chat app. Every path ends in the same `launch_approvals` record (`authenticated_platform_record`, same scope and plan binding).

## Contract

`POST /api/approval-requests/<request_id>/chat-decision` with `Authorization: Bearer $MC_API_TOKEN` (the agent relays).

```json
{ "decision": "approve" | "changes",
  "channel": "telegram" | "webchat",
  "source_message_ref": "telegram:<owner_chat_id>:<message_id>",
  "note": "optional" }
```

`webchat` refs are `webchat:<session_id>:<entry_id>`. Success (200) returns the request with `status` (`approved` or `changes_requested`) and, on approve, `approval_id` (the value for `CAF_APPROVAL_ID`). A repeat of the same message returns the same `approval_id` with `replayed: true`.

Failure is 400 (bad body), 403 or 409, as `{ "error": "<code>", "detail": "<sentence the agent can relay>" }`, and nothing is minted. Codes: `message_not_found`, `inbound_record_unavailable`, `owner_not_registered`, `not_from_owner`, `sender_is_bot`, `message_before_request`, `request_expired`, `text_not_a_decision`, `text_does_not_match_decision`, `ambiguous_request`, `message_for_other_request`, `message_already_used`, `request_not_pending`, `amount_not_shown` (a budget reply that does not show the amount).

`GET /api/approval-requests/<id>` also returns `short_code` (first 6 characters of `request_id`) and `approve_by: ["command_center","telegram","chat_app"]`.

A spending budget is registered as `kind: "paid_asset_budget"` with `cap_minor` (minor units, e.g. cents) and `currency`. Approving it by chat or on the page mints the launch approval with that same cap, and the page shows the spending limit. A chat approval of a budget must show the amount and be tied to the request: the agent's approval message states the amount and the code (for example `Picture budget: $25.00 USD. Code: <short_code>`) and the owner replies to that message, or the owner's own words contain both the amount and the code. A reply that does not show the amount is refused with `amount_not_shown`. An inline button never approves a budget (`amount_not_shown`), and the "only pending request" shortcut does not apply, so an answer with the amount but no code and no reply is refused with `ambiguous_request`.

## What Command Center checks itself (never the agent's claim)

It reads the owner's message from the gateway's own record, read-only: Telegram from `openclaw.sqlite` (`plugin_state_entries`, namespace `telegram.message-cache`, key `<botHash>:<account>:<chatId>:<messageId>`; directory from `OPENCLAW_STATE_DIR`, else `~/.openclaw/state`, or `/data/.openclaw/state` on VPS); webchat from the session transcript `agents/<agent>/sessions/<session>.jsonl`. Then it requires all of:

1. the message exists; 2. its chat and sender are the registered owner chat (`resolveOwnerChatId()`); 3. the sender is not a bot; 4. it was sent after the request was created and before it expired; 5. its words are a clear English yes (approve, yes, ok, looks good, go, thumbs up) or a clear change request, matching the claimed decision; 6. it is bound to this request: a reply to the agent's approval message carrying this request's code, or text containing the 6-character code, or an inline-button callback naming the full request id, or this is the owner's only pending request. For a `paid_asset_budget` request only the first two count, and the amount must also appear in the quoted message or the owner's words.

The agent must put `Code: <short_code>` in every approval message it sends.

## Telegram inline buttons

Buttons are for `automation_write` and `publish` only. Never send buttons for a `paid_asset_budget` request: a click carries no amount and is refused. Ask the owner to reply to the message that states the amount.

`openclaw message send --channel telegram --presentation '<json>'` supports `buttons` blocks (verified in the OpenClaw 2026.11 CLI help and `docs/channels/telegram/rich-messages.md`). A callback click is delivered to the agent as an owner message with the text `callback_data: <value>`. Use the value `apr:<request_id>:<approve|changes>`:

```json
{"blocks":[{"type":"buttons","buttons":[
  {"label":"Approve","action":{"type":"callback","value":"apr:<request_id>:approve"},"style":"success"},
  {"label":"Request changes","action":{"type":"callback","value":"apr:<request_id>:changes"}}]}]}
```

When the agent relays the click it sends the click's message reference. Command Center verifies it like any other owner message and accepts `callback_data: apr:<request_id>:<decision>` (the full id binds it to the request). Not verified: whether the gateway writes callback clicks into `telegram.message-cache`. If it does not, `message_not_found` is returned and the owner can type "approve <code>" instead; text replies work regardless.

## Honest limit

An agent with shell on the box could in theory tamper with local stores. This design stops the realistic failure: an agent claiming or hallucinating an approval, because Command Center needs a real owner message it reads itself. The webchat reader fails closed on anything it cannot parse; its transcript shape was not verified against a live 2026.11 gateway (none on this build machine).
