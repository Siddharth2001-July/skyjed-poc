# Skyjed × Nutrient: Communications Governance POC

A working reference implementation of an in-platform review and approval workflow for regulated, customer-facing documents. A communication is **uploaded once**, drafted, reviewed by parallel approvers, **published as a clean copy to a write-once vault** by the back end, and **re-reviewed in the next cycle**, starting from the last approved version. Nobody downloads, redlines offline and re-uploads.

- **Word** documents open in **Nutrient Document Authoring**: paginated, Word-like editing with tracked changes and comments.
- **PDF** documents open in **Nutrient Web SDK**, backed by **Nutrient Document Engine**: markup, comments, text editing and real-time collaboration.
- The platform picks the editor from the file type, and sets each person's permissions from their role and the workflow stage.

The stack mirrors Skyjed's: a **React single-page app**, a back end (Node.js here, standing in for .NET services), and **Document Engine in Docker**.

> This is a proof of concept for evaluation. It has no real sign-in (you switch between demo users), stores data in JSON files, and uses a local folder in place of the S3 vault. It shows how the Nutrient components wire into the workflow; it isn't production code.

---

## Quick start

### 1. Prerequisites

| | Version | Check with |
|---|---|---|
| Node.js | **22 or 24** (an `.nvmrc` is included) | `node -v` |
| Docker Desktop (or another Docker runtime) | any recent version, running | `docker info` |
| Free ports | `5173` (app), `3001` (API), `5001` (Document Engine) | |
| Disk | about 2 GB for the Document Engine and PostgreSQL images | |

### 2. Get the code and install

```bash
git clone https://github.com/Siddharth2001-July/skyjed-poc.git
cd skyjed-poc
npm install
```

### 3. Configure

```bash
npm run setup
```

This creates `.env` from `.env.example`, generates the key pair the back end uses to sign viewer tokens (`keys/`), and writes `docker-compose.yml`.

Then open `.env` and paste the licence keys from your Nutrient contact:

| Variable | What it's for | Without it |
|---|---|---|
| `DOCUMENT_ENGINE_ACTIVATION_KEY` | Document Engine (PDF storage, collaboration, export) | Required |
| `WEB_SDK_LICENSE_KEY` | PDF viewer in the browser | Viewer runs in trial mode |
| `DOCAUTH_LICENSE_KEY` | Word editor in the browser | Editor runs in evaluation mode |
| `DOCAUTH_NODE_LICENSE_KEY` | Document Authoring on the server (DOCX import, the clean publish, comment extraction). The key must include the **Node.js Server-Side Runtime** feature. | Runs in evaluation mode: **1 hour per server start**, and exported PDFs carry a watermark |

Browser keys are tied to domains. `localhost` works for local evaluation; any other hostname needs keys issued for it.

### 4. Add documents (optional)

Copy any Word (`.docx`) or PDF files into `samples/`. They're loaded into the register on first start. You can also upload files from the app later. See [`samples/README.md`](samples/README.md) to set titles and risk ratings.

### 5. Start Document Engine

```bash
npm run engine
```

The first run downloads about 1.5 GB of images. Check that it's ready:

```bash
curl http://localhost:5001/healthcheck
```

It should print `OK`. The Document Engine dashboard is at http://localhost:5001/dashboard (user `dashboard`, password `dashboard-password`).

### 6. Start the app

```bash
npm run dev
```

Open **http://localhost:5173/?as=alex**. To see collaboration, open a second window as an approver, for example `?as=priya` and `?as=sam` side by side.

### Reset

```bash
npm run reset
```

This clears the register, working copies and vault. Then restart `npm run dev`, and the register is reloaded from `samples/`.

---

## Demo users

There's no sign-in. Switch user with **Signed in as** in the top bar, or with `?as=` in the URL.

| User | `?as=` | Draft | Approval | Published |
|---|---|---|---|---|
| Alex Morgan, asset owner | `alex` | Edit / annotate / edit PDF text | View only | View, **Start next review** |
| Priya Shah, Compliance approver | `priya` | View only | Review / mark up, **Approve** / **Request changes** | View only |
| Sam Taylor, Legal & Risk approver | `sam` | View only | Review / mark up, **Approve** / **Request changes** | View only |
| Jordan Lee, business unit viewer | `jordan` | View only | View only | View only |

## A 10-minute walkthrough

