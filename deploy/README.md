# Deploying the demo

One EC2 box (Ubuntu or Amazon Linux 2023), no Ableton or Splice: mate runs with both
ports stubbed and the Anthropic brain live. nginx + certbot run in docker; mate and the
app run on the host under systemd. Nothing gates the site: mate's API is unauthenticated
and every command spends Anthropic credits, so treat the hostname as the only secret.

```
https://aibleton.thegoldenmule.com/        -> next start   (127.0.0.1:3000)
https://aibleton.thegoldenmule.com/mate/   -> mate         (127.0.0.1:4545, prefix stripped)
```

## First time

Prerequisites: DNS A record pointing at the box, security group open on 22/80/443,
`ANTHROPIC_API_KEY` either exported locally, in a local `.env` or `mate/.env`, or in `~/.env` on the box.

```bash
./deploy.sh -i ~/.ssh/key.pem --setup ubuntu@host
```

Installs docker, bun (pinned to app/package.json), node 22 and rsync, creates `/srv/aibleton`, writes `secrets.env`,
issues the cert with certbot in standalone mode, then runs a normal deploy.

## Every deploy

```bash
./deploy.sh -i ~/.ssh/key.pem ubuntu@host
```

rsync the working tree (see `rsync-exclude.txt`), `bun install`, `next build` on the box
(`NEXT_PUBLIC_MATE_URL` is baked at build time), render the templates in this directory,
restart both services, `docker compose up -d` and reload nginx, then check health.

## Files

- `server.env.template` -> `/srv/aibleton/app.env`, non-secret env for both services.
- `nginx.conf.template` -> `/srv/aibleton/proxy/default.conf`.
- `*.service.template` -> `/etc/systemd/system/`.
- `docker-compose.yml` -> nginx (host networking) and a certbot renew loop.

## Splice

Log in locally once with `bun run --cwd mate splice:login`. Every deploy then copies
`mate/.mate/splice-oauth.json` (or `$SPLICE_OAUTH_FILE`) to `/srv/aibleton/data/` when the local
file is newer than the box's copy; mate rewrites the server copy on token refresh, so a stale
local file never overwrites a rotated refresh token. Alternatively put `SPLICE_MCP_TOKEN=...` in
`/srv/aibleton/secrets.env`, which takes precedence. `GET /mate/adapters` reports whether Splice is live.

Logs: `journalctl -u aibleton-mate -f`, `journalctl -u aibleton-app -f`,
`docker logs aibleton-nginx`. Saved bands/songs live in `/srv/aibleton/data`.
