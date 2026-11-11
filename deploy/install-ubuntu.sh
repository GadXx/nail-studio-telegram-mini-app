#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Запусти этот сценарий от root." >&2
  exit 1
fi

PUBLIC_IP="${1:-}"
if [[ -z "$PUBLIC_IP" ]]; then
  echo "Использование: $0 ПУБЛИЧНЫЙ_IP" >&2
  exit 1
fi
python3 - "$PUBLIC_IP" <<'PY'
import ipaddress, sys
ipaddress.ip_address(sys.argv[1])
PY

APP_DIR=/opt/nails
if [[ ! -f "$APP_DIR/package.json" || ! -f "$APP_DIR/.env" ]]; then
  echo "В $APP_DIR должны находиться файлы проекта и .env." >&2
  exit 1
fi

if ss -ltnH | awk '{print $4}' | grep -Eq ':(80|443|3000)$'; then
  echo "Порт 80, 443 или 3000 уже занят. Освободи его перед установкой." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg nginx snapd python3 build-essential
systemctl enable --now snapd.socket

curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
rm -f /tmp/nodesource_setup.sh
apt-get install -y nodejs

python3 - "$APP_DIR/.env" "$PUBLIC_IP" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
public_ip = sys.argv[2]
updates = {
    "PUBLIC_APP_URL": f"https://{public_ip}",
    "NODE_ENV": "production",
    "HOST": "127.0.0.1",
    "PORT": "3000",
}
existing = env_path.read_text().splitlines() if env_path.exists() else []
kept = []
for line in existing:
    key = line.split("=", 1)[0].strip() if "=" in line else ""
    if key not in updates:
        kept.append(line)
kept.extend(f"{key}={value}" for key, value in updates.items())
env_path.write_text("\n".join(kept) + "\n")
PY

cd "$APP_DIR"
npm ci --omit=dev

if ! id nails >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin nails
fi
chown -R root:root "$APP_DIR"
chown -R nails:nails "$APP_DIR/data"
chmod 640 "$APP_DIR/.env"
chown root:nails "$APP_DIR/.env"

cat >/etc/systemd/system/nails-salon.service <<EOF
[Unit]
Description=Nails salon Telegram Mini App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nails
Group=nails
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF

mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
cat >/etc/nginx/sites-available/nails-salon <<EOF
server {
    listen 80;
    server_name $PUBLIC_IP;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 404;
    }
}
EOF
ln -sfn /etc/nginx/sites-available/nails-salon /etc/nginx/sites-enabled/nails-salon
nginx -t
systemctl enable --now nginx
systemctl enable --now nails-salon

snap install certbot --classic
CERTBOT=/snap/bin/certbot
"$CERTBOT" certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot --webroot-path /var/www/certbot \
  --preferred-profile shortlived --ip-address "$PUBLIC_IP"

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat >/etc/letsencrypt/renewal-hooks/deploy/reload-nginx <<'EOF'
#!/bin/sh
systemctl reload nginx
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx

cat >/etc/nginx/sites-available/nails-salon <<EOF
server {
    listen 80;
    server_name $PUBLIC_IP;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name $PUBLIC_IP;

    ssl_certificate /etc/letsencrypt/live/$PUBLIC_IP/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$PUBLIC_IP/privkey.pem;
    client_max_body_size 18m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF
nginx -t
systemctl reload nginx

systemctl enable --now snap.certbot.renew.timer
echo "Готово. Приложение: https://$PUBLIC_IP"
echo "Состояние служб: systemctl status nails-salon nginx --no-pager"
