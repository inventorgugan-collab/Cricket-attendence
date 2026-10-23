# Cricket Performance Lab

Cricket academy management app, for any number of academies: players and guardians,
coaches, sessions (group, one-on-one, one-on-two), bookings, attendance, training
packages, journals and coach notes, with offline use at the nets. The admin also gets
fees, payments, coach pay, expenses and a month-end report, plus WhatsApp messages.
Video analysis and skeleton detection come in later phases.

```
backend/   TypeScript API (Fastify) on PostgreSQL
mobile/    Flutter app for Android and iOS
```

## Phase 1 status

| Area | State |
| --- | --- |
| Accounts, roles, server-side permissions | Done. Admin, coach, player, guardian; field-level rules for who sees and edits what. |
| Players, guardians, consent, injuries | Done. Consent is an append-only log; minors' consent must come from a guardian. Coaches see safety information only. |
| Sessions | Done. Group, 1:1 and 1:2, weekly series, reschedule, coach reassignment, cancellation, interrupted sessions. |
| Scheduling rules | Done, enforced by the database: no double-booked coach, net or player; capacity checked under a lock. |
| Bookings | Done. Auto-confirm rules, staff and parent approvals, waitlist with promotion, idempotent retries. |
| Attendance | Done. Per-player records, correction history, admin override that locks the record, walk-ins, coach attendance. |
| Packages and credits | Done. Ledger-based; credits move only when attendance says so, under the configured policy. |
| Journals and coach notes | Done. Separate records on the same session; previous versions kept. |
| Offline sync | Done. Outbox of idempotent changes, change feed, conflicts held for admin review. |
| Notifications | In-app notifications done. Push delivery (FCM/APNs) still to wire up. |
| Reports and dashboards | Done for daily, monthly, coach completion, missing attendance, inactive players, package usage. |
| Coach leave and cover | Done. Planned and same-day emergency leave, kept on record when cancelled. Sessions left without a coach are flagged for the admin, who reassigns from a priority-ordered list; everyone affected is told. A coach on leave can't be assigned. |
| Kinds of session and coach priority | Done. Admin-defined categories (one-on-one, S&C, ...) with an ordered coach list each. |
| Requested sessions | Done. Players and parents pick a free time; the request goes to the first free coach in line, who (or an admin) confirms, passes it to the next coach, or declines. |
| Packages in parts | Done. Package designs such as 9 one-on-one + 3 S&C; each part tracks attended, left and booked ahead; alerts after each session and when a part runs low. |
| Many academies | Done. One database schema per academy, chosen by the academy code at sign-in and carried in every token. Nothing crosses between academies. |
| Money (admin only) | Done. Package prices raise fees; payments (cash, UPI, bank, card, cheque); coach pay rates per session and per kind; coach payouts; expenses. Entries are voided with a reason, never deleted. Month report: sessions overall, by kind and per coach, money in, coach pay, expenses, profit, fees outstanding. Every route refuses non-admins. |
| WhatsApp | Done, in preview until connected. Official WhatsApp Business Platform (Cloud API) template messages to people who agreed; coaches' evening summary (leave, cover, sessions still needing a coach, tomorrow's count) to a group if the account may post to groups, otherwise to each coach. |
| Mobile app | New design throughout. Academy code at sign-in; Money tab and fees on each player; WhatsApp setup, consent and message log. Coach register and notes (offline), leave and requests; player and parent home, booking a time, journal, packages; admin cover, approvals, setup (categories, coach order, package designs, leave), conflicts, registration. |

## Trial on your own computer

For a trial without a hosted server, run the server on a Windows computer and
point the phones at it over the same Wi-Fi.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and start it.
2. Download this repository (Code → Download ZIP) and extract it.
3. Double-click `start-server.bat`. The first run takes a few minutes, then asks
   for the academy code, name, admin login and password, and prints this
   computer's address. Allow it through Windows Firewall if asked.
4. In the app, tap **Server** on the sign-in screen and enter that address.

`add-demo-academy.bat` adds a test academy (code `test`, password `demo1234` for
the logins admin, arun, bala, ravi, karthik and lakshmi) with sample data.
If the phone can't connect, run `allow-phone-access.bat` to open port 3000 in Windows Firewall.
`stop-server.bat` stops it; the data is kept for next time.

## Running the backend

Needs Node 22+ and PostgreSQL 14+ (with the `btree_gist` and `pgcrypto` extensions).

```bash
cd backend
npm install
export DATABASE_URL=postgres://user:pass@localhost/cpl_dev
export JWT_SECRET=$(openssl rand -base64 48)    # required in production
npm run migrate
SEED_PASSWORD=devpass123 npm run seed          # demo academy "cpl", development only
npm run dev                                    # http://localhost:3000
```

### Academies

Each academy has a short code (letters and digits) that people type when they sign in.
Create one from the command line:

```bash
npm run academy:create -- chennaicc "Chennai Cricket Club" admin 'a-strong-password'
```

or over the API with the platform key (`PLATFORM_KEY` environment variable), sent as
the `x-platform-key` header: `POST /v1/platform/academies` with
`{code, name, adminLogin, adminName, adminPassword}`. `GET /v1/platform/academies`
lists them and `POST /v1/platform/academies/:code/status` suspends or reactivates one.
The first admin must change their password on first sign-in.

### WhatsApp

Messages go through Meta's official WhatsApp Business Platform. Until an academy saves
its phone number ID and access token (Academy setup → WhatsApp), every message is kept
as a preview in the message log and nothing is sent.

1. In Meta Business Manager, add a WhatsApp Business account and phone number, and
   create a permanent system-user access token with `whatsapp_business_messaging`.
2. Get a **utility** template approved, named `academy_update` (or change the name in
   setup), with two body variables: `{{1}}` the academy name and `{{2}}` the message.
3. Set `MESSAGING_KEY` on the server (a long random string). Access tokens are stored
   encrypted with it.
4. Turn on WhatsApp per person in the app, only after they agree. Posting to a WhatsApp
   group needs an Official Business Account; without one, the evening summary goes to
   each coach.

Tests run against a real database (`TEST_DATABASE_URL`, default `postgres://cpl:cpl@localhost/cpl_test`; it is wiped):

```bash
npm test
```

## Running the app

```bash
cd mobile
flutter pub get
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator to local API
```

The end-to-end offline test needs a seeded server:

```bash
flutter test test/offline_sync_test.dart --dart-define=E2E_API=http://localhost:3000 --dart-define=E2E_ACADEMY=cpl
```

## Academy policy (needs confirming)

Every "configurable" rule in the brief lives in one policy document, editable by an
admin through `PATCH /v1/settings/policy`. These defaults are placeholders until the
academy decides:

| Rule | Default |
| --- | --- |
| Credit used for present / late / no-show / excused | yes / yes / no / no |
| Make-up sessions use a credit | no |
| Interrupted sessions use a credit | no |
| Cancelled sessions | never an absence, never use a credit |
| Approval needed for group / 1:1 / 1:2 requests | no / yes / yes |
| Auto-confirm requires unreserved package credit | yes |
| Minor's own request needs a parent's approval | yes |
| Request notice / how far ahead | 2 hours / 30 days |
| Self-cancel cutoff for confirmed bookings | 6 hours before |
| Coach can correct own attendance for | 48 hours after the session |
| Coaches may create sessions (for themselves only) | yes |
| Waitlist | on |
| Coach and admin alert when a package part is down to | 2 sessions (and again at 0) |
| Bookable hours for coaches with no weekly hours set | 06:00 to 20:00, in 30-minute steps |

See `docs/architecture.md` for how the pieces fit and why.
