# Security

## Report a vulnerability

Don't disclose vulnerabilities or sensitive evidence in a public issue or PR. If private vulnerability reporting is available in this repository's Security tab, use it. Otherwise, open a [private contact request](https://github.com/thisisjun786/omo-linear-workflow/issues/new?title=Private%20contact%20request) asking the owner for a private route. That request is public: include no vulnerability details, credentials, or personal data.

A useful private report includes the affected tag or commit, impact, and a minimal reproduction. Use `--fixture` data where you can, and redact API keys, OAuth tokens, anything from `~/.opencodex/`, proxy access files, Linear workspace content, SQLite registries and `.omo/state/` output.

## Supported versions

Only the latest release on [GitHub Releases](https://github.com/thisisjun786/omo-linear-workflow/releases) receives fixes, published as a new version under the [release policy](docs/policy/releases.md). There's no response-time commitment.

## What OLW touches

OLW runs a local Herdr runtime and OMO sessions on your machine, reads the opencodex model catalog, and talks to Linear through MCP with your credentials. It never issues, copies or stores provider credentials; the installer doesn't edit your shell profile or accounts. A report that shows OLW reading, writing or sending anything outside that description is in scope.

## Public contributions

Review files and evidence before publishing them. Don't commit secrets, personal data, local installation details, or operational state; `.gitignore` isn't a substitute for that review. Changes to credentials handling, proxy access, Linear write paths or what the installer touches outside the checkout need an explicit explanation of their impact in the PR.

CI runs with read-only tokens and no provider credentials; see the [CI policy](docs/policy/ci.md).
