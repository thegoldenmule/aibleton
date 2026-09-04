# Deploying the demo

One EC2 box (Ubuntu or Amazon Linux 2023), no Ableton or Splice: mate runs with both
ports stubbed and the Anthropic brain live. nginx + certbot run in docker; mate and the
app run on the host under systemd. The site sits behind basic auth because the API is
unauthenticated and every command spends Anthropic credits.

```
https://aibleton.thegoldenmule.com/        -> next start   (127.0.0.1:3000)
https://aibleton.thegoldenmule.com/mate/   -> mate         (127.0.0.1:4545, prefix stripped)
```

## First time

Prerequisites: DNS A record pointing at the box, security group open on 22/80/443,
`ANTHROPIC_API_KEY` either exported locally, in a local `.env` or `mate/.env`, or in `~/.env` on the box.

```bash
BASIC_AUTH_USER=... BASIC_AUTH_PASSWORD=... ./deploy.sh -i ~/.ssh/key.pem --setup ubuntu@host
```

Installs docker, bun (pinned to app/package.json), node 22 and rsync, creates `/srv/aibleton`, writes the htpasswd and `secrets.env`,
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

Either put `SPLICE_MCP_TOKEN=...` in `/srv/aibleton/secrets.env`, or log in locally with
`bun run --cwd mate splice:login` and copy the result to the box:

```bash
scp -i ~/.ssh/key.pem .mate/splice-oauth.json ubuntu@host:/srv/aibleton/data/splice-oauth.json
```

Then `sudo systemctl restart aibleton-mate`. The file must stay owned by the service user (mate
rewrites it on token refresh). `GET /mate/adapters` reports whether Splice is live.

Logs: `journalctl -u aibleton-mate -f`, `journalctl -u aibleton-app -f`,
`docker logs aibleton-nginx`. Saved bands/songs live in `/srv/aibleton/data`.
