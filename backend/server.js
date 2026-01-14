const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow the Chatwoot app (running in the browser) to call this backend
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

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

app.get("/", (req, res) => {
  res.send("Backend is running");
});

app.get("/health", (req, res) => {
  res.status(200).send("Backend healthy");
});

// NEW: test endpoint your Chatwoot app will call
app.get("/api/ping", (req, res) => {
  res.json({ ok: true, message: "pong" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
