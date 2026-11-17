# Email setup (SMTP)

Nventra POS sends email (receipts, reports, marketing, alerts) through your
own SMTP server. Email stays off until both variables are set:

| Variable | Example |
|---|---|
| `SMTP_URL` | `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465` |
| `SMTP_FROM` | `"My Cafe <you@gmail.com>"` |

Use `smtps://` for implicit TLS (port 465) or `smtp://` with STARTTLS (port 587).
Put both lines in `.env` next to `docker-compose.yml`; `docker compose up -d`
passes them to the backend. Leave them empty to keep email disabled.

## Gmail app passwords

1. Turn on 2-Step Verification for the Google account.
2. Create an app password at https://myaccount.google.com/apppasswords.
3. Put the 16-character password in `SMTP_URL`, not your normal password.

## URL-encode special characters

`SMTP_URL` is a URL, so reserved characters in the username or password must be
percent-encoded. The most common one is `@` in an email address: write
`you@gmail.com` as `you%40gmail.com`. Other characters that need encoding
include `:`, `/`, `?`, `#` and `%`.

## Stock alerts
Every day at 07:00 the server notifies staff with `inventory.manage` (in-app, once per branch per local day) about batches expiring within `expiryAlertDays` (Settings → restaurant, default 7) and ingredients at or below their reorder level. When SMTP is configured the same digest is emailed to those users; without SMTP only the in-app notification is sent.

## Marketing unsubscribe links
Every marketing email carries a signed, per-recipient unsubscribe link (in the
footer and in the `List-Unsubscribe` / `List-Unsubscribe-Post` headers, RFC
8058). Set `PUBLIC_URL` (for example `https://pos.mycafe.com`) so the link
points at your server; it defaults to `http://localhost:1995`. Links expire
after a year. Opting out sets the customer's marketing opt-out, so later
campaigns skip them.

## Password reset by email
"Forgot password?" appears on the login page only when SMTP is configured
**and** `PUBLIC_URL` is set to a plain `http(s)://` address. Reset links are
always built from `PUBLIC_URL` (never from the request's Host header), work
once and expire after 30 minutes; the token sits in the URL fragment, so it
never reaches server logs. Requesting a reset answers the same for every
address. Limits: 5 requests per 15 minutes per IP (`PASSWORD_RESET_IP_LIMIT`)
and 3 emails per hour per account. Completing a reset signs the user out on
every device; two-factor authentication stays on. The PASSWORD_RESET email is
always sent: if a restaurant turns that template off, the built-in wording is
used instead.

## Staff invites
With the same setup (SMTP and `PUBLIC_URL`), Add staff offers "Email an invite
instead of setting a password". The account is created switched off; the
STAFF_INVITE email carries a single-use link (72 hours) to `/accept-invite`
where the person sets their password, which switches the account on. Staff
management shows "Invite pending" with Resend (the old link stops working;
3 emails per staff member per hour) and Revoke. All actions need
`users.manage`. Initial account creation may invite within your own access.
Sending or resending an invite for an existing account resets credentials,
so it requires strictly more access than that account; an owner may invite
anyone. Revoking stays within your own access, and only an owner can act on
an owner. Changing another account's login email also requires the credential-reset
ceiling; an unchanged email may accompany a harmless edit. Self-email editing
keeps its existing behavior. Administrative email, password or active-status updates invalidate
outstanding invite and reset links. Acceptance requires an inactive account.
Like password reset, the invite email is sent even if its template is off.