1. **Register.** As `alex`, upload a `.docx` and a `.pdf`. Word goes to Document Authoring and PDF goes to Document Engine automatically. **New from blank** starts a Word document from scratch.
2. **Draft a Word document.** Open it and click **Start editing**. Changes autosave about a second after you stop typing, and each save is a new version (see **Versions & vault**). In a second window as `priya`, you can see "Alex is editing. You're following live."
3. **Parallel approval in Word.** As `alex`, choose **Approvers review in Word** and **Submit for approval**. As `priya`, click **Start reviewing**: everything she types becomes a tracked change under her name. `sam` follows her changes live and can take the pen when she clicks **Done**.
4. **Parallel approval on a PDF.** Submit a PDF. `priya` and `sam` mark it up **at the same time**, and each sees the other's markup instantly. Each can change only their own markup, and `alex` can't annotate during approval.
5. **Automatic publish.** When the last approver clicks **Approve**, the server accepts all tracked changes, moves comments and markup into the **Approval summary**, and writes a clean DOCX/PDF to the vault. No browser is involved in that step.
6. **Next review cycle.** As `alex`, click **Start next review**. The new working copy starts from the approved clean version, and earlier cycles stay in **Versions & vault** and the **Audit trail**.
7. **PDF text editing.** As `alex`, in a draft PDF, use the Content Editor in the toolbar to change a date. The change carries into the published copy.

---

## What it covers

| # | Use case | Word | PDF | Where to look |
|---|---|---|---|---|
| 1 | Upload an existing file and open it in the platform | Imported to DocJSON by Document Authoring on the server, then opened in the editor | Uploaded to Document Engine, opened in Web SDK | `POST /api/assets` in `server/index.mjs` |
| 2 | Start a new document from blank | Blank Document Authoring document | n/a | **New from blank** |
| 3 | Edit content, one user | `edit` mode | Web SDK Content Editor (owner, draft stage) | `WordEditor.jsx`, `PdfViewer.jsx` |
| 4 | Edit content, several users | **One writer at a time (the "pen"); everyone else follows live.** Stale saves are rejected, never merged. | Content Editor: one editor at a time, others are prompted to reload | `PUT /api/assets/:id/word`, `POST /api/assets/:id/pen` |
| 5 | Review with tracked changes and comments | `review` mode + `reviewer` role: edits become tracked changes under the reviewer's name | Markup annotations + comments | |
| 6 | Several reviewers at once (parallel approval) | Word review mode with the pen and live follow, **or** approvers mark up a PDF snapshot at the same time | **Real time** through Instant Collaboration; each approver can change only their own markup | The owner picks the route when submitting a Word document |
| 7 | Accept / reject, by a user and automatically at final approval | The owner accepts or rejects while drafting; **the server accepts all at final approval** | Markup is removed from the clean copy and kept in a marked-up record | `publishClean()` in `server/docauth.mjs` |
| 8 | Save the working copy between sessions | Autosave; every save is an immutable DocJSON version | Document Engine saves markup and text edits as they happen | **Versions & vault** tab |
| 9 | Publish a clean copy from the back end, no browser | Document Authoring for Node.js: accept all, remove comments, export DOCX + PDF/A | Document Engine REST: copy, delete annotations, export | `finalise()` in `server/index.mjs` |
| 10 | Extract comments for the approval record | Comment threads, replies and tracked changes read through the Document Authoring API | Instant JSON from Document Engine: markup, comments, authors, timestamps | **Approval summary** tab |
| 11 | Permissions set by the platform | Platform role → editor mode (`edit`/`review`/`view`) + participant role (`owner`/`reviewer`/`reader`). The built-in mode switcher is removed from the toolbar. | Platform role → **JWT** with `collaboration_permissions` | `capability()` in `server/index.mjs`, `viewerToken()` in `server/engine.mjs` |
| | Review cycles | **Start next review** creates cycle N+1 from the approved clean DocJSON | The cycle N clean PDF becomes a new document for cycle N+1 | `POST /api/assets/:id/next-cycle` |
| | Audit trail | Every upload, pen hand-over, version, submission, decision, publish and new cycle is logged with user and time | Same | **Audit trail** tab |

```
 Upload once ──► DRAFT ──submit──► APPROVAL (parallel) ──all approve──► PUBLISHED ──next review──► DRAFT (cycle N+1)
  .docx → DocJSON   owner edits      approvers suggest / mark up    platform: accept all,        starts from the last
  .pdf  → Doc Engine autosave        "request changes" → DRAFT      comments → approval summary, approved clean version
                                                                     clean DOCX/PDF → vault (WORM)
```

## Architecture in production

