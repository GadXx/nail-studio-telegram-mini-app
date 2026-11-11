# Contributing

Thanks for helping improve Nail Studio. Keep changes focused, explain the user or operational problem they solve, and update documentation when behavior or configuration changes.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and configure a random `SESSION_SECRET`.
4. Copy `data/salon.example.json` to `data/salon.json` and replace the bootstrap Telegram ID before running the app.

## Before opening a pull request

```sh
npm run check
```

The check validates JavaScript syntax. Include manual verification details for changes that alter Telegram WebView behavior, booking rules, database migrations, or server deployment. Do not commit `.env`, salon-specific configuration, databases, customer records, or uploaded files.

## Pull requests

- Describe the problem and the user-facing change.
- Call out database migrations and deployment steps.
- Include screenshots for visible interface changes when practical.
- Keep secrets and real customer data out of commits, logs, screenshots, and issue reports.
