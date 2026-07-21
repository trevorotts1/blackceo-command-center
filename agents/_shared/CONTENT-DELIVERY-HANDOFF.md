# CONTENT-DELIVERY-HANDOFF.md — v1 (shared contract)

**Schema version:** `content-delivery-handoff/v1`

The seam this contract governs is the one between AUTHORING and SENDING TO A
RECIPIENT. The Content Writer creates content and does not send it; the
Communications Agent takes content from the Content Writer and delivers it.
Neither directory previously defined the shape of what crosses between them, an
approval state, or a delivery receipt — so nothing distinguished a draft from
approved copy, and nothing proved what was actually sent.

Both sides validate against this file. A payload that does not conform is
**refused, not repaired**.

---

## Direction 1 — Content Writer → Communications Agent (the handoff)

```json
{
  "schema": "content-delivery-handoff/v1",
  "handoff_id": "<opaque id, unique per handoff>",
  "content_ref": "<opaque reference to the stored content — never the body inline>",
  "channel": "email | sms | newsletter | push",
  "rendered": {
    "subject": "<string, required for email/newsletter, omit otherwise>",
    "body": "<string, the exact bytes to be delivered>",
    "preheader": "<string, optional>"
  },
  "recipient_ref": "<opaque reference to the audience or contact record>",
  "approval": {
    "state": "draft | pending_approval | approved | rejected",
    "approved_by": "<opaque actor reference, required when state == approved>",
    "approved_at": "<ISO-8601 UTC, required when state == approved>",
    "note": "<string, optional>"
  },
  "created_at": "<ISO-8601 UTC>"
}
```

### Field rules

| Field | Rule |
|---|---|
| `schema` | Exactly `content-delivery-handoff/v1`. A different value is refused, never coerced. |
| `content_ref` | Opaque. The body travels in `rendered`; the reference is what is auditable. |
| `channel` | One of the four listed values. An unknown channel is refused. |
| `rendered.body` | Non-empty. An empty body is refused — there is no such thing as sending nothing. |
| `recipient_ref` | **Opaque reference only.** Never an email address, phone number or personal name in this document. |
| `approval.state` | See the state rule below. |

### The state rule — the load-bearing line

**The Communications Agent sends only when `approval.state == "approved"` AND
both `approved_by` and `approved_at` are present.**

- `draft` / `pending_approval` → hold. Report held, do not send, do not ask the
  writer to re-send the same payload.
- `rejected` → return to the Content Writer with `approval.note`. Never send.
- `approved` without `approved_by` or `approved_at` → **refuse the payload as
  malformed.** An approval with no approver is not an approval; treating it as
  one is the exact failure this contract exists to prevent.

---

## Direction 2 — Communications Agent → Content Writer (the receipt)

Every attempted delivery produces a receipt. A send with no receipt is an
unproven send and must be reported as such — never as a completion.

```json
{
  "schema": "content-delivery-receipt/v1",
  "handoff_id": "<the handoff_id this receipt answers>",
  "outcome": "delivered | rejected | failed | held",
  "provider": "<sending system name — no credential, no value>",
  "provider_message_id": "<the id the provider issued, required when outcome == delivered>",
  "recipient_count": 0,
  "sent_at": "<ISO-8601 UTC, required when outcome == delivered>",
  "error": "<string, required when outcome is rejected or failed>"
}
```

### Receipt rules

- `outcome: delivered` **requires** a non-empty `provider_message_id` and
  `sent_at`. Without a provider-issued identifier the send is not proven, and the
  outcome is `failed`, not `delivered`. Never synthesise an identifier.
- `outcome: held` carries the approval state that caused the hold in `error`.
- `recipient_count` is the count the provider reported, not the count requested.
  If the provider reported no count, the field is `null` and the outcome cannot
  be `delivered`.

---

## What neither side may do

- Neither side puts a recipient's name, email address or phone number into a
  handoff, a receipt, a log line or a report. References are opaque.
- The Communications Agent never edits `rendered` — if the copy is wrong it goes
  back to the Content Writer as `rejected`.
- The Content Writer never sets `approval.state` to `approved` on its own
  authorship. An author is not an approver.
