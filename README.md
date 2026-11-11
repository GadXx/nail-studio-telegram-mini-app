# Nail Studio

**Telegram Mini App for appointment booking at a nail salon.** Clients book directly in Telegram; each master manages an individual calendar, while the main master manages team access and staff changes.

The application is built for a small salon that needs a focused booking workflow without a separate customer account system or a manually maintained staff list.

## Product capabilities

### For clients

- Browse active masters and available times across a rolling 14-day window.
- Book with a Telegram username, or provide a phone number when no username is available.
- Add an optional note and up to three reference photos.
- Receive a Telegram message when a master moves or cancels an appointment, when delivery is possible.

### For masters

- Work from a single personal workspace with upcoming and past appointments.
- Set daily working hours, starting at 10:00–20:00 by default.
- Mark a date or time range as unavailable without silently changing existing appointments.
- Create an appointment by reserving a free time slot.
- Open client photos, cancel appointments, or move them to an available slot.
- See when a client must be contacted manually after a failed Telegram notification.

### For the main master

- Review staff access requests and edit a name before approval.
- Transfer or explicitly cancel a staff member’s future appointments before deactivation.
- Keep appointment history when a master is deactivated.

## Technology

- Node.js 20 or newer, ES modules
- Express 5
- SQLite via `better-sqlite3`
- Telegram Mini Apps authentication and Bot API notifications
- Server-rendered static assets (HTML, CSS, browser JavaScript)

## Run locally

### 1. Configure Telegram

Create a bot with [@BotFather](https://t.me/BotFather). Copy the examples and set the bot credentials:

```sh
cp .env.example .env
cp data/salon.example.json data/salon.json
```

Edit `.env` and `data/salon.json`:

- Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`.
- Set `SESSION_SECRET` to a unique random value: `openssl rand -hex 32`.
- Replace the example master’s Telegram ID with the ID of the main master. The first configured master becomes the main master on the first database initialization.
- Keep `PUBLIC_APP_URL` empty for the initial local run.

### 2. Install and start

```sh
npm ci
npm start
```

The server listens on port `3000` by default. Telegram requires a public HTTPS URL to open the Mini App. For a temporary development URL, expose the local server with a trusted HTTPS tunnel, then set `PUBLIC_APP_URL` to the issued HTTPS address and restart the application.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | Yes | — | Express session signing secret; use a unique random value of at least 32 characters. |
| `TELEGRAM_BOT_TOKEN` | For Telegram login | — | Bot API token from BotFather. |
| `TELEGRAM_BOT_USERNAME` | With bot token | — | Bot username, with or without `@`. |
| `PUBLIC_APP_URL` | For Mini App launch | — | Public HTTPS URL configured as the bot’s menu button. |
| `SALON_CONFIG` | No | `data/salon.json` | Initial salon name and bootstrap master list. Used to seed an empty master database. |
| `DATABASE_PATH` | No | `data/bookings.sqlite3` | SQLite database path for masters, appointments, and availability exceptions. |
| `TIMEZONE` | No | `Europe/Moscow` | Time zone used for appointment dates and working hours. |
| `PORT` | No | `3000` | HTTP port for the application server. |
| `SLOT_STEP_MINUTES` | No | `30` | Interval between candidate appointment start times. |
| `BOOKING_DURATION_MINUTES` | No | `60` | Length of each appointment. |

## Deployment

For a single Ubuntu server with Nginx, systemd, and a public HTTPS certificate, see [the deployment guide](docs/DEPLOYMENT.md). For architecture and data flow, see [the architecture overview](docs/ARCHITECTURE.md). For backups and routine operations, see [the operations guide](docs/OPERATIONS.md).

The included `deploy/install-ubuntu.sh` provisions a fresh server. It expects the project and a configured `.env` in `/opt/nails`; it is an installation script, not an in-place upgrade tool.

## Data and privacy

Salon data is local to the deployment. The SQLite database contains appointments and Telegram identifiers needed for booking and notifications. Uploaded reference photos are stored under `data/uploads/`. Back up and protect the entire `data/` directory. Never commit `.env`, `data/salon.json`, SQLite files, customer data, or uploaded photos.

The repository includes only `.env.example` and `data/salon.example.json` templates. Replace all example values before starting a real deployment.

## Project checks

Run the JavaScript syntax checks before opening a pull request:

```sh
npm run check
```

GitHub Actions runs the same check on pushes and pull requests. See [contribution guidelines](CONTRIBUTING.md) and [security policy](SECURITY.md).

## Current scope

This application is designed for a single salon deployment with one main master, multiple masters, and Telegram as the client entry point. It does not include payments, service catalogs, multi-location support, or a public web booking flow.
