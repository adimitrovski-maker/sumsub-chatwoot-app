const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS for browser calls (Chatwoot iframe)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// ---- DB setup ----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres works with this setting
});

async function ensureTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS kyc_applicants (
      id SERIAL PRIMARY KEY,
      external_user_id TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL,
      inbox_id INTEGER NOT NULL,
      applicant_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;
  await pool.query(sql);
  console.log("DB ready: ensured table kyc_applicants");
}

// Run once on startup
ensureTables().catch((err) => {
  console.error("Failed to init DB:", err);
});

// ---- Basic routes ----
app.get("/", (req, res) => res.send("Backend is running"));
app.get("/health", (req, res) => res.status(200).send("Backend healthy"));
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

// NEW: DB check endpoint
app.get("/api/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: "ok", now: result.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: "error", error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
