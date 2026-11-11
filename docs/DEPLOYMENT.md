# Deployment guide

This guide covers a single Ubuntu 24.04 server deployment using Nginx, systemd, SQLite, and HTTPS. The application process listens on localhost; Nginx is the public entry point.

## Prerequisites

- A public server with inbound TCP ports 80 and 443 available.
- Node.js 20 or newer and npm (the install script configures Node.js 22).
- A Telegram bot created with [@BotFather](https://t.me/BotFather).
- The public HTTPS URL for the Mini App.

## Configure the first deployment

1. Put the project files in `/opt/nails`.
2. Create `/opt/nails/.env` from `.env.example` and set a unique session secret, bot token, bot username, HTTPS app URL, and any non-default settings.
3. Create `/opt/nails/data/salon.json` from `data/salon.example.json`; set the real salon name and main master's Telegram ID. The first master is the main master only when the database is first created.
4. Run the provisioning script as root with the server's public IP:

   ```sh
   bash /opt/nails/deploy/install-ubuntu.sh YOUR_PUBLIC_IP
   ```

The script installs Node.js, Nginx, and Certbot; installs production dependencies; configures the `nails-salon` systemd service; and requests a short-lived IP certificate. Review the script before running it on a server with existing services. It refuses to proceed if ports 80, 443, or 3000 are already occupied.

## Configure the Telegram Mini App

Set `PUBLIC_APP_URL` to the exact HTTPS origin used by Nginx and `TELEGRAM_BOT_USERNAME` to the matching bot username. Restart the service after editing `.env`:

```sh
systemctl restart nails-salon
systemctl status nails-salon nginx --no-pager
journalctl -u nails-salon -n 50 --no-pager
```

Open the bot and send `/start` from the main master account and each master's account. Telegram only allows the bot to send personal notifications after the recipient has started the bot.

## Updating an existing installation

An update must preserve the server's `.env` and entire `data/` directory. Never replace these with development copies. Stop the service, back up state, unpack only the release files into `/opt/nails`, then start the service:

```sh
systemctl stop nails-salon
tar -czf /root/nails-data-backup.tar.gz -C /opt/nails data
tar -xzf /tmp/nails-salon-update.tar.gz -C /opt/nails
systemctl start nails-salon
systemctl status nails-salon --no-pager
journalctl -u nails-salon -n 50 --no-pager
```

The release archive should contain application source, `public/`, documentation, and package manifests. It must not contain `.env`, `data/`, or `node_modules/`. If dependencies change in a future release, run `npm ci --omit=dev` from `/opt/nails` before restarting.

## Reverse proxy expectations

The deployment script configures Nginx to:

- redirect HTTP to HTTPS (while allowing the ACME challenge path),
- forward requests to `127.0.0.1:3000`,
- pass the original host and HTTPS protocol,
- allow image uploads up to 18 MiB total.

Keep port 3000 bound to localhost behind Nginx. Do not expose it directly to the internet.
