# AlsetMarkets Client Portal

## Run on Replit
- Existing stack: Node.js 20, Express, EJS, and PostgreSQL. Keep this structure.
- Use the **Start application** workflow (or Run): `PORT=5000 npm start`.
- Required secrets: `DATABASE_URL` (Replit-managed PostgreSQL) and `SESSION_SECRET`.
- Startup applies the existing `src/schema.sql` and creates the first administrator if none exists.
- The imported first-login instructions are in `ADMIN-LOGIN.md`. Without an `ADMIN_PASSWORD` secret, the imported default account requires a password change at first login. Change it before adding client data or sharing the portal.
- Optional settings are documented in `README.md`; use Replit Secrets for passwords.

## Verify
- `npm test` starts a separate server on port 3999, uses throwaway accounts in the development database, and removes its test data afterward. Never run it against production.
- `/healthz` is the health endpoint.
- Production retains frame-blocking security headers. Development permits Replit's embedded preview.
