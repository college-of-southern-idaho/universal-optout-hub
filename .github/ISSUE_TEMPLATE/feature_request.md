---
name: Feature request
about: Suggest an idea or a new platform adapter
title: ''
labels: enhancement
assignees: ''
---

### Problem / use case
What are you trying to do, and what's missing today?

### Proposed solution
What you'd like to see.

### Platform adapter? (if applicable)
If you're requesting support for a new SMS/email platform, the most useful detail is how
it handles opt-out:
- How does the platform expose consumer opt-outs — webhook, poll/read, export, or none?
- Is there a caller-writable suppression list (can the hub push an opt-out)?
- Auth model (API key, HMAC, OAuth, SigV4)?

See the new-adapter compatibility checklist in [DESIGN.md § 9.2](../../DESIGN.md).

### Alternatives considered
Anything you've already tried or ruled out.
