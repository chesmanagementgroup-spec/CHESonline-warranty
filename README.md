# CHES Online — Equipment & Warranty Platform

设备登记与保修平台 · Device registration, warranty tracking and manufacturer
service requests for CHES Management Group.

Two front doors onto one database:

| | Who | What they do |
|---|---|---|
| `/` → `/portal` | The customer | Register equipment as it arrives, keep their address / phone / on-site after-sales contact current, see what is still in warranty, and report a fault by picking the machine off their own list |
| `/admin` | CHES staff | Upload a Xero **INVOICE** and turn it into tracked equipment records, maintain customer and equipment details, and forward a service request on to the manufacturer |

Every service request lands in the CHES inbox as a system email the moment it
is submitted, with the warranty status, serial number, site address and on-site
contact already filled in — ready to forward to the factory.

---

## How the pieces fit together

```
Xero INVOICE (PDF/CSV)
        │  staff upload it in /admin
        ▼
  parsed line items ──► staff check and correct ──► one device record per machine
                                                       (asset tag CHES-000123)
        │
        │  optional: "email the customer to register"
        ▼
  customer signs in with an emailed code, confirms the DELIVERY DATE
        │                                        └─ warranty clock starts here
        ▼
  something breaks → customer picks the machine → service request WR-2026-0001
        │
        ├──► system email to CHES (warranty status, serial, site contact, photos)
        ├──► receipt to the customer
        │
        ▼
  staff open the request in /admin → "Forward to manufacturer"
        └──► pre-written email to the brand's service inbox, replies come back to CHES
```

**Warranty is counted from the date the machine was received on site**, not
from the invoice date. Until the customer confirms delivery, the portal shows a
*provisional* end date derived from the invoice and keeps the machine flagged
as awaiting registration.

A line with quantity 3 becomes **three separate machines**, each with its own
asset tag and serial number field — because faults and warranties happen per
machine, not per invoice line.

---

## Running it

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # then edit it — see below
npm run seed -- --email you@chesonline.com.au --password 'a-strong-password'
npm start
```

Then open <http://localhost:3000> (customer portal) and
<http://localhost:3000/admin> (CHES console).

To try it with sample data:

```bash
npm run seed -- --demo
```

That creates *Sunrise Cafe Pty Ltd* (`demo@sunrisecafe.com.au`) with three
machines. In development the sign-in code is shown on screen and printed to the
server log, so you can sign in without a working mailbox.

Run the tests with `npm test` — they exercise the whole path from invoice
upload through to the manufacturer email, against a throwaway database.

---

## Configuration (`.env`)

| Setting | What it does |
|---|---|
| `APP_BASE_URL` | Public URL of the platform. Goes into every email link — set it before going live. |
| `SESSION_SECRET` | Long random string. **Required in production**; generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CHES_SERVICE_EMAIL` | Where new service requests land. This is the system email. |
| `CHES_FROM_EMAIL` / `CHES_FROM_NAME` | The From: address customers and manufacturers see |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | Outgoing mail. **Leave `SMTP_HOST` blank and nothing is actually sent** — messages are written to `data/outbox/*.eml` and the Email log tab instead. Useful for testing; the console shows a warning while it is in that state. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Creates the first staff account on first boot if no staff exist |
| `DEFAULT_WARRANTY_MONTHS` | Default cover applied to imported equipment (12) |
| `DATA_DIR` | Where the SQLite database and uploads live (`./data`) |

### Gmail

If CHES sends from the Gmail account, use an **App Password** (Google Account →
Security → 2-Step Verification → App passwords), not the account password:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=chesmanagementgroup@gmail.com
SMTP_PASS=the-16-character-app-password
```

---

## Deploying

The app is a plain Node server with a SQLite database on disk — it runs
anywhere that gives you a persistent disk (Render, Railway, Fly.io, a VPS).

1. Set the environment variables above. `NODE_ENV=production` and a real
   `SESSION_SECRET` are both required.
2. Give it a **persistent volume mounted at `DATA_DIR`**. This holds the
   database, uploaded photos and invoices. On a platform with an ephemeral
   filesystem, data is lost on redeploy without one.
3. Terminate TLS in front of it (every host does this for you). Session cookies
   are marked `secure` in production, so the site must be served over HTTPS.
4. Start with `npm start`.

Back up `DATA_DIR` — that single directory is the whole system of record.

Scaling note: SQLite means one server process. That is the right choice at this
size (thousands of machines, a handful of staff). If CHES ever outgrows it, the
schema in `server/schema.sql` ports to Postgres with only the queries in
`server/routes/` needing review.

---

## What is where

```
server/
  index.js              express app, static hosting, file access control, boot
  config.js             environment configuration
  schema.sql            the database, with comments on every table
  db.js                 connection + asset tag / claim reference counters
  auth.js               sessions, email login codes, staff passwords
  mailer.js             SMTP with a data/outbox fallback; every email is logged
  routes/
    auth.js             sign-in for customers (code) and staff (password)
    portal.js           the customer side of the API
    admin.js            customers, equipment, requests, manufacturers, email log
    invoices.js         invoice upload → draft → commit to device records
  lib/
    invoiceParser.js    reads Xero PDF/CSV line items, guesses brand and model
    dates.js            date parsing and the warranty calculation
    templates.js        every email the platform sends
    models.js           shared queries and the warranty decoration
    uploads.js          multer storage and attachment records
    validate.js         input validation helpers
public/
  index.html            sign-in (customer code + staff password)
  portal.html           customer portal
  admin.html            CHES console
  assets/               app.css, i18n.js (EN/中文), common.js, page scripts
scripts/seed.js         staff account, manufacturer list, optional demo data
tests/flow.test.js      end-to-end test of the whole lifecycle
legacy/                 the retired 2025 claim form — see legacy/README.md
```

---

## Things worth knowing

**Manufacturers.** `npm run seed` adds the brands CHES commonly resells, but
**with no service email addresses** — those change, and sending a warranty job
to a stale address helps nobody. Fill each one in under *Manufacturers* the
first time you forward a job to that brand; after that the address is filled in
automatically. Where a brand uses an online portal instead of email, put the
portal URL on the manufacturer record and the forward screen will link to it.

**No card details.** The platform never asks for a card. When out-of-warranty
work or freight has to be paid for, agree the cost first and take payment
through the normal CHES channel. The retired form in `legacy/` did collect card
numbers; that is exactly why it is retired.

**Customer sign-in is by emailed code**, so a venue that changes managers does
not lose access to a forgotten password. Codes are single use, expire in 15
minutes, and are rate limited. The sign-in endpoint answers identically for
known and unknown addresses so it cannot be used to enumerate CHES customers.

**Email is never silently dropped.** Every message is written to `email_log` and
visible under *Email log* in the console, whether it was sent, failed, or only
logged because SMTP is not configured yet. If a claim's notification failed, it
is recoverable from there.

**Bilingual.** The 中文 / EN toggle in the top bar switches both the portal and
the console, and is remembered per browser. Fault categories and request
statuses are stored in English — so a manufacturer email is always in English —
and translated only for display.
