// transcriber-ai-service/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/* ============================================================================
   HEALTH CHECK
============================================================================ */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Clean YouTube Transcriber (Deepgram URL Fetch)",
  });
});

/* ============================================================================
   MAIN TRANSCRIBE ENDPOINT (NO yt-dlp, NO ffmpeg, NO temp files)
============================================================================ */
app.post("/transcribe", async (req, res) => {
  const { youtube_url } = req.body || {};

  console.log("🔥 [SERVICE HIT] youtube_url:", youtube_url);

  if (!youtube_url) {
    return res.status(400).json({
      success: false,
      message: "youtube_url is required",
    });
  }

  try {
    console.log("🎧 [DEEPGRAM] Direct fetch started…");

    // Deepgram handles downloading + audio extraction + transcription
    const dgRes = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: youtube_url }),
      }
    );

    console.log("🟠 [DEEPGRAM] HTTP:", dgRes.status);

    if (!dgRes.ok) {
      const errText = await dgRes.text();
      console.error("❌ [DEEPGRAM ERROR]:", errText);

      return res.status(500).json({
        success: false,
        message: "Deepgram failed",
        detail: errText,
      });
    }

    const data = await dgRes.json();
    const transcript =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    console.log("✅ [TRANSCRIBE] Transcript length:", transcript.length);

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

/* ============================================================================
   START SERVER
============================================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Clean Transcriber listening on port ${PORT}`);
});
