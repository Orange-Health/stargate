<p align="center">
  <img src="public/stargate-logo.png" alt="Stargate" width="180" height="180" />
</p>

<h1 align="center">Stargate</h1>

Stargate is Orange Health's release dashboard . Connects Jira versions, GitHub PRs/tags, and Jenkins deploys.

```bash
npm install
npm run dev
```

## Include the Git `release` branch

By default the dashboard uses **Dev → Default**. There is no UI toggle. Opt in from the browser console on the dashboard origin, then reload:

```js
localStorage.setItem('release-desk-use-release-branch', 'true')
```

That switches promotions and back-merges to **Dev → Release → Default** (and **Default → Release → Dev**). Control room, service operations, and PR branch chips follow the same flag.

| Value | Mode |
| --- | --- |
| missing or `'false'` | Dev → Default (default) |
| `'true'` | Dev → Release → Default |

Go back to skipping the release branch:

```js
localStorage.setItem('release-desk-use-release-branch', 'false')
```

or:

```js
localStorage.removeItem('release-desk-use-release-branch')
```

Reload after any change. The preference is per browser profile, not per repository.

## Other localStorage settings

| Key | Set by | Notes |
| --- | --- | --- |
| `release-desk-use-release-branch` | DevTools console (above) | `'true'` to opt in |
| `release-desk-theme` | header theme button | `'dark'` (default) or `'light'` |
| `release-desk-pinned-repositories` | pin control on the overview | JSON array of `owner/repo` strings |
| `release-desk-progress:<versionId>` | release progress bar | JSON snapshot; safe to delete |
