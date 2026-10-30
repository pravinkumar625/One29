# Class of ’29 — Portfolio Platform

A high-performance student portfolio platform for a class of 30 students (scalable up to 200+ via MAX_STUDENTS). Built with a butter-yellow editorial aesthetic, fluid animations, Neon PostgreSQL database, S3-compatible Neon Object Storage, and restricted Google OAuth student sign-in.

---

## Features
- **Editorial Design**: Custom typography, 3D tilt ID card, interactive ink blob, and pixel-dissolve transitions.
- **Strict Email Access Control**: Google sign-in is restricted exclusively to authorized student emails matching `^[a-zA-Z]+(?:\.[a-zA-Z]+)*\.s\.129@kalvium\.community$`.
- **Neon Postgres Backend**: Robust, parameterized SQL with automated migration runner (`migrations/`) and idle-reconnect retry logic.
- **S3-Compatible Neon Object Storage**: Direct presigned uploads for avatars (1 MB), project screenshots (1 MB), and optional resumes (3 MB PDF) with owner-controlled privacy.
- **Infinite Scroll & Search**: Debounced crew search across names, roles, and skills, with smooth `IntersectionObserver` pagination.
- **On-Demand Auto-Generated Resume**: Built on-the-fly directly from current profile data via PDFKit with zero storage overhead. Features 3 templates (Classic, Modern with theme accents, Minimal), live completeness indicator, and strict privacy controls.
- **Multi-Tenant Security**: Strict user isolation where editing/deletion only operates on the authenticated session user, with server-generated key paths preventing client file forgery.

---

## Quick Start (Local Development)

### 1. Requirements
- Node.js 18+ (`node -v`)
- Neon PostgreSQL connection string & Object Storage credentials (or run against local mock in tests)

### 2. Installation
Clone the repository and install dependencies:
```bash
npm install
```

### 3. Environment Setup
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your configuration values (see below for description of each variable).

