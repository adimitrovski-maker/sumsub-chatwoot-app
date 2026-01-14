const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow the Chatwoot app (running in the browser) to call this backend
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
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
