// transcriber-service/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 5051;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/* ================================================================
   Utility: Extract YouTube video ID
================================================================ */
function extractVideoId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

/* ================================================================
   MAIN ENDPOINT
================================================================ */
app.post("/transcribe", async (req, res) => {
  const { youtube_url } = req.body || {};
  console.log("🔥 [SERVICE HIT] youtube_url:", youtube_url);

  if (!youtube_url) {
    return res.status(400).json({
      success: false,
      message: "youtube_url required",
    });
  }

  const videoId = extractVideoId(youtube_url);
  if (!videoId) {
    return res.status(400).json({
      success: false,
      message: "Invalid YouTube URL",
    });
  }

  try {
    /* ------------------------------------------------------------
       1) Get audio stream from Piped API
    ------------------------------------------------------------- */
   /* ------------------------------------------------------------------
   1) Get audio stream from MULTIPLE PIPED MIRRORS (fallback system)
------------------------------------------------------------------- */
const pipedInstances = [
  "https://piped.video",
  "https://pipedapi.kavin.rocks",
  "https://piped.privacydev.net",
  "https://piped.lunar.icu",
  "https://piped.privacy.com.de",
  "https://piped.us.projectsegfau.lt",
  "https://pipedapi.based.store"
];

let pipedJson = null;
let audioStreams = null;

for (const base of pipedInstances) {
  const url = `${base}/streams/${videoId}`;
  console.log("🔁 [PIPED] Trying instance:", url);

  try {
    const r = await fetch(url);
    const text = await r.text();

    if (!r.ok) {
      console.error("⚠️ [PIPED ERROR]", text.slice(0, 200));
      continue;
    }

    // try parse JSON
    pipedJson = JSON.parse(text);
    audioStreams = pipedJson?.audioStreams;

    if (audioStreams && audioStreams.length > 0) {
      console.log("🎉 [PIPED] SUCCESS from:", base);
      break;
    }
  } catch (err) {
    console.error(`⚠️ [PIPED FAILED @ ${base}]`, err.message);
  }
}

if (!audioStreams || audioStreams.length === 0) {
  return res.status(500).json({
    success: false,
    message: "No audio streams found from any Piped mirror",
  });
}

const audioUrl = audioStreams.sort((a, b) => b.bitrate - a.bitrate)[0].url;
console.log("🎧 [AUDIO URL]:", audioUrl);


    /* ------------------------------------------------------------
       2) Send audio URL to Deepgram for transcription
    ------------------------------------------------------------- */
    console.log("🎤 [DEEPGRAM] Sending audio URL…");

    const dgRes = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true&language=en",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: audioUrl }),
      }
    );

    console.log("🟠 [DEEPGRAM] HTTP:", dgRes.status);

    const dgText = await dgRes.text();

    if (!dgRes.ok) {
      console.error("❌ [DEEPGRAM ERROR RAW]:", dgText);
      return res.status(500).json({
        success: false,
        message: "Deepgram failed to process audio",
        detail: dgText,
      });
    }

    let dgJson = {};
    try {
      dgJson = JSON.parse(dgText);
    } catch (e) {
      console.error("❌ [JSON ERROR]:", e, dgText);
      return res.status(500).json({
        success: false,
        message: "Deepgram returned invalid JSON",
        detail: dgText,
      });
    }

    const transcript =
      dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    console.log("✅ [TRANSCRIBE] Transcript length:", transcript.length);

    /* ------------------------------------------------------------
       3) Return transcript
    ------------------------------------------------------------- */
    return res.json({
      success: true,
      transcript,
      chars: transcript.length,
    });

  } catch (err) {
    console.error("❌ [SERVICE ERROR]:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
});

/* ================================================================
   HEALTH CHECK
================================================================ */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "YouTube → Deepgram Transcriber" });
});

/* ================================================================
   START SERVER
================================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Transcriber service running on port ${PORT}`);
});