### 4. Run the Server
```bash
node server.js
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## Environment Variables

All settings are configured via environment variables. Never commit `.env` or `.env.local` to git.

| Variable Name | Required | Description |
|---|---|---|
| `PORT` | Optional | Port for the HTTP server (default: `3000`). |
| `NODE_ENV` | Optional | Set to `production` when deployed to enforce `Secure` session cookies over HTTPS. |
| `MAX_STUDENTS` | Optional | Maximum student signup limit (default: `30`). Enforced inside database transactions. When set to `<= 60`, the site renders the classic full-grid look showing every spot (joined students + numbered open spot tiles). When set to `> 60`, it enables search box and infinite scrolling. |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth 2.0 Web Client ID. Activates Google Sign-In button when set. |
| `ALLOW_PASSWORD_LOGIN` | Optional | Set to `1` only for local offline dev without Google OAuth. Automatically disabled when `GOOGLE_CLIENT_ID` is set. |
| `DATABASE_URL` | Required | Postgres connection string (e.g., `postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require`). |
| `S3_ENDPOINT` | Optional | Neon Object Storage S3 endpoint URL. |
| `S3_REGION` | Optional | S3 region (default: `auto` or `us-east-1`). |
| `S3_ACCESS_KEY_ID` | Optional | S3 API Access Key ID. |
| `S3_SECRET_ACCESS_KEY` | Optional | S3 API Secret Access Key. |
| `S3_BUCKET_PUBLIC` | Optional | Bucket name for public assets (`public-media`). |
| `S3_BUCKET_PRIVATE` | Optional | Bucket name for private assets (`private-files`). |
| `PUBLIC_FILE_BASE_URL` | Optional | Base URL for direct public media access via CDN or public bucket endpoint. |

---

## Auto-Generated Resume & Extended Profile

The platform generates high-quality, downloadable A4 PDF resumes dynamically on demand directly from the student's latest profile entries. Because the PDF is built in-memory on each request, it is never saved to disk and always reflects real-time edits.

### Extended Profile Schema & Limits
The `users` table includes extended profile attributes managed through `migrations/003_add_resume_fields.sql`:
- **Education (`education` JSONB)**: Array of `{school, degree, field, start_year, end_year}` (capped at 6 items).
- **Experience (`experience` JSONB)**: Array of `{title, organisation, start, end, description}` (capped at 8 items).
- **Achievements (`achievements` JSONB)**: Array of short strings (capped at 10 items).
- **Certifications (`certifications` JSONB)**: Array of `{name, issuer, year}` (capped at 10 items).
- **Location (`location` VARCHAR)**: City/country text (capped at 100 chars, visible on profile and resume).
- **Phone (`phone` VARCHAR)**: Contact number (capped at 30 chars). **Strict Privacy:** Phone numbers are *never* displayed on public profiles or included in public resume views; they appear exclusively in the student's editor and on their own downloaded resume.

### Resume Templates
Three clean, printable A4 templates are available via `?template=<name>`:
- **`classic`**: Traditional, elegant styling with serif typography and deep navy section rules.
- **`modern`**: Clean layout using the student's selected portfolio theme color as a vibrant accent on headings and section dividers.
- **`minimal`**: Minimalist monochrome styling with subtle gray dividers and generous whitespace.

### Endpoints
- `GET /api/resume/auto`: Authenticated endpoint for the logged-in student to download their own resume with their phone number included. Supports `?template=classic|modern|minimal` and `?preview=1` for inline tab previewing.
- `GET /api/resume/auto/:username`: Accessible by classmates only if the student has enabled `resume_public` in their profile settings. Excludes private data (phone number and internal Google login emails are completely omitted).

---

## Storage Architecture & Buckets

The platform uses two isolated buckets on S3-compatible Neon Object Storage:

1. **`public-media` (Public Bucket)**:
   - Stores student profile avatars (`users/<username>/avatar/...`) and project screenshots (`users/<username>/project_image/...`).
   - Browser requests an upload URL via `POST /api/files/upload-url` (presigned S3 `PutObject`).
   - Browser directly uploads the binary data to S3 with `Content-Type`.
   - Browser confirms upload via `POST /api/files/complete`. The server verifies existence and size via `HeadObject`, stores the file record in PostgreSQL, and serves it with caching headers.
   - Maximum size: 1 MB. Permitted types: JPEG, PNG, WebP.

2. **`private-files` (Private Bucket)**:
   - Stores student resumes (`users/<username>/resume/...`).
   - Upload follows the same presigned PUT flow.
   - Maximum size: 3 MB (PDF only).
   - Students can mark their resume as public or private in profile settings.
   - Downloads go through `GET /api/resume/:username`, which generates a short-lived (5-minute) presigned GET URL only if permitted.

---

## Database Migrations & Legacy Data Import

### Automatic Migrations
Database tables are managed via versioned SQL migrations in the `migrations/` directory:
- `001_create_users_and_sessions.sql`: Creates `users` and `sessions` tables with indexes.
- `002_create_files.sql`: Creates `files` table for object tracking.

Migrations are automatically checked and applied on server startup. Each applied migration is tracked in the `schema_migrations` table.

### Importing Legacy JSON Data (`data/db.json`)
If you have an existing `data/db.json` from earlier versions, import it into Postgres with:
```bash
node migrate-json.js
```
The script imports user profiles, creates conflict-free records, and optionally uploads base64 avatar strings to Neon Object Storage if S3 credentials are configured.

---

## Running Automated Tests

The test suite uses Node's built-in test runner with `pg-mem` (in-memory PostgreSQL) and an in-memory mock S3 client. No live database or cloud storage connection is required to run tests.

Execute all tests:
```bash
npm test
```

### Test Coverage
- **Unit Tests (`test/email-rule.test.js`)**: Validates regex compliance, normalization, and edge cases.
- **Integration Tests (`test/integration.test.js`)**: Tests Google auth lifecycle, pre-made account linking, audience verification, and duplicate-login idempotency.
- **Scale, Security & Storage Tests (`test/phase-security-scale-storage.test.js`)**:
  - Multi-tenant isolation (acting user strictly taken from session).
  - Storage key forgery prevention and owner verification.
  - S3 file upload, complete, size limit enforcement, and deletion cleanup.
  - Private resume access controls.
  - Server-side pagination and crew grid search.
  - Transactional signup cap enforcement under high concurrency.
  - Account deletion cascade (deleting database rows and S3 objects).
  - Session cookie expiration.

---

## Deployment (Render / Railway / Fly.io)

Because data is stored in Neon PostgreSQL and media is stored in Neon Object Storage, the application is **completely stateless**. You do **not** need a persistent disk mounted on your host.

### Click-by-Click Deployment on Render
1. Push your repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com), click **New +** → **Web Service**.
3. Connect your GitHub repository.
4. Configure service settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Under **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = `<your-neon-postgres-connection-string>`
   - `S3_ENDPOINT` = `<your-neon-storage-endpoint>`
   - `S3_REGION` = `auto`
   - `S3_ACCESS_KEY_ID` = `<your-s3-access-key-id>`
   - `S3_SECRET_ACCESS_KEY` = `<your-s3-secret-access-key>`
   - `S3_BUCKET_PUBLIC` = `public-media`
   - `S3_BUCKET_PRIVATE` = `private-files`
   - `GOOGLE_CLIENT_ID` = `<your-google-oauth-client-id>`
   - `MAX_STUDENTS` = `30`
6. Click **Deploy Web Service**. Render provides a free `https://<app-name>.onrender.com` URL with automatic SSL.

---

## Swapping Storage to Backblaze B2 (or Cloudflare R2 / AWS S3)

To use Backblaze B2 instead of Neon Object Storage:
1. Create public and private buckets in Backblaze B2 and generate an Application Key (S3-compatible).
2. Update your environment variables:
   ```env
   S3_ENDPOINT=https://s3.<region>.backblazeb2.com
   S3_REGION=<region>
   S3_ACCESS_KEY_ID=<your-b2-key-id>
   S3_SECRET_ACCESS_KEY=<your-b2-application-key>
   ```
The application uses standard AWS S3 SDK v3 protocol, making it completely provider-agnostic.
