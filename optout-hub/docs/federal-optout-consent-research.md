# Federal Opt-Out / Consent Regulations — Research Briefing

Prepared for: College of Southern Idaho — Universal Opt-Out / Consent Hub
Date: September 8, 2026
Purpose: Research to inform legal review. This is NOT legal advice.
Method: Multi-source search of authoritative .gov sources (eCFR, govinfo, docs.fcc.gov, Federal Register, FTC, Congress/CRS), with each claim adversarially fact-checked (2-of-3 verifier vote required). 21 sources fetched, 96 candidate claims extracted, 25 verified, 24 confirmed, 1 rejected.

---

## Executive summary

Two separate federal regimes govern what CSI must synchronize: the TCPA (for SMS / robotexts) and CAN-SPAM (for email). The single most important finding for your over-suppression concern is this:

The "revoke-all" rule — the one that would force an opt-out from ONE kind of message to cascade to ALL unrelated messages from CSI — is NOT currently in force. Its effective date has been pushed to January 31, 2027, and the FCC has an open proceeding that may narrow or eliminate it before it ever takes effect. As of today, broad cross-subject cascade suppression is NOT legally required.

Meanwhile, the parts that ARE in force are the ordinary ones: a student can opt out by any reasonable method (STOP, cancel, unsubscribe, etc.), CSI may not force an exclusive opt-out method, and CSI must honor the request within a reasonable time not to exceed 10 business days.

Critically, several categories of message remain sendable after a marketing opt-out — most importantly emergency/safety alerts (which never depend on consent) and exempted informational messages (unless the student separately opts out of those). This is the legal basis for not over-suppressing students from essential college communications.

---

## 1. TCPA core prohibition and revocation (IN FORCE)

The TCPA (47 U.S.C. § 227(b)(1)(A)-(B)) bars autodialed/robotext SMS and prerecorded/artificial-voice calls unless made for emergency purposes OR with the prior express consent of the called party. Text messages are treated as "calls" under this provision (settled FCC/judicial interpretation). Confidence: high.

Currently in force (effective April 11, 2025, per FCC 24-24 and 47 C.F.R. § 64.1200(a)(10)):

- A consumer may revoke consent by ANY reasonable method. Replying stop, quit, end, revoke, opt out, cancel, or unsubscribe to a text is a "reasonable means per se." The list is illustrative, not exhaustive. Confidence: high.
- The sender may NOT designate an exclusive means to request revocation. Confidence: high.
- All revocation requests made in any reasonable manner must be honored within a reasonable time not to exceed ten business days from receipt. The "reasonable time" standard means a sender cannot default to the full 10 days if faster honoring is feasible. Confidence: high.

Design implication: the hub's near-real-time propagation is well inside the 10-business-day ceiling, and the STOP-keyword handling matches the FCC's per-se list. The 10 business days is a legal maximum, not a target.

---

## 2. The "revoke-all" rule — status (THE KEY ITEM)

47 C.F.R. § 64.1200(a)(10) contains a "revoke-all" scope: it would treat a revocation made in response to ONE type of message as applying to ALL future robocalls/robotexts from that sender, including on UNRELATED subjects. This is the provision that most directly threatens over-suppression of students.

This cross-subject scope is NOT yet in force. Its effective date has been delayed twice and is now January 31, 2027. Confidence: high.

Delay chain (primary sources):
- Original effective date: April 11, 2025 (89 Fed. Reg. 82518, Oct. 11, 2024).
- Delayed by FCC order DA 25-312 (released April 7, 2025) to April 11, 2026.
- Extended again by FCC order DA 26-12 (adopted/released January 6, 2026) to January 31, 2027. Operative text: "the effective date of section 64.1200(a)(10) is extended to January 31, 2027 to the extent discussed herein."

The delay is narrowly scoped. It reaches ONLY the requirement to treat a revocation to one message type as applying to unrelated matters, and "does not alter the status quo relating to any other prior Commission rules or rulings addressing revocation of consent." In other words, ordinary revocation (stop marketing messages you asked to stop) is already in force; only the cross-subject cascade is paused.

The FCC may modify or eliminate the rule before it ever takes effect. An open rulemaking (2025 TCPA FNPRM, FCC 25-76; comment sought October 29, 2025) asks "ways we can modify the requirement that a caller must treat an opt-out request made in response to one type of call to be an opt-out request for all types of calls." The FCC's stated reason for the extension: "A further extension of the rule's effective date until the Commission decides whether to change the rule will avoid premature and potentially unnecessary compliance efforts and costs." Confidence: high.

Design implication: do NOT hardcode cross-subject cascade suppression as a legal requirement today. Gate it behind configuration (the hub already makes propagation scope a configurable policy) so CSI can turn it on if/when the FCC finalizes it — and re-verify the effective date and FNPRM outcome with counsel before go-live, since it could move again.

---

## 3. What CSI can still send after an opt-out (the practical part)

