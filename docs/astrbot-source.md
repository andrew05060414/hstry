# AstrBot source

AstrBot's `data_v4.db` is an input-only source for Chronicle. The adapter opens
the SQLite file read-only, imports `conversations` as the authoritative LLM
history, falls back to `platform_message_history` for sessions without a
structured conversation, and keeps WebChat side threads searchable.

The exact NAS path is intentionally a deployment value, not a repository value.
Use the path confirmed by the NAS read-only dry-run (for example, the AstrBot
data directory's `data_v4.db`) and do not copy that private path into a public
config or issue.

## NAS configuration (after approval)

Install the adapters that match the Chronicle binary, then add the source to the
NAS HSTRY config. Replace the placeholder with the real AstrBot data directory
(the directory containing `data_v4.db`):

```toml
js_runtime = "node"
adapter_paths = ["/srv/chronicle/adapters"]

[[adapters]]
name = "astrbot"
enabled = true

[[sources]]
id = "astrbot"
adapter = "astrbot"
path = "/path/to/astrbot/data"
auto_sync = true

[service]
enabled = true
poll_interval_secs = 300
search_api = true
```

The source registration and first import write Chronicle's own staging/hub
database, not AstrBot's database. They are still intentionally stopped at this
approval gate:

```bash
hstry adapters update
hstry source add "/path/to/astrbot/data"
hstry source list
hstry sync --parallel 1
hstry stats
```

Before the first import, create the normal NAS hub checkpoint and confirm the
source path and adapter with `hstry source list`. After import, check that the
AstrBot source has the expected conversation/message counts and that the hub
count did not drop. Do not SCP-overwrite the live hub database; use the normal
hub ingest / satellite sync contract in [`remote-sync.md`](./remote-sync.md).

## Sync and incrementality

The adapter advertises incremental support. Chronicle passes the source's
`last_sync_at` watermark in milliseconds; the adapter compares it against
AstrBot `created_at` / `updated_at` values and exposes a cursor-based
`parseStream` fallback for large databases. The service's regular poll loop is
the preferred unattended sync mechanism after the source is approved.

AstrBot's `conversations.content` JSON does not currently carry a timestamp for
every message. The adapter preserves the conversation's created/updated bounds,
keeps any explicit per-message timestamp, preserves array order, and records
unknown source roles in message metadata instead of inventing a timestamp.

## AgentsView evaluation

Conclusion: yes, AstrBot records can enter AgentsView after normalization. They
already become ordinary Chronicle conversations with integer-millisecond
timestamps, roles, platform/session metadata, and searchable message text. This
PR does not add a direct AgentsView connector; the safer boundary is to let
AgentsView consume the approved Chronicle/HSTRY archive or an explicitly
reviewed export. Direct live reads from AstrBot would duplicate sync logic and
would need a separate access/retention decision.

## Safety boundary

- The adapter never opens `data_v4.db` for writes.
- NAS config registration, service enablement, and the first import require
  Andrew's explicit approval.
- Do not print raw message bodies in dry-run reports; report schema and aggregate
  counts only.
