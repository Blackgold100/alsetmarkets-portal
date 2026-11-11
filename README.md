# AlsetMarkets Client Portal

A secure investor portal. Clients log in to see their dashboard; your team enters and manages every figure from the admin console.

**Client dashboard:** total invested, account balance, total ROI (amount and %), available to withdraw, upgrade notice, account status, KYC status, tier, performance chart (1M–ALL), portfolio allocation, monthly performance, transactions, statements, and announcements.

**Crypto deposits & withdrawals:** clients see your company wallet addresses (with QR codes and copy buttons), send funds, and upload a **screenshot of the transfer** (required; PNG/JPG/WEBP up to 6 MB, stored in the database, visible only to the client and admins). The transaction hash is optional. The same screenshot or hash can't be submitted twice. They save their own withdrawal wallets, which an admin must verify before first use, and request withdrawals with password confirmation. Every request goes to your approval queue, with block-explorer links. Supported: USDT, USDC, BTC, ETH, BNB and SOL on Tron (TRC20), Ethereum (ERC20), BNB Smart Chain (BEP20), Polygon, Solana and Bitcoin.

**Investment plans:** Mining, Stocks, Crypto Trading, and Real-World Assets (property and short-term rentals; Alpha tier and above, 180-day lock-in). A plan can be limited to a tier and above under its **Settings**; clients below that tier see it locked, with an upgrade button. Clients move part of their available balance into a plan, confirming with their password and accepting the risk and lock-in terms. Each plan has its own minimum, lock-in period and risk level, all editable. Every week an admin enters each plan's **actual** result for the period. After a preview, the portal credits or debits every investor automatically and pro-rata, with a part-period share for investments that started mid-week. The most recent result can be undone. Clients see each plan's real past results, never a promised rate.

**Account upgrades:** the upgrade button opens the client's upgrade options (e.g. Professional, VIP), each with an upgrade amount and its real benefits, all set under **Admin → Tiers**. The client picks one and goes to the Deposit page with the amount filled in. The deposit goes into their own balance and stays withdrawable. When an admin approves the deposit, the tier changes automatically and the upgrade notice is hidden. Short deposits are flagged and don't upgrade. Admins can also upgrade or cancel manually.

**Tier thresholds:** each tier has a plan investment limit (defaults: Starter $2,000, Standard $10,000, Professional $50,000, Alpha $100,000, VIP no limit), editable under **Admin → Tiers**. The portal refuses new plan investments above the client's limit and prompts them to upgrade. Clients see their limit, how much they've used and the next tier's limit on the Plans and Upgrade pages. Profits earned inside plans don't count toward the limit, and withdrawals are never restricted by tier.

**Live support chat:** a chat button on every client page shows whether support is online. Admins answer from **Admin → Support chat**, which has an unread badge in the menu, optional desktop alerts, quick replies, assign/close controls and the client's balances beside the conversation. Messages update every few seconds. If no admin is online, the client gets an automatic reply saying the team will answer soon.

**Admin console:** add clients (with one-time temporary passwords), record deposits / profits / losses / fees / withdrawals, approve or reject pending requests, set account status, tier and KYC, write a per-client upgrade notice, add holdings and statement links, post announcements, reset passwords, preview any client's dashboard, and review a full audit log.

---

## Put it live on Replit (about 10 minutes)

### 1. Create the Repl
**Option A: from GitHub (recommended)**
1. Upload this folder to a new private GitHub repository.
2. In Replit, click **Create Repl → Import from GitHub** and choose the repository.

**Option B: from the zip**
1. In Replit, click **Create Repl**, choose the **Node.js** template, and name it `alsetmarkets-portal`.
2. Delete the template's sample files, then drag the *contents* of this folder (not the zip itself) into the file panel.

### 2. Add a database
Open **Tools → Database** (or search "PostgreSQL" in the Tools panel), then click **Create a database**. Replit adds the `DATABASE_URL` secret automatically.

### 3. Add Secrets
Open **Tools → Secrets** and add:

