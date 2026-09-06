# Client interview launch and recovery

Paired releases: Command Center v7.1.2 and onboarding v25.0.5.

1. Installation initializes a pending build with stable client/company/installation identity before exposing the shell. Fresh installations use standard-first onboarding. Existing recorded lanes and operator choices are preserved.
2. Onboarding provisions client-specific service configuration, binds its database company, and creates the standard department foundation before the interview. A receipt hashes the company artifacts and records the expected department workspaces.
3. The public Command Center must answer authenticated `GET /api/auth/interview-ready` with `interview-launch.v1`, the exact expected identity and host, `interviewComplete: false`, and all local prerequisites ready. The endpoint checks the actual foundation files and active same-company workspaces. Generic health, HTML and foreign responses are insufficient.
4. The sender calls operator-authenticated `POST /api/auth/interview-invitation` with the resolved recipient hash. It verifies the returned identity/origin and sends `/interview#enroll=...` through the client's own Telegram configuration. The one-use ticket expires after 15 minutes. Never copy invitation fragments or bearer tokens into logs.
5. The browser redeems the ticket for its tenant session. Answers persist in the client-scoped interview and can be resumed or exported. If access expires, a new invitation resumes the same durable interview; the original ticket cannot be redeemed twice.
6. Completing the interview requests the existing authenticated build handoff. An unavailable receiver leaves the handoff pending, not completed. The standard foundation is personalized through the existing interview diff/build pipeline; departments are added or archived according to confirmed answers. Workforce activation and verified closeout govern full dashboard access.
7. Skill 37 keeps locally generated closeout artifacts recoverable until the client's own Notion token and verified parent are available. An agency or another client's workspace is never a substitute. Final delivery and completion require their existing verification receipts.

## Verification boundary

Readiness is a prerequisite check, not a paid model turn. The receipt explicitly reports `providerLiveness: "unverified"`. Local automated tests exercise storage, authentication, shell UI, foundation validation and mocked external handoffs. Live acceptance must still verify the client's own Cloudflare hostname, Telegram delivery, interviewer provider, completed build and Notion delivery on the installed client machine.
