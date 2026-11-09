# Admin login

## Default first-time login

If you **don't** set `ADMIN_PASSWORD` in Replit Secrets, the portal creates this administrator the first time it starts:

| | |
|---|---|
| Sign-in page | `https://<your-app>.replit.app/login` |
| Email | `admin@alsetmarkets.com` (or your `ADMIN_EMAIL` secret, if set) |
| Password | `AlsetAdmin@2026` |

The portal makes you choose a new password at first sign-in. After that the default password no longer works, and it can't be chosen again.

**Sign in and change it as soon as the site is live.** This file is in your code repository, so anyone who can see the repository knows the default password until you change it. Keep the repository private.

## Using your own password instead (recommended)

Add these in **Replit → Tools → Secrets** before the first run:

- `ADMIN_EMAIL`: your email
- `ADMIN_PASSWORD`: your own password (10+ characters)

The default above is then never used.

## Notes

- The admin account is created only once, the first time the database has no administrator. Changing the secrets later doesn't change an existing account. Change your password from **Team → Change your own password**.
- The workspace (Run) and the live site (Deploy) use separate databases, so each gets its own first-time admin.
- Locked out? From the Replit **Shell**, run `node scripts/reset-admin.js you@example.com`. It prints a new temporary password.
