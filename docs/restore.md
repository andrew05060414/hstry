# Restore the archive on this computer

Backup is a dated copy of the NAS hub SQLite file. Restore means: on **this** computer, put that file where hstry can search it. Do not copy another machine's Cursor/Codex/agy directories here.

## What to restore

| File | Role |
|------|------|
| NAS hub `hstry.db` | Live merged archive (`arknights:*` + `macbook:*` sources) |
| Cloud Drive snapshot | Dated copy of that hub file (rclone / NAS Cloud Sync) |
| This PC `staging.db` | Only this machine's latest ingest. Recreate by `hstry sync` after restore. |

Hard rule: **never overwrite `D:/Data/hstry/staging.db` (or Mac staging) with the hub snapshot and then `remote sync --direction push`.** The hub file already has `{device_id}:` prefixes. Pushing it again double-namespaces or clobbers other devices.

## Windows reinstall or a new Windows PC (10 minutes to search)

1. Install hstry 1.0+ from this fork (`cargo install --path crates/hstry-cli`) and copy adapters (`just update-adapters-windows`).
2. Copy the **latest hub snapshot** to a search-only path, for example `D:/Data/hstry/archive-restore.db`.
   - Prefer NAS: `/vol1/1000/Code/hstry backup/hstry.db`
   - If NAS is down: the Google Drive copy of that file
3. Point this machine at the restore file **without** replacing staging:

```powershell
# Temporary search against the restored hub copy
$env:HSTRY_NO_SERVICE = "1"
hstry --database "D:/Data/hstry/archive-restore.db" search "a phrase you remember" --limit 5
```

Or set `database = "D:/Data/hstry/archive-restore.db"` in a throwaway config. Keep the daily satellite `database = "D:/Data/hstry/staging.db"`.

4. Recreate local collection: `hstry source add` the tools on this PC, `hstry sync`, then `hstry remote sync --direction push` **only staging**.

If NAS itself was lost: copy the Drive snapshot back to `/vol1/1000/Code/hstry backup/hstry.db` on the NAS first, then satellites search/push as usual.

## Hub checkpoints (local rollback)

On the hub (NAS):

```bash
hstry checkpoint create
hstry checkpoint list
hstry checkpoint restore hstry-YYYYMMDD-HHMMSS
# writes a search-only copy next to the live db (`hstry-win.restore.db` by default)
```

The hub service creates a daily checkpoint when `[checkpoint] enabled = true`, tags Sunday copies as weekly, and prunes compressed archives to `max_total_bytes` (default 10 GiB). Failed `integrity_check` copies are discarded.

Restore never writes `staging.db`. `--live` replaces the hub file — stop `hstry service` first.

Off-site Drive copies remain optional and out of band (rclone / Feiniu Cloud Sync). hstry does not speak Drive.

## Session resume (priority B)

After the archive is searchable on this PC, `hstry resume` / export can feed a conversation back into a **local** agent on this same OS. That is optional and not the restore acceptance test. Acceptance is: `hstry search` hits the restored conversations.