This is the core of the over-suppression concern. Federal law leaves clear room for essential college messaging.

### 3a. Emergency / safety alerts — always sendable

The "emergency purposes" exception (47 C.F.R. § 64.1200(f)(4)) covers "calls made necessary in any situation affecting the health and safety of consumers." Because emergency messages do not rely on consent at all (§ 227(b)(1)(A) chapeau), a revocation of consent does NOT bar them, and FCC 24-24 repeatedly limits the effect of revocation to "non-emergency robocalls and robotexts." Confidence: high.

For a university, emergency/safety alerts (closures, active-threat, health-and-safety) are the strongest-footed category to keep sending after ANY opt-out.

### 3b. Exempted informational messages — sendable after a marketing opt-out, with an important caveat

FCC 24-24 (para. 30): "when a consumer revokes consent with regard to telemarketing robocalls or robotexts, the caller can continue to reach the consumer pursuant to an exempted informational call, which does not require consent, unless and until the consumer separately expresses an intent to opt out." Confidence: high.

IMPORTANT CAVEAT (context matters): "If the revocation request is made directly in response to an exempted informational call or text... this constitutes an opt-out request... and all further non-emergency robocalls and robotexts must stop... acts as a revocation of consent for all calls from the caller." Confidence: high.

Design implication: the CONTEXT in which a STOP arrives matters legally. A STOP replied to a marketing text suppresses marketing; a STOP replied to an informational/transactional text can sweep more broadly (all non-emergency messaging). If the hub can capture WHICH message/category a STOP was a reply to, that context should inform how broadly the opt-out propagates. This is the single most useful data point to capture for avoiding both over- AND under-suppression.

---

## 4. Consent tiers (telemarketing vs. informational) (IN FORCE)

Revocation reaches messages sent under 47 C.F.R. § 64.1200(a)(1)-(3) and (c)(2). The consent required differs by message type:

- Telemarketing / advertising messages require prior express WRITTEN consent.
- Non-telemarketing informational messages require prior express consent (not necessarily written).

Crucially, "any revocation of consent request applies only to those robocalls and robotexts for which consent is required under the TCPA" (FCC 24-24, para. 29). Messages that do not require consent in the first place (e.g., emergency) are not blocked by a revocation. Confidence: high.

Design implication: this is the legal foundation for a category dimension in the consent model — modeling marketing vs. transactional/informational vs. emergency so an opt-out is honored within the scope the law actually attaches to it.

---

## 5. One-time opt-out confirmation text (PERMITTED)

A single text confirming a consumer's opt-out does NOT violate the TCPA, provided (FCC 12-143, the SoundBite Declaratory Ruling): only one confirmation message; no marketing/promotional content; no attempt to persuade the consumer to reconsider. It is presumptively compliant if sent within five minutes of the opt-out. This remains good law and is cited alongside FCC 24-24. Confidence: high.

Design implication: CSI may send a confirmation such as "You've been unsubscribed from X. Reply START to resume." — useful for a student who only meant to stop marketing.

---

## 6. Email / CAN-SPAM — REQUESTED BUT NOT INDEPENDENTLY VERIFIED HERE

This briefing concentrated on SMS/TCPA, where the verified claim set landed. The CAN-SPAM email questions (Question 6) are a KNOWN GAP: no claim about the email regime was independently verified in this run. Treat the following as the well-established framework to CONFIRM with counsel against the FTC guidance and the CFR — not as a verified finding:

- CAN-SPAM (15 U.S.C. § 7701 et seq.; FTC Rule at 16 C.F.R. Part 316) requires a working unsubscribe mechanism for commercial email and honoring an opt-out within 10 business days.
- 15 U.S.C. § 7702 distinguishes a "commercial" message from a "transactional or relationship" message. The commonly-applied reading is that the unsubscribe mandate attaches to COMMERCIAL email, and that transactional/relationship email (e.g., information about a transaction the recipient has entered into) may still be sent after the recipient unsubscribes from commercial email.

If that reading holds, unsubscribing from CSI marketing email would NOT legally block financial-aid, registration, or enrollment email — a strong lever against over-suppression on the email channel. Relevant sources to confirm are listed below (FTC CAN-SPAM compliance guide; 15 U.S.C. §§ 7702, 7704; 16 C.F.R. Part 316).

---

## 7. Higher education and Idaho state law

Higher-ed-specific carve-out: no higher-education-specific TCPA exemption surfaced in the VERIFIED claim set. Note, however, that the FCC has addressed school messaging in other rulings that were located as sources but not independently verified here — notably the Blackboard/Edison TCPA Declaratory Ruling and the FCC's "robocalls to schools and school systems" guidance, which address school notifications and the emergency-purposes exception. Counsel should review these directly; absence of a verified finding is not proof that no relevant guidance exists.

State law (Idaho): the TCPA does NOT preempt more-restrictive state law (47 U.S.C. § 227(e) savings clause). This point was requested but not independently verified in this run. Counsel should confirm the savings-clause text and check for any Idaho telemarketing or consumer-protection statute that imposes stricter opt-out or honoring requirements — if so, CSI must comply with the more stringent standard.

