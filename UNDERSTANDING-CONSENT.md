# Opt-Out & Opt-In, Made Simple: Channel × Category

*A plain-language primer on how consent works in the Consent Hub — for anyone who
doesn't need the engineering detail.*

## The one idea to hold onto

Consent is **not a single on/off switch.** It's a grid with two questions:

1. **Channel — *how* do we reach them?** Their **phone** (text) or their **email**.
   These are different addresses and *different, separate consents.*
2. **Category — *what kind* of message is it?** **Emergency/safety**,
   **transactional** (account/service), or **marketing** (promotional).

Someone can say *"stop the marketing texts"* and still get safety alerts, tuition
reminders, and every email. That's the whole point.

## Dimension 1 — Channel (phone vs. email are separate)

- Opting out of **texts** does **not** opt them out of **email** — and vice versa.
- They're separate identifiers, so each is its own decision. *(A service that
  emails-to-text counts as texting.)*

## Dimension 2 — Category (purpose of the message)

- **Emergency/safety** — **protected. Never turned off**, no matter what.
- **Transactional** — bills due, class canceled, account notices.
- **Marketing** — promotions, newsletters, events.
- An opt-out can spread to *related* categories, but **a marketing opt-out never
  silences transactional or emergency messages.**

## Opt-out and opt-in work *differently* — on purpose

| | **Opt-out** ("stop") | **Opt-in** ("yes, contact me") |
|---|---|---|
| How fast | Immediate & automatic | Honored immediately **where it happened** |
| How far it spreads | Spreads across **all systems** on that channel, by category, automatically | **Stays narrow** unless a person reviews the evidence and extends it |
| Why | Texting someone who opted out is the costly legal violation | Pretending a narrow "yes" was a blanket "yes" is *also* a legal violation |

**Plain version: "Stop" is fast and wide. "Yes" is careful and narrow.**

## A real example

**Maria replies STOP to a marketing text from Admissions:**

- ✅ She stops getting **marketing texts** — from Admissions **and every other
  texting system**.
- ✅ She still gets **emergency alerts** and **transactional texts** (tuition due,
  class canceled).
- ✅ Her **email is untouched** — she keeps getting email until she opts out there too.
- ↩️ If Maria later texts **START**, her **texts** turn back on — but we do **not**
  automatically switch her email marketing back on or assume her "yes" covers
  everything. A person confirms what the consent actually covers first.

## The two mistakes this design prevents

- **Under-suppression** — still messaging someone who opted out → the expensive one
  → so opt-outs spread fast and automatically.
- **Over-broad opt-in** — treating a small "yes" as permission for everything → also
  a violation → so opt-ins stay put until a human extends them with evidence.

## If you remember only three things

1. **Phone and email are separate** — one doesn't affect the other.
2. **Emergency always gets through.**
3. **"Stop" spreads automatically; "Yes" does not.**

---

*Not legal advice. For the engineering detail behind these rules, see
[DESIGN.md](DESIGN.md) (§7 precedence, §10 propagation, §11 opt-in gate) and
[ADR 0005](ADR-0005-message-category-cascade.md).*
