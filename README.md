# RoyalStuffs CRM

Internal CRM for **RoyalStuffs.com** — customer enquiries, sales, procurement,
packing & dispatch, billing, vendor invoices and post-sales grievances.

Module 1 (**Product Enquiry**) is in development. The other six modules are
planned but deliberately unspecified; no business logic has been invented for
them.

---

## Architecture

```
frontend/   Next.js · TypeScript · shadcn/ui · Tailwind
    │  REST over HTTP
    ▼
backend/    Node.js · Express · TypeScript · Zod
    │
    ▼
database/   Prisma · PostgreSQL (Neon)
```

`shared/` sits beside them as a contract package: every Zod schema, inferred
type, enum and business constant that crosses the API boundary lives there once.
The backend validates with those schemas; the frontend builds forms from the
same objects. A contract change is a compile error on both sides rather than a
runtime surprise at integration.

### Tier rules

| Rule | Why |
| --- | --- |
| Frontend never imports `@rs/database` or Prisma | The API is the only way in |
| Backend reaches the database only through `@rs/database` | Keeps the separation real, not just a folder name |
| Business logic never lives in a React component | The UI may mirror a rule for responsiveness; the server decides |
| No hardcoded employees, vendors, enquiries or counts in the UI | Everything comes from the database (§59) |
| Migrations are authored by one person | Three people generating migrations against one Neon branch conflicts painfully |

---

## Repository layout

```
royalstuffs-crm/
├── shared/              @rs/shared    — Zod schemas, types, enums, constants
│   └── src/
│       ├── constants/   business limits: 20 products, 15-minute SLA, bands
│       ├── enums.ts     single source of truth, mirrored by schema.prisma
│       ├── schemas/     auth · customer · vendor · enquiry · vendor-response
│       └── utils/       unit normalisation, money without floats
│
├── database/            @rs/database  — the only tier that talks to Postgres
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── sql/business-invariants.sql
│   │   ├── migrations/
│   │   └── seed.ts
│   └── src/index.ts     the PrismaClient singleton
│
├── backend/             @rs/backend   — Express API, owns all business logic
│   └── src/
│       ├── config/      env (Zod-parsed) · logger · cors · database
│       ├── middleware/  requestId · requestLogger · validate · notFound · errorHandler
│       ├── modules/     health/ (auth, customers, vendors, enquiries follow)
│       ├── routes/      API surface assembly
│       ├── utils/       AppError · apiResponse · requestContext
│       ├── app.ts       Express assembly (importable by tests)
│       └── server.ts    bootstrap, listener, graceful shutdown
├── frontend/            (not yet created — Phase 7)
├── .env.example
└── package.json         npm workspaces root
```

---

## Setup

Requires **Node 20+** and a Neon PostgreSQL database.

```bash
npm install
cp .env.example .env      # then fill it in — see below
```

### Environment variables

Everything lives in a single root `.env`, which is git-ignored. `.env.example`
is committed with empty values and is the canonical list.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** connection, used by the running app |
| `DIRECT_URL` | Neon **direct** connection, required by Prisma Migrate |
| `AUTH_SECRET` | Signs the session JWT; shared by Next.js and Express |
| `FRONTEND_URL` / `BACKEND_URL` | CORS allowlist and API base |
| `CLOUDINARY_*` | Image storage — cloud name, API key, API secret |
| `SMTP_*`, `MAIL_FROM` | Nodemailer |
| `ENQUIRY_SLA_MINUTES` | Default 15; snapshotted onto each enquiry |
| `ENQUIRY_NUMBER_PERIOD` | `CALENDAR` (2026) or `FINANCIAL` (2026-27) |
| `SEED_*_PASSWORD` | Seed-only; never hardcoded in `seed.ts` |

Generate the auth secret with `openssl rand -base64 32`. Never commit `.env`.

> **Dependency note:** the root `package.json` pins an `overrides` entry for
> `deepmerge-ts@^8`. Prisma 6.19's config loader still depends on v7, which
> carries a high-severity stack-exhaustion advisory. The override resolves it;
> `npm audit` reports zero vulnerabilities. Remove it once Prisma ships v8.


