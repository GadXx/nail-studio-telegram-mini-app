# Security policy

## Supported versions

Only the latest version on the default branch is supported at this stage. Deployments should use a current Node.js LTS release and keep dependencies updated.

## Reporting a vulnerability

Please do not report security vulnerabilities in public issues. Use GitHub's private vulnerability reporting or security advisory feature if it is enabled for this repository. Include the affected version, impact, and a minimal reproduction where possible. Do not include real Telegram IDs, bot tokens, customer records, session cookies, or customer photos.

## Deployment security

- Store bot tokens and session secrets only in `.env` or a dedicated secret manager.
- Serve the Mini App over HTTPS and keep the Node.js port private behind Nginx.
- Keep `data/` private and restrict access to backups.
- Rotate the bot token through BotFather if it has been exposed.
- Treat Telegram IDs, booking details, phone numbers, and uploaded reference photos as private customer data.
