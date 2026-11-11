# Operations

## Service health

```sh
systemctl status nails-salon nginx --no-pager
journalctl -u nails-salon -f
```

The application currently exposes no unauthenticated health endpoint. A successful HTTPS response from the public app URL confirms that Nginx and the app can serve the UI; check the journal for Telegram polling and database errors.

## Backups

The deployment's `data/` directory contains the booking database, session database, bootstrap salon configuration, and uploaded photos. Back up the complete directory together so appointment records and their photos remain aligned.

For a consistent file-level backup, stop the service briefly:

```sh
systemctl stop nails-salon
tar -czf "/root/nails-data-$(date +%F-%H%M%S).tar.gz" -C /opt/nails data
systemctl start nails-salon
```

Store copies away from the server and restrict access to them. Verify backups by periodically restoring a copy to a separate, non-production directory.

## Restore

1. Stop `nails-salon`.
2. Preserve the current `/opt/nails/data` directory in case the restore needs to be reversed.
3. Restore the selected archive under `/opt/nails` so it recreates `/opt/nails/data`.
4. Restore ownership for the service account: `chown -R nails:nails /opt/nails/data`.
5. Start the service and review `journalctl -u nails-salon`.

## Common issues

| Symptom | First checks |
| --- | --- |
| Mini App does not open | Confirm `PUBLIC_APP_URL` is HTTPS and matches the public Nginx origin; check `systemctl status nginx nails-salon`. |
| Bot polling reports a conflict | Ensure only one server process is polling with this bot token. |
| Bot notifications fail | Ask the recipient to send `/start` to the bot; confirm the bot token and outbound network access. |
| No masters appear | Confirm `data/bookings.sqlite3` exists and the first-time `data/salon.json` contains at least one master with a numeric Telegram ID. |
| Photos fail to load | Check that the booking belongs to the signed-in master and that `data/uploads/` remains readable by the `nails` service user. |
| HTTPS certificate renewal fails | Check Nginx port 80 reachability and `systemctl list-timers snap.certbot.renew.timer`. |

## Data retention

Deactivating a master hides them from new bookings and preserves their history. Canceling an appointment changes its status. Deleting an appointment is permanent and also removes its uploaded photo files.
