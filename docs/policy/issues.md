# Issues

Use [GitHub issues](https://github.com/thisisjun786/omo-linear-workflow/issues/new/choose) for bugs, proposals, and questions. A blank issue is fine if the forms don't fit.

Follow the [language policy](../../CONTRIBUTING.md#language) for issue titles and bodies. Titles are [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/) lines, for example `fix: doctor reports a stale Herdr pin` or `feat: pause every binding of a project`.

## Reporting

- **Bug:** describe actual and expected behavior, a minimal reproduction, and the OLW version (`package.json` `version` or the commit SHA). Prefer `--fixture` and the QA scripts so nobody has to touch a real Linear workspace to reproduce. If reproduction is unreliable, say so. Include only sanitized evidence: strip API keys, OAuth tokens and anything from `~/.opencodex/`. See [Security](../../SECURITY.md).
- **Proposal:** describe the problem, who it affects, and the outcome you want. Name the part of OLW it touches (CLI, Herdr runtime, model routing, skills, docs) and check [AGENTS.md](../../AGENTS.md) for contracts it must not break. Constraints and alternatives help; a design is optional.
- **Question:** explain what you're trying to do and where the documentation leaves you stuck.

## Triage and resolution

The owner reviews reports and records whether work is accepted, deferred, declined, or already covered. An open issue isn't a commitment to implement it. There are no promised response times and no automatic stale-issue closures.

Keep the agreed scope and decisions on the issue so a contributor has the context they need. Link related PRs without relying on automatic closing keywords. Close an issue after verifying the result and linking the evidence.

Small fixes and documentation changes may use a PR alone; an issue isn't required.
