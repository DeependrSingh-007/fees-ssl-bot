import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import https from "https";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// UTF-8 headers so ₹ / emojis render correctly
app.use((req, res, next) => {
  if (req.path.endsWith(".html")) res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.path.endsWith(".css")) res.setHeader("Content-Type", "text/css; charset=utf-8");
  if (req.path.endsWith(".js")) res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Open on root URL
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "library_fees.html"));
});

// Serve static files
app.use(express.static(__dirname));

// File paths
const DATA_FILE = path.join(__dirname, "data.json");
const ARCHIVE_FILE = path.join(__dirname, "archive.json");
const BACKUPS_DIR = path.join(__dirname, "backups");

// Ensure backups directory exists
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Helpers
function readJSONFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw || JSON.stringify(fallback));
  } catch (e) {
    console.error(`Error reading ${filePath}:`, e.message);
    return fallback;
  }
}
function writeJSONFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.error(`Error writing ${filePath}:`, e.message);
    return false;
  }
}
function createBackup() {
  try {
    const data = readJSONFile(DATA_FILE, { students: [] });
    const archive = readJSONFile(ARCHIVE_FILE, { archived: [] });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupFile = path.join(BACKUPS_DIR, `backup_${timestamp}.json`);
    const backupData = { timestamp: new Date().toISOString(), data, archive };
    writeJSONFile(backupFile, backupData);
    console.log(`✅ Backup created: ${backupFile}`);
    return backupFile;
  } catch (e) {
    console.error("Backup failed:", e.message);
    return null;
  }
}

// ========== DATA ENDPOINTS ==========
app.get("/api/data", (req, res) => res.json(readJSONFile(DATA_FILE, { students: [] })));
app.post("/api/data", (req, res) => {
  const success = writeJSONFile(DATA_FILE, req.body || { students: [] });
  if (success) return res.json({ ok: true });
  return res.status(500).json({ error: "Failed to save data" });
});

app.get("/api/archive", (req, res) => res.json(readJSONFile(ARCHIVE_FILE, { archived: [] })));
app.post("/api/archive", (req, res) => {
  const success = writeJSONFile(ARCHIVE_FILE, req.body || { archived: [] });
  if (success) return res.json({ ok: true });
  return res.status(500).json({ error: "Failed to save archive" });
});

// Backup endpoint
app.post("/api/backup", (req, res) => {
  const backupFile = createBackup();
  if (backupFile) return res.json({ ok: true, backupFile });
  return res.status(500).json({ error: "Backup failed" });
});

// ========== SETTINGS (UI compatibility) ==========
/**
 * Your UI has "Settings" where it saves apiKey.
 * For security on live server, we DO NOT use browser-saved keys.
 * We keep these endpoints only so UI doesn't break.
 */
app.get("/api/settings", (req, res) => res.json({ ok: true }));
app.post("/api/settings", (req, res) => res.json({ ok: true }));

// ========== AI: OpenAI primary + Gemini fallback ==========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

function buildMessages(message, history) {
  const sys = {
    role: "system",
    content:
      "You are SSL BOT for Savitri Success Library. Answer in simple Hinglish. Help students for any subject/exam. Be polite, concise, and accurate. If asked for study material, share official/free resources links when possible."
  };

  const hist = Array.isArray(history) ? history : [];
  const mapped = hist
    .map((h) => {
      if (!h) return null;
      if (h.role === "user") return { role: "user", content: String(h.text || "") };
      if (h.role === "model" || h.role === "assistant") return { role: "assistant", content: String(h.text || "") };
      return null;
    })
    .filter(Boolean);

  return [sys, ...mapped, { role: "user", content: String(message || "") }];
}

async function callOpenAI(message, history) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set on server");
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: buildMessages(message, history)
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI error HTTP ${r.status}`);
  return (data?.choices?.[0]?.message?.content || "").trim();
}

function callGemini(message, history) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set on server");
  // Gemini wants contents array with role user/model
  const contents = (Array.isArray(history) ? history : []).map((msg) => ({
    role: msg.role === "user" ? "user" : "model",
    parts: [{ text: String(msg.text || "") }]
  }));
  contents.push({ role: "user", parts: [{ text: String(message || "") }] });

  const postData = JSON.stringify({
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
  });

  const models = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-2.0-flash-lite-001"];

  const tryModel = (model) =>
    new Promise((resolve, reject) => {
      const options = {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(postData) }
      };
      const req = https.request(options, (resp) => {
        let body = "";
        resp.on("data", (c) => (body += c));
        resp.on("end", () => {
          try {
            const json = JSON.parse(body);
            if (resp.statusCode === 200) resolve({ json, model });
            else reject({ status: resp.statusCode, json, model });
          } catch {
            reject({ status: 500, json: { error: "Parse Error" }, model });
          }
        });
      });
      req.on("error", (e) => reject({ status: 500, json: { error: e.message }, model }));
      req.write(postData);
      req.end();
    });

  return (async () => {
    let lastErr = null;
    for (const m of models) {
      try {
        const out = await tryModel(m);
        const txt = out.json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (txt.trim()) return { text: txt.trim(), model: out.model };
        lastErr = new Error(`Gemini empty response (${m})`);
      } catch (e) {
        lastErr = new Error(e?.json?.error?.message || e?.json?.error || `Gemini failed (${e.model})`);
      }
    }
    throw lastErr || new Error("Gemini failed");
  })();
}

app.post("/api/chat", async (req, res) => {
  try {
    const { history, message } = req.body || {};
    if (!message) return res.status(400).json({ error: "message is required" });

    // 1) OpenAI primary
    try {
      const text = await callOpenAI(message, history);
      return res.json({ text, provider: "openai" });
    } catch (e1) {
      // 2) Gemini fallback (optional)
      if (GEMINI_API_KEY) {
        const out = await callGemini(message, history);
        return res.json({ text: out.text, provider: "gemini", modelUsed: out.model });
      }
      throw e1;
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || "Chat failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}/library_fees.html`);
});
