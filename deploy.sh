#!/usr/bin/env bash
#
# Deploy aibleton (mate + app) to a single EC2 box behind nginx + certbot.
#
#   ./deploy.sh [-i key.pem] [--setup] [--domain host] user@host
#
#   --setup   One-time: install docker, bun, node and rsync, create /srv/aibleton, write
#             secrets, issue the TLS cert. Then runs a normal deploy.
#             ANTHROPIC_API_KEY is taken from the environment or from ./.env
#             or ./mate/.env locally, or from ~/.env on the server; first found wins.
#             CERTBOT_EMAIL is optional (registers without an email when unset).
#
#   Every deploy: rsync the source, bun install, build the app, render config, restart
#   the systemd services, (re)start the proxy, and check health.
#
# Server layout under /srv/aibleton:
#   src/          rsynced checkout           data/         mate's persisted state
#   app.env       rendered, non-secret env   secrets.env   ANTHROPIC_API_KEY, never rewritten
#   proxy/        rendered nginx conf        letsencrypt/  certbot state; certbot-www/ challenges
#
set -euo pipefail

DOMAIN="${DOMAIN:-aibleton.thegoldenmule.com}"
ROOT="${AIBLETON_ROOT:-/srv/aibleton}"
KEY=""
SETUP=0
TARGET=""

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -i) KEY="$2"; shift 2 ;;
    --setup) SETUP=1; shift ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || usage
case "$TARGET" in *@*) ;; *) echo "target must be user@host" >&2; usage ;; esac
REMOTE_USER="${TARGET%%@*}"

HERE="$(cd "$(dirname "$0")" && pwd)"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes)
[ -n "$KEY" ] && SSH_OPTS+=(-i "$KEY")
SSH_CMD="ssh ${SSH_OPTS[*]}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# Run a bash script on the server. The script arrives on stdin so secrets never hit argv;
# it is wrapped in a function so bash parses all of it before running, and the function runs
# with stdin from /dev/null so no command inside (apt, installers, bun) can swallow the rest.
remote() {
  { echo 'main() {'; cat; echo '}; main </dev/null'; } | $SSH_CMD "$TARGET" "bash -s"
}

# Common preamble for every remote script.
preamble() {
  cat <<EOF
set -euo pipefail
export PATH="\$HOME/.bun/bin:/usr/local/bin:\$PATH"
ROOT=$(printf %q "$ROOT")
DOMAIN=$(printf %q "$DOMAIN")
REMOTE_USER=$(printf %q "$REMOTE_USER")
EOF
}

# ---------------------------------------------------------------- setup (one time)

