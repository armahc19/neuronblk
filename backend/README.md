# NeuronBLK Sync API

Minimal FastAPI service that syncs flowchart projects to local PostgreSQL.
One JSONB blob per project (`blocks` + `connections`); last-write-wins on
conflicting updates.

## Setup

```bash
# 1. Create the local database (adjust user/password as needed)
createdb neuronblk

# 2. Python env
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt

# 3. Configure connection string
cp .env.example .env
# edit .env if your Postgres user/password/host differ from the default

# 4. Run
uvicorn main:app --reload --port 8000
```

Tables are auto-created on startup via `init_db()` — fine for local dev.
Swap in Alembic migrations once the schema needs to change without wiping
data.

## Endpoints

- `GET /api/projects?client_id=<uuid>` — list all projects for a client
- `GET /api/projects/{id}` — fetch one project
- `PUT /api/projects/{id}` — upsert (create or update) a project
- `DELETE /api/projects/{id}` — delete a project

No auth yet — `client_id` is a random UUID the frontend generates and
persists locally, just to scope "whose projects are whose" without
requiring accounts. Layer real auth on top later by replacing `client_id`
with an authenticated user id.