| Key | Value |
|---|---|
| `SESSION_SECRET` | A long random string (64+ characters). Generate one in the Replit Shell with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_EMAIL` | *(optional)* The email you will sign in with as administrator. Default `admin@alsetmarkets.com`. |
| `ADMIN_PASSWORD` | *(optional, recommended)* Your own admin password (10+ characters). If you leave it out, the default first-time login in **ADMIN-LOGIN.md** is used, and you must change it at first sign-in. |
| `SUPPORT_EMAIL` | *(optional)* e.g. `support@alsetmarkets.com`. Used for the "Add funds", "Withdraw" and "Contact" buttons. |
| `REGULATORY_NOTICE` | *(optional)* Footer text about the company's registration. Default: `AlsetMarkets is registered in San Salvador, El Salvador, under registration number 12890756.` Set it to override, e.g. to add a licence. |
| `ACCOUNT_TIERS` | *(optional)* Comma-separated tier names. Default: `Starter,Standard,Professional,VIP` |
| `MIN_DEPOSIT` / `MIN_WITHDRAWAL` | *(optional)* Minimum amounts in the client's base currency. Default `10`. |
| `WITHDRAWAL_REQUIRES_KYC` | *(optional)* `true` (default) blocks withdrawals until KYC is set to Verified. |

### 4. Run it
1. Click **Run**. In the console you should see `Admin account created for …` and then `AlsetMarkets portal running`.
2. Open the preview and sign in with your `ADMIN_EMAIL` / `ADMIN_PASSWORD`, or with the default login in **ADMIN-LOGIN.md**.
3. *(Optional)* In the **Shell**, run `npm test`. It checks sign-in, the dashboard maths, and crypto deposits and withdrawals (36 checks), then deletes its test data.

### 5. Deploy (make it public)
1. Click **Deploy → Autoscale** and keep the default build and run commands (`npm start`). Your secrets carry over.
2. After it deploys, you get a `….replit.app` address.
3. To use your own domain (e.g. `portal.alsetmarkets.com`), go to **Deployments → Settings → Link a domain** and add the DNS records Replit shows at your domain registrar.

> After the first deploy you can remove `ADMIN_PASSWORD` from Secrets. The admin account stays in the database.

---

## Set up crypto payments (once)
1. Go to **Admin → Wallets → Add a shared deposit address**. Pick the currency and network, then paste your company address twice (the second paste guards against typos and clipboard malware).
2. Add one address for each currency/network you accept, e.g. USDT on TRC20 and USDT on ERC20.
3. *(Optional)* To give a client their own address, open their record, go to **Crypto wallets**, and choose **Add a personal deposit address**. It replaces the shared one for that currency/network.

> Only paste addresses from wallets your company controls. Anyone with admin access can change them, so give admin access only to staff you trust, and check the audit log.

## Crypto request flow
- **Deposit:** the client sends crypto and submits the amount and transaction hash. A **pending deposit** appears in your queue on the Clients page. Check it on the block explorer (click the Tx link), then click **Approve** to credit their balance.
- **New withdrawal wallet:** the client adds an address, which appears under **Withdrawal addresses to verify**. Confirm it with the client (phone or video call), then **Approve**.
- **Withdrawal:** the client requests an amount (it can't exceed their available balance) and the amount is reserved straight away. Send the crypto from your wallet, paste the payout tx hash into the queue, and click **Mark paid**. The client sees the explorer link. Click **Reject** instead to release the reserved amount.

## Weekly plan results
1. Go to **Admin → Plans**. A plan with no result in the last 7 days is flagged **Weekly result due**.
2. Click **Post this week's result**. The period dates are filled in for you.
3. Enter the plan's actual return for the week, net of costs, from your trading, mining or brokerage records (e.g. `1.35` or `-0.80`). Add a note naming the source document.
4. Click **Preview distribution** to see every investor's change, then **Post result**.
5. Made a mistake? Click **Undo** on the latest result in **Results history**. It reverses every investor's entry.

Money in a plan is still part of the client's balance, but it's excluded from **Available to withdraw** until they move it out after the lock-in. Admins can **Release early** on a client's documented request.

## Support chat
- Keep **Admin → Support chat** open in a browser tab while you're on duty. Clients see "Online" while any admin has the portal open, and "Offline" after about 3 minutes away.
- Click **Turn on desktop alerts** once to get a pop-up when a new message arrives while the tab is in the background.
- Before discussing balances or withdrawals, confirm you're talking to the account holder. Never ask for passwords or seed phrases.

## Daily use

1. **Add a client:** go to **Admin → Add client**. Copy the temporary password shown and send it to the client securely. They must set their own password at first sign-in.
2. **Record money in:** open the client and add a **Deposit** under **Transactions**.
3. **Credit returns:** add a **Profit** (or **Loss**) entry, e.g. at month end, with a description such as "October trading profit".
4. **Charges:** add a **Fee** entry.
5. **Withdrawals:** clients request them from their Withdraw page (see above). You can also record one manually as a **Withdrawal** transaction.
6. **Upgrade notice:** open the client, then **Upgrade notice**, tick "Show on dashboard" and write the message.
7. **Statements:** upload the PDF to Google Drive, share it as "anyone with the link", and paste the link under **Documents**.
8. **Check your work:** click **View as client** to see exactly what they see.

**How the numbers are calculated.** Only *completed* transactions count.
- Total invested = deposits − withdrawals
- Account balance = total invested + profits − losses − fees
- Total return (ROI) = profits − losses − fees; ROI % = ROI ÷ total invested
- Available to withdraw = balance − pending withdrawals

## Security built in
- Passwords are hashed (bcrypt). Clients must replace the temporary password at first sign-in.
- After 5 failed sign-ins the account locks for 15 minutes, and repeated attempts are rate-limited.
- Sessions are stored in the database, cookies are HTTP-only and secure, and you are signed out after 30 minutes of inactivity.
- Every form is CSRF-protected, and strict security headers (CSP, frame blocking) are set.
- Clients can only ever see their own account. Admin pages reject client logins.
- Every admin action is written to the audit log.
- Crypto: addresses and transaction hashes are checked against each network's format, a hash can't be submitted twice, new withdrawal addresses need admin approval, adding a wallet or withdrawing requires the client's password, and withdrawal balance checks lock the account row so two simultaneous requests can't overdraw it.

## Run locally (optional)
```bash
cp .env.example .env   # fill in DATABASE_URL etc.
npm install
npm start              # http://localhost:3000
```

## Customising
- Logo: replace `public/logo.svg`.
- Colours: edit the variables at the top of `public/styles.css`.
- Wording: edit the `.ejs` files in `views/`.
