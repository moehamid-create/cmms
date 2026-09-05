# Free secure deployment

## Render + Neon

Set these exact Render environment variables:

- `NODE_ENV=production`
- `DATABASE_URL`: Neon Postgres connection string
- `SESSION_SECRET`: random value of at least 32 characters
- `ALLOWED_ORIGINS`: comma-separated exact origins, or leave empty for same-origin only

The app refuses to start in production without a strong `SESSION_SECRET`. After first login (`admin / 1234`), change the password immediately from the Users screen — anyone with the default password can sign in until you do.

The app uses secure HttpOnly session cookies, CSRF headers for mutations, same-origin defaults, bounded JSON payloads, rate limits, strict browser security headers, and privacy-safe tenant tracking tokens.

For local Docker or Node use, SQLite remains available when `DATABASE_URL` is not set. Use a unique `SESSION_SECRET` outside production as well.