```
 Browser (React SPA)                        Back end (.NET on ECS)                     Customer's isolated AWS account
 ┌──────────────────────────┐   REST    ┌───────────────────────────────┐          ┌──────────────────────────────┐
 │ Document Authoring editor │◄────────►│ Workflow, roles, locks, audit │  REST +  │ Document Engine (ECS task)    │
 │  (Word, DocJSON)          │          │ JWT issuing for Web SDK       │  token   │  ├─ PostgreSQL (RDS)           │
 │ Web SDK viewer            │◄── JWT ──┤ S3 vault (Object Lock / WORM) │─────────►│  └─ asset storage (S3)         │
 │  (PDF, Instant sync) ─────┼──────────┼───────────────────────────────┼─websocket►                              │
 └──────────────────────────┘          │ Node.js service: Document      │          └──────────────────────────────┘
                                       │ Authoring (publish, extract)   │
                                       └───────────────────────────────┘
```

- **Documents stay in the customer's AWS account.** Document Engine and the Node.js Document Authoring service run inside it. Web SDK assets are served from your own origin (`npm install` copies them into `client/public`), and Document Authoring assets can be self-hosted the same way.
- **.NET integration.** Document Engine is plain REST, so .NET calls it directly. The Document Authoring calls in `server/docauth.mjs` become a small Node.js service the .NET back end calls over HTTP.
- **One domain and AWS account per customer.** Deploy one Document Engine per AWS account. Browser licence keys are bound to domains.
- **Vault.** Here it's a local folder whose files are written once and then made read-only. In AWS, use an S3 bucket with Object Lock (compliance mode).

## Known limits

- **Document Authoring doesn't support real-time co-editing of Word documents today.** This POC uses one writer at a time with live follow and protection against stale saves. Don't merge DocJSON from two simultaneous writers: one would overwrite the other. Where approvers must work at the same moment, use the **PDF snapshot** route. Their markup is recorded and shown to the owner, but it's annotation, not Word tracked changes.
- **PDF redlining is markup, not tracked changes.** Accepting a PDF markup doesn't change the text; the owner applies agreed wording with the Content Editor.
- **PDF text editing** applies directly (no tracked changes). Text reflows within its text block, not across columns or pages. If a PDF embeds only a subset of a font, typing characters missing from that subset can cause font substitution.
- **DOCX import and export are best effort.** Keep DocJSON as the working format, and export DOCX/PDF only to publish.

## Troubleshooting

| Symptom | Fix |
|---|---|
| API log: `Waiting for Document Engine at http://localhost:5001…` | Document Engine isn't up yet. Run `docker compose ps` and `docker compose logs document_engine`. The first start takes a minute after the image download. |
| `The license does not include the entitlement required to run Document Authoring in Node.js` | `DOCAUTH_NODE_LICENSE_KEY` doesn't include the Node.js Server-Side Runtime feature. Ask for a key that does, or leave it empty to use evaluation mode. |
| Uploads, publishing or summaries stop working after about an hour | Document Authoring on the server is in evaluation mode (no `DOCAUTH_NODE_LICENSE_KEY`). Restart `npm run dev`. |
| You changed `DOCUMENT_ENGINE_ACTIVATION_KEY` | Recreate the container: `docker compose up -d --force-recreate document_engine`. |
| PDF viewer error: `The mounting container has no width` | The window is too narrow. Widen it (about 1,000 px or more) and reload. |
| `EADDRINUSE` on 3001, 5001 or 5173 | Another process is using the port. Stop it, or change `API_PORT` in `.env` and the port in `vite.config.js` / `docker-compose.yml`. |
| `npm run engine` says there's no compose file | Run `npm run setup` first. |
| Start over completely | `npm run reset`, then `docker compose down -v` (also deletes Document Engine's database), then `npm run engine` and `npm run dev`. |

## Project layout

```
server/index.mjs        workflow API: assets, pen, autosave, submit/approve, publish, next cycle, vault
server/docauth.mjs      Document Authoring for Node.js: import, accept-all + strip comments + export, extraction
server/engine.mjs       Document Engine REST client, JWT + collaboration permissions, Instant JSON → summary
server/store.mjs        JSON persistence and demo users
client/src/             React app: register, workspace, WordEditor (Document Authoring), PdfViewer (Web SDK + Document Engine)
scripts/                setup, reset, Web SDK asset copy
samples/                your documents (git-ignored) + optional samples.json metadata
```

## Useful links

- Document Authoring guides: https://www.nutrient.io/guides/document-authoring/
- Web SDK guides: https://www.nutrient.io/guides/web/
- Document Engine guides: https://www.nutrient.io/guides/document-engine/
- Document Engine API reference: https://www.nutrient.io/api/reference/document-engine/upstream/
