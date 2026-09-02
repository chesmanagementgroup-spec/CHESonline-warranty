# CHES Online — Equipment & Warranty Platform

设备登记与保修平台 · Device registration, warranty tracking and manufacturer
service requests for CHES Management Group.

Two front doors onto one database:

| | Who | What they do |
|---|---|---|
| `/` → `/portal` | The customer | See their equipment grouped by venue with its warranty status, add equipment by uploading their own invoice, keep each venue's address and on-site after-sales contact current, and report a fault by picking the machine off their own list |
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
        │            (serials and warranty months come off the invoice too;
        │             quantity 3 becomes 3 machines, each at a chosen SITE)
        │
        │  warranty starts at the DELIVERY DATE stated on the invoice
        ▼
  customer gets a handover email with a one-click link — nothing to fill in
        │
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

**Warranty is counted from the delivery date**, which CHES states on the
invoice — the parser reads it, and the invoice date is only the fallback. There
is no customer registration step: equipment is live and under warranty from the
moment its invoice is imported.

**A customer can run several venues.** Equipment belongs to a *site*, and the
site carries the address and the person a technician asks for on arrival, so a
request lodged against any machine already knows where to go and who to call.

**Every email to a customer carries a one-click sign-in link** (`/go/<token>`),
so reaching their equipment never requires remembering anything. The link is a
bearer credential: scoped to one customer, stored hashed, and expired after 45
days.

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
    suppliers.js        the supplier service desks, brands and warranty terms
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

**Supplier service desks.** `npm run seed` loads the CHES supplier list from
`server/lib/suppliers.js` — service address, spares CC, booking portal, phone,
the brands each desk covers, and the conditions that decide a claim. Editing a
desk in the console is safe: the seed only fills blank fields, it never
overwrites a correction.

Two things follow from that list:

* **The brand on the machine is routed to the desk that services it.** A
  Waldorf oven reaches Moffat, an Apuro fryer reaches Uropa, a Hallde reaches
  Roband. Add brands to a desk's *aliases* field as new ones come in.
* **A supplier's standard warranty is applied on import** — but only for the
  desks that state one unambiguously (Moffat 24, Roband 12, Unox 12, Stoddart
  12, Scots Ice 12, Williams 24, SIMCO 24). Where cover varies by model the
  field is deliberately blank, because a wrong default silently puts a wrong
  expiry on real equipment. Precedence is always: **the warranty written on
  the invoice → the supplier's standard term → 12 months**.

Before a job is sent, the forward screen shows that desk's own conditions —
SIMCO's picking slip, Stoddart's prior authorisation, Meiko's 90-day
registration, Williams' remote units being 12 months parts-only.

**Equipment a customer adds themselves.** A customer can upload their own
invoice and put the machines on their account. What they add is usable
immediately — it appears in their list and they can report a fault against it —
but every machine is marked `source = customer` and flagged **awaiting check**
until someone at CHES confirms it (*Equipment → open the machine → confirm*).

That flag is the point. Warranty on a customer-supplied invoice is a claim made
by a document CHES did not issue, so it is never allowed to become an authority
on what CHES covers: the customer does not choose the warranty term (it comes
from the supplier's standard cover), CHES is emailed the moment equipment is
added, and the system email for any fault on unchecked equipment says so in
capitals, above the fold, before anyone forwards it to a manufacturer.

**Out of warranty.** When a customer picks a machine whose cover has ended, the
form says so before they write anything: they may arrange their own repairer,
or email `CHES_AFTERSALES_EMAIL` and CHES will introduce a technician and help
coordinate the repair, chargeable and quoted first. The request is still
recorded, so nothing is lost, and the receipt repeats the position in writing.

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
