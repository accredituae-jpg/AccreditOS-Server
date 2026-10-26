# AccreditOS Backend API

This is the backend REST API service for **AccreditOS**, an enterprise resource planning (ERP) system built for training centers and compliance management. The backend is built using Node.js, Express.js, TypeScript, and Prisma ORM with PostgreSQL.

---

## 🛠️ Features

- **RESTful Endpoints**: Modular router structure grouping related business domains (Auth, Clients, Courses, Trainings, Certificates, Finance, Settings, Receipts).
- **Relational Schema Management**: Built using PostgreSQL and modeled through Prisma ORM for type-safe queries and database migrations.
- **Database Seeding**: Ready-to-go seeds for initial permissions, invoice lookup tables, expense categories, awarding bodies, and default administrators (`prisma/seed.ts`).
- **Robust Security Middleware**:
  - `Helmet` to secure HTTP headers.
  - `CORS` configured with whitelist origin support.
  - `Express Rate Limit` configured to protect login attempts and API routes.
  - `JSON Web Token (JWT)` stateless authorization with signature verification.
- **Pino Logger**: Structured logging for observability.

---

## ⚙️ Environment Configuration

To configure the server, copy `.env.example` to `.env` in the backend directory. Refer to the table below for parameters:

| Variable | Description | Required | Example |
|---|---|---|---|
| `PORT` | The port the Express application will listen on. | No (Defaults to `5000`) | `5000` |
| `JWT_SECRET` | Secret key used to sign and verify JSON Web Tokens. | **Yes** | `accreditos-super-secret-key-change-in-production` |
| `DATABASE_URL` | Connection URL for PostgreSQL. | **Yes** | `postgresql://postgres:pass@localhost:5432/accreditos?pgbouncer=true` |
| `DIRECT_URL` | Direct connection URL to bypass connection pooling (e.g. pgBouncer). | **Yes** | `postgresql://postgres:pass@localhost:5432/accreditos` |
| `FRONTEND_URL` | Allowed origin URL for CORS configuration. | No (Defaults to `http://localhost:8080`) | `http://localhost:8080` |
| `NODE_ENV` | Environment identifier (`development` or `production`). | No | `development` |

---

## 🚀 Available Scripts

In the `accreditOS-backend` directory, you can run the following npm scripts:

| Command | Description |
|---|---|
| `npm run dev` | Runs the API server in development mode using `tsx` with auto-reload. |
| `npm run build` | Compiles TypeScript into production JavaScript inside the `dist/` folder. |
| `npm run start` | Launches the precompiled application from `dist/index.js`. |
| `npm run db:migrate` | Runs pending Prisma migrations against the database. |
| `npm run db:seed` | Populates lookup data and initial administrator users. |

---

## 📂 Backend Architecture

```text
accreditOS-backend/
├── prisma/
│   ├── migrations/      # Auto-generated SQL migration files
│   ├── schema.prisma    # Data models, relations, and DB configurations
│   └── seed.ts          # Database seed configurations
├── .env.example         # Example environment configuration
├── src/
│   ├── index.ts         # Server bootstrap, middleware, and entry file
│   ├── logger.ts        # Pino logger configuration
│   ├── prisma.ts        # PrismaClient instance export
│   ├── routes/          # Express domain routers
│   ├── controllers/     # Controller handlers
│   ├── middleware/      # Auth & RBAC validation middleware
│   └── services/        # Business logic services
```

For more detailed technical architecture and database deployment guides, see [`../docs/SYSTEM_ARCHITECTURE.md`](../docs/SYSTEM_ARCHITECTURE.md) and [`../docs/OPERATIONS_AND_DEPLOYMENT.md`](../docs/OPERATIONS_AND_DEPLOYMENT.md).
