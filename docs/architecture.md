# Architecture notes (Phase 1)

## Shape

One API service (modular monolith) on PostgreSQL, and one Flutter app. No
microservices. Modules: auth, people, sessions, bookings, attendance, credits,
journals, admin/reports, sync.

## Where the rules live

* **Database constraints** for anything that must hold even under concurrent or
  replayed offline writes: exclusion constraints stop a coach, a training area or a
  player being double-booked; a unique key stops duplicate attendance; a trigger
  checks capacity while holding a lock on the session, so two people can't both get
  the last place.
* **Server code** for policy: who may do what, auto-confirm rules, correction
  windows, credit deduction. The app hides controls a user can't use, but every
  check is repeated on the server.

## History instead of overwrites

* Attendance keeps its original status plus an append-only event list
  (initial, correction, override, session cancelled). An admin override locks the
  record against later coach edits until the admin unlocks it.
* Credits are a ledger. The balance is always a sum; reconciling an attendance
  record only writes the difference, so re-syncs can't double-deduct.
* Journals and coach notes keep every previous version in `record_revisions`.
* Consent is a log; the latest row per type is current.
* `audit_log` records who changed what.

## Offline sync

The device keeps an encrypted SQLite copy (SQLCipher, key in Keychain/Keystore) of
the user's scope: for a coach, their sessions from 14 days back to 30 ahead, the
players on those registers (no home addresses) and their current safety notes.

Every change is saved locally together with an outbox entry. Sync sends the outbox
in order; each entry has an id the device generated, so the server applies it at
most once and answers retries with the stored result. Updates carry the version
they were based on. If the server moved on because someone else changed the record,
the change is **held as a conflict**, not applied: the device shows the server's
version, the user sees the problem, and an admin chooses which version to keep.

Pulls use a cursor (change number plus time). Rows touched within five minutes of
the previous cursor are re-sent to cover transactions that committed late; the
device upserts by id, so repeats are harmless.

Bookings made offline are only requests. The device never claims a place is free;
the server decides when the request arrives.

## Not done yet

* Push delivery through FCM/APNs (notifications are stored and shown in-app now).
* An admin web console for heavy data entry (the phone has the essentials).
* Android and iOS release builds, signing, store setup.
* Legal review of consent and retention against the DPDP Act and Rules (duties for
  children's data apply from 14 May 2027).
