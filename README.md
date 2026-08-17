# Nessha Workspace

An isolated foundation for the private Workspace product. It runs beside legacy Nessha and is loopback-only until a later, explicit route cutover.

## Foundation boundary

- One Docker application container and one named SQLite volume.
- No legacy Nessha source, database, PM2 service, Nginx route, user data, session, memory, or credential is copied.
- Workspace Chip has its own empty private memory and skill boundaries.
- Future Living integration is a versioned contract placeholder only.

## Run

```sh
docker compose up --build -d
curl http://127.0.0.1:3105/healthz
curl http://127.0.0.1:3105/readyz
```

The app is intentionally not publicly routed yet.
