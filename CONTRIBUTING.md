# Contributing

Thanks for your interest in the Universal Opt-Out Synchronization Hub. This
document explains how to contribute and how contributions are licensed.

## License of contributions

This project is licensed under the **Apache License, Version 2.0** (see
[`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)). Under Apache 2.0 §5, any
contribution you intentionally submit for inclusion in the work is provided
under the same license, unless you state otherwise in writing.

In addition, this project requires a signed **Contributor License Agreement
(CLA)** before your contributions can be merged. The CLA confirms you have the
right to contribute the code and grants College of Southern Idaho the
copyright and patent licenses it needs to distribute the project. Signing the
CLA does **not** change the license of the project or transfer ownership of
your contribution — you retain the copyright to your work.

- Contributing as yourself → sign the [Individual CLA](CLA-individual.md).
- Contributing on behalf of your employer (or where your employer may claim
  rights in your work) → have an authorized signer complete the
  [Corporate CLA](CLA-corporate.md), and list the covered contributors.

### How to sign (interim process)

Until an automated CLA-signing bot is wired up, we accept the CLA in-repo:

1. Read the applicable CLA file above.
2. In your first pull request, include the following statement in the PR
   description (individual contributors), signed with your legal name and the
   date:

   > I have read and agree to the Contributor License Agreement
   > (CLA-individual.md), and I am legally entitled to grant this license.

3. For a Corporate CLA, an authorized representative should email a completed,
   signed copy to the project maintainers (contact below) and note the
   covering PR.

A maintainer will confirm the CLA is on file before merging. We plan to
replace this manual step with a CLA-assistant bot that records agreement
automatically on each PR.

## Making a change

- Open an issue first for anything non-trivial, so we can agree on the
  approach before you invest time.
- Keep pull requests focused; one concern per PR.
- Follow the existing code style and conventions (TypeScript, the adapter
  contract, the ADR-driven design). See [`DESIGN.md`](DESIGN.md) and the
  ADRs for the architecture, and [`QUICKSTART.md`](QUICKSTART.md) to run it
  locally.
- Add or update tests (`npm test`) and keep the type-check clean
  (`npx tsc --noEmit`).
- Update the docs (README / DESIGN / QUICKSTART / relevant ADR) when behavior
  changes.

## Reporting security issues

Please do not open a public issue for security vulnerabilities. Contact the
maintainers privately so the issue can be addressed before disclosure.

## Contact

Maintainers: College of Southern Idaho IT. (Replace with a monitored contact
address / security alias before the first public release.)