### Database

The schema is already migrated. Against a fresh database:

```bash
npm run db:generate                              # generate the Prisma client
npm run migrate:deploy --workspace @rs/database  # apply existing migrations
```

Two migrations exist:

| Migration | Contents |
| --- | --- |
| `20260825090210_initial_crm_schema` | 12 tables, 12 enums, 17 foreign keys, 20 unique indexes |
| `20260825090309_business_invariants` | 13 CHECK constraints from `prisma/sql/business-invariants.sql` |

The invariants enforce the 20-product cap, positive quantities and rates, the
`NO_VENDOR`-needs-a-reason rule, the `OTHERS`-needs-a-detail rule, and the
frozen-efficiency pairing, at the database level — so concurrency cannot slip
past them.

Prisma commands run through `dotenv-cli` so the single root `.env` stays the
only secrets file; the Prisma CLI would otherwise look for `.env` beside the
schema. Use `migrate:deploy` rather than `migrate dev` against a database that
holds real data — `deploy` never resets.

```bash
npm run db:seed         # create Kaartik, Devansh, Aparna + dev fixtures
npm run db:studio       # browse the data
```

### Running the API

```bash
npm run build:shared    # backend imports @rs/shared from dist
npm run db:generate     # backend imports @rs/database from dist
npm run dev:backend     # tsx watch on http://localhost:4000
```

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Liveness — process only, touches nothing external |
| `GET /api/health/ready` | Readiness — pings the database; 503 when it is down |

The API refuses to start if the environment is invalid or the database is
unreachable, rather than binding a port and failing on the first real request.

The seed is idempotent — it upserts by `employeeId`, so re-running it rotates
passwords rather than creating duplicate users.

---

## Business rules that are non-negotiable

These are enforced in three places — Zod at the edge, the service layer in a
transaction, and a Postgres `CHECK` constraint:

1. **At most 20 products** per enquiry.
2. **15-minute SLA**, its deadline calculated by the backend from a single
   Postgres `now()`. The frontend timer is a rendering of that fact, never the
   source of truth.
3. **Efficiency is frozen once** at the first submit and never recalculated —
   each enquiry snapshots the `slaMinutes` in force when it was created.
4. **Delay reasons are append-only.** A prior delay is never overwritten.
5. **Partial Submit never closes the enquiry.** Pending lines survive it.
6. **Full Submit** requires every line either `RESPONDED` or `NO_VENDOR` with a
   mandatory reason.
7. **Many vendor responses per product line.**
8. **Passwords are bcrypt-hashed** (cost 12) and never logged.
9. **Authorization is server-side.** The UI hides what you cannot do; the API
   refuses it.

---

## Development workflow

```
main      deployable, no direct pushes
develop   integration branch, PR + one review
feature/* one slice: feature/auth, feature/enquiry-api, feature/enquiry-form
```

Conventional commits, small and single-purpose:

```
feat: add product enquiry schema
feat: add enquiry creation API
fix: validate enquiry product limit
```

### Team

| | Owns |
| --- | --- |
| **Kaartik** | Core architecture, `@rs/shared`, auth, RBAC, error handling, config, CI, integration |
| **Devansh** | Prisma schema and migrations, enquiry APIs, SLA engine, status guard, history/audit, tests |
| **Aparna** | Design system, app shell, all field components, listing, detail page, timer, dialogs |

Schema changes go through Devansh so migrations stay linear.

---

## Phase status

| Phase | | |
| --- | --- | --- |
| 1 | Architecture planning | ✅ |
| 2 | Database schema | ✅ |
| 3 | Backend foundation | ✅ |
| 4 | Authentication | — |
| 5 | User / role system | — |
| 6 | Product Enquiry APIs | — |
| 7 | Product Enquiry frontend | — |
| 8 | Vendor response workflow | — |
| 9 | 15-minute SLA and timer | — |
| 10 | History / audit system | — |
| 11 | Dashboard foundations | — |
| 12 | Testing | — |