---

## 8. Caveats and limits of this research

- TIME-SENSITIVITY IS THE DOMINANT CAVEAT. The "revoke-all" scope has been delayed repeatedly (April 2025 -> April 2026 -> January 31, 2027) and may be modified or eliminated by the pending 2025 FNPRM (FCC 25-76). Any design decision that assumes cross-subject cascade suppression is legally required WOULD BE PREMATURE — as of September 8, 2026 it is NOT required. Re-verify before go-live; it could move again.
- CAN-SPAM email coverage is UNVERIFIED here (Section 6). Confirm directly against FTC guidance and the CFR.
- Higher-ed-specific and Idaho state-law items (Section 7) were not independently verified. Confirm separately.
- Minor source-label imprecision was noted in a couple of statutory quotes during verification, but the substantive holdings above are accurate and primary-sourced.
- One candidate claim was REJECTED by the verifiers (0-3): a mischaracterization of the DA 25-312 delay rationale. The corrected delay chain is in Section 2.
- This is research to inform counsel. It is not legal advice.

---

## 9. Open questions for counsel

- CAN-SPAM: Do 15 U.S.C. § 7702 and the FTC Rule clearly permit CSI to keep sending registration, financial-aid, and enrollment email after a recipient unsubscribes from commercial email?
- Is there any FCC declaratory ruling or petition specific to colleges/universities that treats student notifications as informational/exempt (e.g., Blackboard/Edison)?
- Does Idaho have a telemarketing/consumer-protection statute (preserved by § 227(e)) stricter than the TCPA?
- If the 2025 FNPRM modifies or repeals the revoke-all rule before Jan 31, 2027, should CSI build the cross-subject cascade now (behind a config flag) or defer it until the FCC's final action is known?

---

## 10. Design implications for the Consent Hub

- Keep propagation scope CONFIGURABLE (already the design): do not treat cross-subject cascade suppression as mandatory today.
- Add a message-CATEGORY dimension (marketing vs. transactional/informational vs. emergency) so an opt-out is honored within the scope the law attaches to it.
- Exempt emergency/safety systems from suppression entirely.
- Capture the CONTEXT of an opt-out (which message/category a STOP replied to) — legally decisive per Section 3b.
- On email, classify commercial vs. transactional/relationship so a marketing unsubscribe does not block transactional mail (pending CAN-SPAM confirmation, Section 6).
- Preserve the audit trail (supports the TCPA § 227(c)(5) affirmative-defense posture) and the one-time confirmation-text capability (Section 5).

---

## Sources (authoritative .gov, primary unless noted)

- 47 U.S.C. § 227 (TCPA): https://www.law.cornell.edu/uscode/text/47/227
- 47 C.F.R. § 64.1200 (eCFR, current): https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200
- 47 C.F.R. § 64.1200 (govinfo 2024 PDF): https://www.govinfo.gov/content/pkg/CFR-2024-title47-vol3/pdf/CFR-2024-title47-vol3-sec64-1200.pdf
- FCC 24-24 (2024 TCPA Consent Order, PDF): https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf
- Federal Register — Strengthening the Ability of Consumers to Stop Robocalls: https://www.federalregister.gov/documents/2024/03/05/2024-04587/strengthening-the-ability-of-consumers-to-stop-robocalls
- FCC DA 25-312 (first delay of 64.1200(a)(10), PDF): https://docs.fcc.gov/public/attachments/DA-25-312A1.pdf
- FCC DA 26-12 (extension to Jan 31, 2027, PDF): https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf
- FCC CGB news release (consent-revocation effective date): https://www.fcc.gov/document/cgb-extends-effective-date-tcpas-consent-revocation-rule
- FCC 12-143 (SoundBite one-time confirmation ruling, PDF): https://docs.fcc.gov/public/attachments/FCC-12-143A1.pdf
- FTC CAN-SPAM Compliance Guide for Business: https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- 15 U.S.C. § 7702 (CAN-SPAM definitions): https://www.law.cornell.edu/uscode/text/15/7702
- 15 U.S.C. § 7704 (CAN-SPAM requirements): https://www.law.cornell.edu/uscode/text/15/7704
- 16 C.F.R. Part 316 (FTC CAN-SPAM Rule): https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-316
- FCC — Robocalls to Schools and School Systems (update): https://www.fcc.gov/robocalls-schools-and-school-systems-update
- FCC — Blackboard/Edison TCPA Declaratory Ruling: https://www.fcc.gov/document/blackboardedison-tcpa-declaratory-ruling
- FCC 20-186 (TCPA exemptions order, PDF): https://docs.fcc.gov/public/attachments/FCC-20-186A1.pdf
- Congressional Research Service — TCPA overview (R46736): https://www.congress.gov/crs-product/R46736

End of briefing. Research to inform counsel — not legal advice.
