// backend/server.js

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CORS (for Chatwoot iframe -> backend calls) ----------
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept"
  );
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// ---------- DB setup ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres commonly needs SSL; this is the typical setting that works there
  ssl: { rejectUnauthorized: false },
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

// Helpers to store/find applicant mappings
async function getApplicantFromDb(externalUserId) {
  const q = `
    SELECT external_user_id, brand, inbox_id, applicant_id, created_at, updated_at
    FROM kyc_applicants
    WHERE external_user_id = $1
    LIMIT 1
  `;
  const r = await pool.query(q, [externalUserId]);
  return r.rows[0] || null;
}

async function upsertApplicantInDb({ externalUserId, brand, inboxId, applicantId }) {
  const q = `
    INSERT INTO kyc_applicants (external_user_id, brand, inbox_id, applicant_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (external_user_id)
    DO UPDATE SET
      brand = EXCLUDED.brand,
      inbox_id = EXCLUDED.inbox_id,
      applicant_id = EXCLUDED.applicant_id,
      updated_at = NOW()
    RETURNING external_user_id, brand, inbox_id, applicant_id, created_at, updated_at;
  `;
  const r = await pool.query(q, [externalUserId, brand, inboxId, applicantId]);
  return r.rows[0];
}

// ---------- Sumsub helper (signed requests) ----------
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
    // non-JSON response
  }

  if (!res.ok) {
    const msg = json ? JSON.stringify(json) : text;
    throw new Error(`Sumsub error ${res.status}: ${msg}`);
  }

  return json ?? text;
}

// ---------- Basic routes ----------
app.get("/", (req, res) => res.send("Backend is running"));
app.get("/health", (req, res) => res.status(200).send("Backend healthy"));
app.get("/api/ping", (req, res) => res.json({ ok: true, message: "pong" }));

app.get("/api/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: "ok", now: result.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: "error", error: String(e?.message || e) });
  }
});

// ---------- Sumsub: dynamic verification levels ----------
app.get("/api/sumsub/levels", async (req, res) => {
  try {
    const data = await sumsubFetch({
      method: "GET",
      pathWithQuery: "/resources/applicants/-/levels",
    });

    // Sumsub sometimes returns { items: [...] } or { list: { items: [...] } }
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

// ---------- KYC: create applicant (and store mapping in DB) ----------
app.post("/api/kyc/create-applicant", async (req, res) => {
  try {
    const { externalUserId, brand, inboxId, levelName, firstName, lastName, middleName } = req.body || {};

    if (!externalUserId || !brand || !inboxId || !levelName) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: externalUserId, brand, inboxId, levelName",
      });
    }
    if (!firstName || !lastName) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: firstName and lastName",
      });
    }

    // 1) Avoid duplicates: if we already have an applicant in DB, reuse it
    const existing = await getApplicantFromDb(externalUserId);
    if (existing?.applicant_id) {
      return res.json({
        ok: true,
        reused: true,
        externalUserId,
        applicantId: existing.applicant_id,
        db: existing,
      });
    }

    // 2) Create applicant in Sumsub
    const body = {
      externalUserId,
      levelName,
      fixedInfo: {
        firstName,
        lastName,
      },
    };

    if (middleName && String(middleName).trim()) {
      body.fixedInfo.middleName = String(middleName).trim();
    }

    const created = await sumsubFetch({
      method: "POST",
      pathWithQuery: "/resources/applicants?levelName=" + encodeURIComponent(levelName),
      bodyObj: body,
    });

    // Sumsub returns applicant data; applicantId is typically in `id`
    const applicantId = created?.id || created?.applicantId;
    if (!applicantId) {
      return res.status(500).json({
        ok: false,
        error: "Created applicant but could not find applicantId in Sumsub response.",
      });
    }

    // 3) Store mapping in DB
    const dbRow = await upsertApplicantInDb({
      externalUserId,
      brand,
      inboxId: Number(inboxId),
      applicantId,
    });

    res.json({
      ok: true,
      reused: false,
      externalUserId,
      applicantId,
      db: dbRow,
      raw: created,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- KYC: generate hosted WebSDK link (do NOT store the link) ----------
app.post("/api/kyc/generate-websdk-link", async (req, res) => {
  try {
    const { externalUserId, levelName, email } = req.body || {};

    if (!externalUserId || !levelName) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: externalUserId, levelName",
      });
    }

    // Ensure applicant exists (we store applicantId mapping by externalUserId)
    const existing = await getApplicantFromDb(externalUserId);
    if (!existing?.applicant_id) {
      return res.status(400).json({
        ok: false,
        error: "No applicant found in DB for this externalUserId. Create applicant first.",
      });
    }

    // Generate a hosted WebSDK link
    // Sumsub endpoint: POST /resources/sdkIntegrations/levels/-/websdkLink
    const body = {
      levelName,
      userId: externalUserId,
      ttlInSecs: 1800, // 30 minutes
    };

    // Optional: pass email as an identifier (we do not store it ourselves)
    if (email && String(email).trim()) {
      body.applicantIdentifiers = { email: String(email).trim() };
    }

    const data = await sumsubFetch({
      method: "POST",
      pathWithQuery: "/resources/sdkIntegrations/levels/-/websdkLink",
      bodyObj: body,
    });

    const url = data?.url;
    if (!url) {
      return res.status(500).json({
        ok: false,
        error: "Sumsub response did not include a url field.",
      });
    }

    // IMPORTANT: Do not store the url anywhere (per your requirement)
    return res.json({
      ok: true,
      url,
      ttlInSecs: body.ttlInSecs,
      externalUserId,
      levelName,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Start server ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
