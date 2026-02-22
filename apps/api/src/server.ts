import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "API running 🚀" });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

const DATA_DIR = path.join(process.cwd(), "data", "brookline", "processed");

app.get("/api/brookline/candidates", (_req, res) => {
  const p = path.join(DATA_DIR, "candidates_buffer.geojson");
  res.type("json").send(fs.readFileSync(p, "utf-8"));
});

app.get("/api/brookline/metrics", (_req, res) => {
  const p = path.join(DATA_DIR, "candidate_metrics.json");
  res.type("json").send(fs.readFileSync(p, "utf-8"));
});

app.get("/api/brookline/flags", (_req, res) => {
  const p = path.join(DATA_DIR, "flagged_points.geojson");
  if (!fs.existsSync(p)) return res.json({ type: "FeatureCollection", features: [] });
  res.type("json").send(fs.readFileSync(p, "utf-8"));
});