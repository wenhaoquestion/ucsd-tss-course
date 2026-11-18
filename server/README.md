# Optional seat history and Web Push service

The GitHub Pages planner runs independently. This Go service adds persistent section observations and browser notifications when a section crosses a chosen threshold. It reads the anonymous UCSD Class Planner catalog for the configured terms. Students complete booking in TSS.

## Run locally

Set `POSTGRES_PASSWORD` to a new password in your environment, then run from the repository root.

```sh
docker compose up --build
```

Open `http://localhost:8080/api/health`. The API listens on loopback by default. Set `CORS_ORIGINS` to the frontend's exact browser origin, such as `http://localhost:5173` or `https://owner.github.io`. The origin excludes the Pages repository path. For a public deployment, put an HTTPS reverse proxy in front of the API and configure the frontend's API URL.

For native execution, use Go 1.25+ and a PostgreSQL database. Set `DATABASE_URL`, then run `go run .` from `server`. Standard PostgreSQL connection environment variables also work. The service creates its tables on startup. Its application DB user needs permission to create and update its schema and create temporary tables.

| Setting | Default or meaning |
| --- | --- |
| `DATA_DIR` | `../public/data` locally, `/data` in Compose |
| `TERMS` | `WI27`, or comma-separated UCSD term codes |
| `SYNC_INTERVAL` | `12h`, minimum `30m` |
| `SYNC_ENABLED` | Set `false` for seed-only operation |
| `CORS_ORIGINS` | Comma-separated exact origins, no wildcards |
| `VAPID_SUBJECT` | Operator contact such as `mailto:admin@example.edu` |
| `VAPID_PRIVATE_KEY` and `VAPID_PUBLIC_KEY` | One stable matching browser push key pair |

For notifications, generate keys locally with `go run . generate-vapid` or `docker compose run --rm --no-deps api generate-vapid`. Store the keys with the deployment's secrets and set all three `VAPID_*` variables before starting the API. Without them, seat and history queries work and the public key is empty. Browser subscriptions are tied to the VAPID public key. Re-subscribe browsers after replacing that key.

## API

| Request | Result |
| --- | --- |
| `GET /api/health` | Database availability, last completed network sync per term, sync interval, push availability |
| `GET /api/catalog?term=WI27` | The bundled WI27 catalog |
| `GET /api/seats?term=WI27&ids=E%2000006900,E%2000009858` | `{source,observedAt,seats:{[sectionId]:{available,capacity,waitlist,observedAt,sourceAt}}}` |
| `GET /api/history?term=WI27&section=E%2000006900` | `{points:[{at,available,capacity,waitlist}]}`, most recent 2,000 change points in chronological order |
| `GET /api/push/key` | `{publicKey}` |
| `POST /api/watch` | JSON `{term,sectionId,threshold,subscription,locale}` returns `{id,token}`; thresholds start at 1 |
| `DELETE /api/watch/{id}` | Send `Authorization: Bearer <token>`. Success returns HTTP 204 |

Use the raw UCSD section ID, including its space. Subscriptions cover one section. Course components with a shared section ID share one observation. Unknown counts are JSON `null`. Each successful full fetch stamps `observedAt`. For WI27 the upstream count time is unknown, represented by `sourceAt: null`. The API preserves the last valid observation and its timestamp across outages. A missing section does not acquire a zero. History records changes and the first observation.

The service imports `seats.json` at its bundled observation time and then refreshes from the public catalog. Incomplete upstream reads discard the pending sample and retry with exponential backoff. Successful threshold crossings enter a PostgreSQL delivery queue in the same transaction. The browser receives encrypted JSON `{title,body,url}`. The relative URL preserves the Pages deployment path. Delivery retries transient failures, removes expired browser endpoints, and uses a per-watch push topic for collapse. A watch expires after 120 days unless renewed. Incoming browser registrations accept HTTPS subscription endpoints operated by supported browser vendors. Revocation cancels queued alerts.

## GitHub Pages observations

The `Public seat observations` workflow runs hourly and can run manually. It uses the same anonymous reader as the API. Each successful run creates a commit on `public-data`, containing the term manifest and content-addressed seat and history shards. A failed full read leaves the preceding commit available. GitHub must allow the workflow's `contents: write` permission. The scheduled workflow runs on the repository's default branch and uses the `OBSERVATION_TERM` repository variable, defaulting to `WI27`.

Read `https://raw.githubusercontent.com/OWNER/REPO/public-data/WI27/manifest.json`, then choose a shard using the final two digits of the raw section ID, or `other`. Resolve each relative `seats` or `history` path against the manifest URL. Per-section history retains up to 336 changes over roughly 70 days and, where possible, the preceding point. The observed time in the manifest applies to all present seat counts. Missing sections have no current observation. Immutable files for the previous and current manifest remain accessible. This feed supports checks while Pages is open; the Go delivery worker handles notifications while it is closed.

To generate files locally without publishing, run `go run . publish-observations WI27 /path/to/temp-output` from `server`. The generator makes sequential paginated requests to the public catalog. The GitHub script commits and pushes only when explicitly run by the configured workflow.

## Test

Run `go test ./...` from `server`. For PostgreSQL integration coverage, set `TEST_DATABASE_URL` to a disposable database URL. The integration test creates its own uniquely named schema and removes it when finished. It exercises seat changes, idempotent watch creation, revocation, and a VAPID-encrypted delivery to a simulated push provider.
