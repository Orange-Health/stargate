# lease-again

Orange Health release dashboard (UI brand: RD). Connects Jira versions, GitHub PRs/tags, and Jenkins deploys.

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run dev
```

`AUTH_DISABLED=true` skips Keycloak and uses a local mock user. Paste Jira/GitHub/Jenkins tokens on the connection screen as before; they are encrypted in Postgres.

To exercise real SSO, set `AUTH_DISABLED=false` and fill the Keycloak variables in `.env`. Add `http://127.0.0.1:8787/api/auth/callback` as a redirect URI on the Keycloak client.

## Skip the Git `release` branch

By default the dashboard uses **Dev → Release → Default**. There is no UI toggle. Set this in the browser console on the dashboard origin, then reload:

```js
localStorage.setItem('release-desk-use-release-branch', 'false')
```

That switches promotions and back-merges to **Dev → Default** (and **Default → Dev**). Control room, service operations, and PR branch chips follow the same flag.

| Value | Mode |
| --- | --- |
| missing or `'true'` | Dev → Release → Default (default) |
| `'false'` | Dev → Default |

Restore the release-branch flow:

```js
localStorage.setItem('release-desk-use-release-branch', 'true')
```

or:

```js
localStorage.removeItem('release-desk-use-release-branch')
```

Reload after any change. The preference is per browser profile, not per repository.

## Other localStorage settings

| Key | Set by | Notes |
| --- | --- | --- |
| `release-desk-use-release-branch` | DevTools console (above) | `'true'` / `'false'` |
| `release-desk-theme` | header theme button | `'dark'` (default) or `'light'` |
| `release-desk-pinned-repositories` | pin control on the overview | JSON array of `owner/repo` strings |
| `release-desk-progress:<versionId>` | release progress bar | JSON snapshot; safe to delete |
