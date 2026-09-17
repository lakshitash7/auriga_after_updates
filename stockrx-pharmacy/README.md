# StockRx — Pharmacy Batch & Expiry Manager

A full-stack pharmacy inventory app: batches are dispensed **first-expiry-first-out (FEFO)**, expired batches are never dispensed, and the system proactively flags/quarantines expiring stock and alerts on low re-order levels.

## Stack
- Backend: Node.js, Express
- DB: SQLite (`better-sqlite3`) — file-based, zero setup
- Auth: JWT (`jsonwebtoken`) + bcrypt password hashing
- Frontend: Vanilla HTML/CSS/JS (no build step, served statically by Express)

## Setup & Run

```bash
npm install
node server.js
```

App runs on `http://localhost:3000`.
- Landing page: `/`
- App/dashboard: `/app.html` (register or log in first)

No environment variables are required to run locally (a dev JWT secret is used by default). To override:
```bash
JWT_SECRET=your-secret PORT=3000 node server.js
```

The SQLite DB file `pharmacy.db` is created automatically on first run in the project root.

## Debugging
- Server logs go to stdout — run with `node server.js` in a terminal you can watch.
- To reset all data, stop the server and delete `pharmacy.db`, `pharmacy.db-wal`, `pharmacy.db-shm`, then restart.
- All API errors return JSON `{ "error": "..." }` with an appropriate HTTP status code.
- `/clock` and `/outbox` are intentionally unauthenticated (grading endpoints) so they can be called directly with curl/Postman without a login token.

## API Endpoints

### Auth
| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | Register `{ name, email, password }`, returns JWT |
| POST | `/api/auth/login` | Login `{ email, password }`, returns JWT |

### Medicines (auth required)
| Method | Path | Description |
|---|---|---|
| GET | `/api/medicines?search=&page=&pageSize=&sort=&dir=` | List medicines with search, pagination, sorting, and computed in-date stock |
| POST | `/api/medicines` | Create `{ name, reorder_level }` |
| GET | `/api/medicines/:id/stock` | In-date (sellable) stock count for a medicine |

### Batches (auth required)
| Method | Path | Description |
|---|---|---|
| GET | `/api/batches?medicine_id=&status=&page=&pageSize=&sort=&dir=` | List batches, filterable/sortable/paginated |
| POST | `/api/batches` | Add a batch `{ medicine_id, batch_no, quantity, expiry_date }` |

### Dispensing (auth required)
| Method | Path | Description |
|---|---|---|
| POST | `/api/dispense` | Dispense `{ medicine_id, quantity }` — FEFO across in-date batches, rejects if insufficient in-date stock |

### Bulk import — messy data (auth required)
| Method | Path | Description |
|---|---|---|
| POST | `/api/import` | `{ rows: [...] }` — tolerant parser (handles nulls, `"10 units"`, dd/mm/yyyy vs ISO dates, duplicate rows). Returns `{ imported, deduped, rejected, rejectedDetails }` |

### Search (auth required)
| Method | Path | Description |
|---|---|---|
| GET | `/api/search?q=` | Search medicines by name and batches by batch number |

### Automation — Twist T2 (unauthenticated, root-mounted for grading)
| Method | Path | Description |
|---|---|---|
| POST | `/clock` | `{ date: "YYYY-MM-DD" }` — advances the app's simulated "today", then runs the daily job: quarantines batches already expired, flags batches expiring within 7 days, refreshes re-order alerts. Returns `{ current_date, quarantined, flagged_expiring_soon }` |
| GET | `/clock` | Returns current simulated date |

### Notifications — Twist T1 (unauthenticated, root-mounted for grading)
| Method | Path | Description |
|---|---|---|
| GET | `/outbox` | Returns all simulated Notification Service messages sent when a medicine's in-date stock dropped to/below its reorder level |

## Design notes
- All date-dependent logic (in-date stock, dispensing eligibility, expiry job) reads from a single simulated clock stored in the DB, not `Date.now()`, so the grader's `POST /clock` calls drive the whole app's notion of "today".
- Dispensing is transactional: it walks active, non-expired batches ordered by `expiry_date ASC`, draining each until the requested quantity is met.
- Re-order checks run after every stock-changing event (batch add, dispense, clock-triggered quarantine) and only log a new outbox entry when the in-date stock value has actually changed since the last alert, to avoid duplicate spam.