if [ "$SETUP" = 1 ]; then
  API_KEY="${ANTHROPIC_API_KEY:-}"
  for envfile in "$HERE/.env" "$HERE/mate/.env"; do
    [ -n "$API_KEY" ] && break
    [ -f "$envfile" ] || continue
    API_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' "$envfile" | head -1 | tr -d '"'"'")"
  done
  CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
  BUN_VERSION="$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' "$HERE/app/package.json")"
  [ -n "$BUN_VERSION" ] || { echo "could not read packageManager bun version from app/package.json" >&2; exit 1; }

  log "setup: packages, bun, directories, secrets, cert on $TARGET"
  {
    preamble
    cat <<EOF
API_KEY=$(printf %q "$API_KEY")
CERTBOT_EMAIL=$(printf %q "$CERTBOT_EMAIL")
BUN_VERSION=$(printf %q "$BUN_VERSION")
EOF
    cat <<'EOF'
# --- packages
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl rsync unzip docker.io docker-compose-v2
  if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
  fi
elif command -v dnf >/dev/null; then
  # curl-minimal ships on AL2023 and conflicts with the curl package; do not install curl here.
  sudo dnf install -y -q rsync unzip docker nodejs22
  if ! docker compose version >/dev/null 2>&1; then
    arch="$(uname -m)"
    sudo mkdir -p /usr/local/lib/docker/cli-plugins
    sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
  fi
else
  echo "unsupported distro: need apt-get or dnf" >&2; exit 1
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$REMOTE_USER" || true

# --- bun (per-user install, symlinked for systemd)
if [ "$(bun --version 2>/dev/null || true)" != "$BUN_VERSION" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
fi
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version
node --version

# --- layout
sudo mkdir -p "$ROOT"/{src,data,proxy,letsencrypt,certbot-www}
sudo chown -R "$REMOTE_USER":"$REMOTE_USER" "$ROOT/src" "$ROOT/data" "$ROOT/proxy" "$ROOT/certbot-www"
sudo chown "$REMOTE_USER":"$REMOTE_USER" "$ROOT"

# --- secrets (never rewritten by deploy). Sources, first wins: explicit key, existing file, ~/.env.
if [ -n "$API_KEY" ]; then
  umask 077; printf 'ANTHROPIC_API_KEY=%s\n' "$API_KEY" > "$ROOT/secrets.env"
elif [ -f "$ROOT/secrets.env" ] && grep -q '^ANTHROPIC_API_KEY=' "$ROOT/secrets.env"; then
  echo "secrets.env already present"
elif [ -f "$HOME/.env" ] && grep -q '^ANTHROPIC_API_KEY=' "$HOME/.env"; then
  umask 077; grep '^ANTHROPIC_API_KEY=' "$HOME/.env" > "$ROOT/secrets.env"
  echo "took ANTHROPIC_API_KEY from ~/.env"
else
  echo "WARNING: no ANTHROPIC_API_KEY found; write $ROOT/secrets.env by hand (mate will fail to start)" >&2
fi
[ -f "$ROOT/secrets.env" ] && chmod 600 "$ROOT/secrets.env" || true

# --- initial cert (standalone on :80; nginx is not up yet on first setup)
if sudo test -f "$ROOT/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  echo "cert for $DOMAIN already present"
else
  sudo docker rm -f aibleton-nginx >/dev/null 2>&1 || true
  if [ -n "$CERTBOT_EMAIL" ]; then reg=(--email "$CERTBOT_EMAIL"); else reg=(--register-unsafely-without-email); fi
  sudo docker run --rm -p 80:80 -v "$ROOT/letsencrypt:/etc/letsencrypt" certbot/certbot \
    certonly --standalone --non-interactive --agree-tos "${reg[@]}" -d "$DOMAIN"
fi
echo "setup done"
EOF
  } | remote
fi

# ---------------------------------------------------------------- deploy (every time)

if ! $SSH_CMD "$TARGET" "test -d $(printf %q "$ROOT")/src" </dev/null; then
  echo "$ROOT/src does not exist on $TARGET; run with --setup first" >&2
  exit 1
fi

log "rsync source -> $TARGET:$ROOT/src"
rsync -az --delete --stats \
  --exclude-from="$HERE/deploy/rsync-exclude.txt" \
  -e "$SSH_CMD" \
  "$HERE/" "$TARGET:$ROOT/src/"

# Splice OAuth login, written locally by `bun run --cwd mate splice:login`. Copied only when the
# local file is newer (-u): mate rewrites the server copy on token refresh, and an older local
# file must not overwrite a rotated refresh token.
OAUTH_LOCAL="${SPLICE_OAUTH_FILE:-$HERE/mate/.mate/splice-oauth.json}"
if [ -f "$OAUTH_LOCAL" ]; then
  log "copy Splice OAuth file -> $TARGET:$ROOT/data/splice-oauth.json"
  rsync -au -e "$SSH_CMD" "$OAUTH_LOCAL" "$TARGET:$ROOT/data/splice-oauth.json"
else
  echo "no local Splice OAuth file at $OAUTH_LOCAL; leaving the box as is"
fi

log "install, build, render config, restart services"
{
  preamble
  cat <<'EOF'
cd "$ROOT/src"
BUN="$(command -v bun)"
NODE="$(command -v node)"

# Rendered config: env, nginx, systemd units. Templates live in the repo.
render() { sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ROOT__|$ROOT|g" -e "s|__USER__|$REMOTE_USER|g" -e "s|__BUN__|$BUN|g" -e "s|__NODE__|$NODE|g" "$1"; }
render deploy/server.env.template > "$ROOT/app.env"
render deploy/nginx.conf.template > "$ROOT/proxy/default.conf"
chmod 644 "$ROOT/proxy/default.conf"
[ -f "$ROOT/data/splice-oauth.json" ] && chmod 600 "$ROOT/data/splice-oauth.json" || true
render deploy/aibleton-mate.service.template | sudo tee /etc/systemd/system/aibleton-mate.service >/dev/null
render deploy/aibleton-app.service.template  | sudo tee /etc/systemd/system/aibleton-app.service  >/dev/null
sudo systemctl daemon-reload

bun install --frozen-lockfile

set -a; . "$ROOT/app.env"; set +a
bun run --cwd app build

sudo systemctl enable --quiet aibleton-mate aibleton-app
sudo systemctl restart aibleton-mate aibleton-app

# Proxy: bring up (no-op if unchanged) and reload so a changed nginx conf is picked up.
export AIBLETON_ROOT="$ROOT"
sudo -E docker compose -p aibleton -f deploy/docker-compose.yml up -d --remove-orphans
sudo docker exec aibleton-nginx nginx -t
sudo docker exec aibleton-nginx nginx -s reload

# Health: local services, then the public edge (200 through nginx proves TLS is in place).
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4545/health >/dev/null && curl -fsS -o /dev/null http://127.0.0.1:3000/; then break; fi
  [ "$i" = 30 ] && { echo "services did not come up" >&2; sudo systemctl status --no-pager aibleton-mate aibleton-app || true; exit 1; }
  sleep 1
done
code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/mate/health")"
[ "$code" = 200 ] || { echo "expected 200 from https://$DOMAIN/mate/health, got $code" >&2; sudo docker logs --tail 20 aibleton-nginx >&2; exit 1; }
code="$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
[ "$code" = 200 ] || { echo "expected 200 from https://$DOMAIN/, got $code" >&2; sudo docker logs --tail 20 aibleton-nginx >&2; exit 1; }
echo "deployed: https://$DOMAIN"
EOF
} | remote
