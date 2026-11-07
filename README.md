# Restock /

A back-in-stock alert tool for the [build challenge](https://github.com/yitzi-farla/back-in-stock-challenge/blob/master/BRIEF.md). Includes a storefront, an embeddable signup form, a password-protected request dashboard, and mobile-friendly HTML emails.

Built with Node.js 24, its built-in HTTP server and SQLite. No runtime dependencies and no frontend compilation.

## Run

```sh
cp .env.example .env
# Fill in the five credentials/URLs from your challenge dashboard.
node --env-file=.env server.js
```

Open `http://localhost:3000`. The app listens on `0.0.0.0:$PORT` (`3000` by default).

```sh
docker build -t restock .
docker run --rm -p 3000:3000 --env-file .env -v restock-data:/data restock
```

The volume retains subscriptions, received events, retries and delivery receipts across container replacement. Keep **one running application process per SQLite volume**. For multiple replicas, add transactional worker leases or move the outbox to a shared queue/database.

## Environment

| Variable | Purpose |
| --- | --- |
| `STOCK_API_URL` | Catalogue endpoint; individual stock is read from `/{sku}` |
| `STOCK_API_KEY` | Bearer token for the stock API |
| `RESEND_API_KEY` | Bearer token for the test email API |
| `RESEND_BASE_URL` | Test server base URL; mail goes to `/emails` here |
| `WEBHOOK_SECRET` | Required `X-Webhook-Secret` value |
| `PORT` | Optional listening port, default `3000` |
| `DATABASE_PATH` | Optional database file; Docker defaults to `/data/alerts.sqlite` |
| `ADMIN_PASSWORD` | Optional separate dashboard password; defaults to `WEBHOOK_SECRET` |

Admin username: **admin**. Keep the password and harness dashboard URL private. Use HTTPS for the public demo. The supplied email sender is a sandbox identity; configure a verified sending identity before using a real email provider. Do not use real customer data in this challenge.

## Endpoints

| Method / route | Behavior |
| --- | --- |
| `GET /` | Storefront with the sandbox's current catalogue |
| `GET /embed?sku=TEE-ORG-WHT-M` | Accessible email/SKU form, suitable for an iframe |
| `POST /api/requests` | JSON `{ "email": "you@example.com", "sku": "TEE-ORG-WHT-M" }`; `201` for a new request, `200` for an existing open request |
| `POST /webhooks/stock` | JSON `{ "event_id": "evt_1", "sku": "TEE-ORG-WHT-M", "quantity": 5 }` with `X-Webhook-Secret`; durably records the event and returns `202` |
| `GET /admin` | HTTP Basic authentication; request status, notification timestamp and retry information |
| `GET /healthz` | Database/readiness check |

## Preventing missed and duplicate mail

- SQLite has a unique constraint on each open `(email, sku)` request. Concurrent signups return the same request. A customer may create a new alert after their earlier notification completed.
- Webhook IDs are durable and unique. Replays are acknowledged; reuse with a different SKU or quantity returns `409`. The secret is checked with a constant-time comparison before parsing the event body.
- Webhook quantity is a hint. The worker checks the authenticated stock API, then queues the waiting requests and completes the event in one transaction. A phantom restock does not send mail. A temporary stock API failure keeps the event pending for retry.
- Requests are also checked after signup, covering a customer joining while an item is already available.
- The email outbox and its payload are persisted. Every delivery checks current stock again. Failed stock checks and email calls retry with exponential backoff, capped at five minutes. Work survives restart without another webhook.
- A stable `Idempotency-Key: restock-request-{id}` is used for every attempt, with an identical stored email payload. A lost response after the provider accepts a message can be retried safely. Requests are marked notified only after a successful response containing a receipt ID. An interrupted `sending` row is returned to the queue on startup.

The delivery guarantee depends on the mail provider honoring idempotency for the retry period and the SQLite volume being retained. The challenge's mock Resend API honors those keys. Real Resend has a finite idempotency window; a production deployment needs a reconciliation policy for uncertain deliveries beyond that window. Failed deliveries are retained and visible in the admin page; they are never silently discarded.

Stock can sell out between the final API check and the customer reading the email. The email states that an alert does not reserve inventory.

## Validation

```sh
npm test
```

The HTTP integration suite covers invalid input and unauthorized access, concurrent duplicate signups/webhooks, conflicting event IDs, phantom stock, stock API outages, email failure, lost email receipts, persistent pending subscriptions, in-flight recovery after restart, HTML escaping and repeat subscriptions. It uses a temporary on-disk SQLite database and controlled stock/email services.

Pull-request CI repeats the tests, builds the Docker image, and verifies the container starts and serves the form. Builds are performed in CI.

## AI assistance

Created with OpenAI Codex, including implementation, test drafting, debugging and review. No claim of unaided coding is made.
