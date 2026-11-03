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
