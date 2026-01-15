const express = require("express");
const crypto = require("crypto");
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

// ---- Sumsub helper (signed requests) ----
const SUMSUB_BASE_URL = process.env.SUMSUB_BASE_URL || "https://api.sumsub.com";
const SUMSUB_APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY;

function signSumsubRequest({ method, pathWithQuery, bodyString = "" }) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const stringToSign = ts + method.toUpperCase() + pathWithQuery + bodyString;

  const signature = crypto
    .createHmac("sha256", SUMSUB_SECRET_KEY)
    .update(stringToSign)
    .digest("hex");

  return { ts, signature };
}

async function sumsubFetch({ method, pathWithQuery, bodyObj = null }) {
  if (!SUMSUB_APP_TOKEN || !SUMSUB_SECRET_KEY) {
    throw new Error("Missing SUMSUB_APP_TOKEN or SUMSUB_SECRET_KEY in environment variables.");
  }

  const bodyString = bodyObj ? JSON.stringify(bodyObj) : "";
  const { ts, signature } = signSumsubRequest({ method, pathWithQuery, bodyString });

  const url = `${SUMSUB_BASE_URL}${pathWithQuery}`;

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-App-Token": SUMSUB_APP_TOKEN,
      "X-App-Access-Ts": ts,
      "X-App-Access-Sig": signature,
    },
    body: bodyObj ? bodyString : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    // not JSON
  }

  if (!res.ok) {
    const msg = json ? JSON.stringify(json) : text;
    throw new Error(`Sumsub error ${res.status}: ${msg}`);
  }

  return json ?? text;
}

// NEW: Fetch verification levels (dynamic dropdown)
app.get("/api/sumsub/levels", async (req, res) => {
  try {
    // This endpoint returns a structured list of levels
    const data = await sumsubFetch({
      method: "GET",
      pathWithQuery: "/resources/applicants/-/levels",
    });

    // Return both the raw response and a simplified list of level names
    const items =
  (Array.isArray(data?.items) && data.items) ||
  (Array.isArray(data?.list?.items) && data.list.items) ||
  [];

const levelNames = items
  .map((x) => x?.name || x?.id || x?.levelName)
  .filter(Boolean);

    res.json({ ok: true, levelNames, raw: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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
