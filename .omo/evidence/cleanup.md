# QA resource disposition

After the final role/event/Linear run, an independent process and filesystem
inspection found:

- No `qa-world-*` directories or sockets under this repository's `.omo`.
- No QA OMO host, QA Herdr server, or QA RPC process in the process table.
- `herdr session list` returned only the existing running `default` server.
- `/home/jun/.omo-initiative-qa-launch.json` was absent.
- The main control registry is empty (`bun run cli status --json` returned
  `{"ok":true,"value":[]}`).

The only repository-associated processes were TypeScript language servers.
They are editor tooling, not QA sessions, and were left running.
The user's default Herdr server and its workspaces were not stopped.

Historical model/native probe transcripts were removed in their owning QA
steps, as recorded in the work journal. Source probes and Markdown evidence
are reproducibility artifacts, not running resources.

The final verification and provider-migration runs also removed their worlds,
including `qa-world-XfU82Z` and `qa-world-D9Ch39`. The final MCP run removed
its server, agent directory and RPC process 996125. The exact passing receipts
are recorded in [final-runtime.md](final-runtime.md).
