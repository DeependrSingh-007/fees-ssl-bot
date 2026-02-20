import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(__dirname));

// -------- Supabase config (supports your Next.js-style names too) ----------
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

const STATE_ID = process.env.STATE_ID || "main";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      })
    : null;

async function loadState() {
  if (!supabase) return { students: [], archived: [], settings: {} };

  const { data, error } = await supabase
    .from("app_state")
    .select("data")
    .eq("id", STATE_ID)
    .single();

  if (error) {
    // If row doesn't exist, create it
    await supabase.from("app_state").upsert({
      id: STATE_ID,
      data: { students: [], archived: [], settings: {} },
    });
    return { students: [], archived: [], settings: {} };
  }

  return data?.data || { students: [], archived: [], settings: {} };
}

async function saveState(nextState) {
  if (!supabase) return;
  await supabase.from("app_state").upsert({
    id: STATE_ID,
    data: nextState,
    updated_at: new Date().toISOString(),
  });
}

// ---------------- Health ----------------
app.get("/api/health", async (req, res) => {
  try {
    const ok = !!supabase;
    res.json({
      ok: true,
      supabase: ok ? "connected" : "not_configured",
      hasAnonKey: !!SUPABASE_ANON_KEY,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------- Data APIs (used by your HTML) ----------------
app.get("/api/data", async (req, res) => {
  try {
    const state = await loadState();
    res.json({ students: state.students || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/data", async (req, res) => {
  try {
    const state = await loadState();
    const students = Array.isArray(req.body?.students)
      ? req.body.students
      : Array.isArray(req.body?.data?.students)
      ? req.body.data.students
      : state.students;

    state.students = students;
    await saveState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/archive", async (req, res) => {
  try {
    const state = await loadState();
    res.json({ archived: state.archived || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/archive", async (req, res) => {
  try {
    const state = await loadState();
    const archived = Array.isArray(req.body?.archived)
      ? req.body.archived
      : Array.isArray(req.body?.data?.archived)
      ? req.body.data.archived
      : state.archived;

    state.archived = archived;
    await saveState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/archive/student", async (req, res) => {
  try {
    const { studentId } = req.body || {};
    if (!studentId) return res.status(400).json({ error: "studentId required" });

    const state = await loadState();
    const idx = (state.students || []).findIndex((s) => s.id === studentId);
    if (idx === -1) return res.json({ ok: true }); // already moved

    const student = state.students[idx];
    state.students.splice(idx, 1);

    student.status = "Archived";
    student.archivedAt = new Date().toISOString();
    state.archived = state.archived || [];
    state.archived.unshift(student);

    await saveState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Image upload: for now we just return same base64 URL (simple + works)
app.post("/api/upload", async (req, res) => {
  try {
    const { image } = req.body || {};
    if (!image) return res.status(400).json({ error: "image required" });
    res.json({ url: image });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backup APIs
app.post("/api/backup", async (req, res) => {
  try {
    if (!supabase) return res.status(400).json({ error: "Supabase not configured" });

    const payload = req.body?.data;
    if (!payload) return res.status(400).json({ error: "data required" });

    const { data, error } = await supabase
      .from("backups")
      .insert({ data: payload })
      .select("id")
      .single();

    if (error) throw error;
    res.json({ backup: data.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/restore/:id", async (req, res) => {
  try {
    if (!supabase) return res.status(400).json({ error: "Supabase not configured" });

    const { id } = req.params;
    const { data, error } = await supabase
      .from("backups")
      .select("data")
      .eq("id", id)
      .single();

    if (error) throw error;
    res.json(data.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Settings (don’t store secrets here)
app.get("/api/settings", async (req, res) => {
  try {
    const state = await loadState();
    res.json(state.settings || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const state = await loadState();
    state.settings = { ...(state.settings || {}), ...(req.body || {}) };
    // Never store API keys from browser into DB
    if (state.settings.openaiKey) delete state.settings.openaiKey;
    if (state.settings.geminiKey) delete state.settings.geminiKey;
    await saveState(state);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------- Chat (OpenAI Responses API) ----------------
const TIMEOUT_MS = 20000;
function withTimeout(fn, ms = TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(t));
}

async function callOpenAI({ message, history }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-5";
  const input = [
    {
      role: "developer",
      content:
        "You are SSL Bot for Savitri Success Library. Answer in simple Hinglish. Be concise and helpful.",
    },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
  ];

  return withTimeout(async (signal) => {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input, temperature: 0.4 }),
    });

    if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
    const data = await r.json();

    // output_text is the easiest way to read text responses
    return data?.output_text || "";
  });
}

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body || {};
    if (!message) return res.status(400).json({ error: "message is required" });

    const reply = await callOpenAI({ message, history });
    res.json({ reply, provider: "openai" });
  } catch (e) {
    res.status(500).json({ error: e.message || "Chat failed" });
  }
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
