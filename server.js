// transcriber-service/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const { Innertube } = require("youtubei");


const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 5051;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

/* ========================================================================
   Extract YouTube Video ID
======================================================================== */
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

/* ========================================================================
   1) Try YOUTUBEI to get REAL SIGNED AUDIO STREAM
======================================================================== */
async function getAudioViaYouTubei(videoId) {
  try {
    console.log("🔵 [YT-I] Initializing YouTubei…");
    const yt = await Innertube.create();

    console.log("🔵 [YT-I] Fetching video info…");
    const info = await yt.getInfo(videoId);

    const audioFormats = info?.streaming_data?.adaptive_formats?.filter(
      (f) => f.mime_type.startsWith("audio/")
    );

    if (!audioFormats || audioFormats.length === 0) {
      console.log("⚠️ [YT-I] No audio formats available");
      return null;
    }

    // pick highest bitrate audio
    const bestAudio = audioFormats.sort((a, b) => b.bitrate - a.bitrate)[0];

    console.log("🎉 [YT-I] SUCCESS — Audio URL fetched");
    return bestAudio.url;
  } catch (err) {
    console.error("❌ [YT-I ERROR]:", err.message);
    return null;
  }
}

/* ========================================================================
   2) PIPED FALLBACK SYSTEM
======================================================================== */
async function getAudioViaPiped(videoId) {
  const pipedInstances = [
    "https://piped.video",
    "https://pipedapi.kavin.rocks",
    "https://piped.privacydev.net",
    "https://piped.lunar.icu",
    "https://piped.privacy.com.de",
    "https://piped.us.projectsegfau.lt",
    "https://pipedapi.based.store",
  ];

  for (const base of pipedInstances) {
    const url = `${base}/streams/${videoId}`;
    console.log("🔁 [PIPED] Trying:", url);

    try {
      const r = await fetch(url, { timeout: 10000 });
      const text = await r.text();

      if (!r.ok) continue;

      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        continue;
      }

      const audioStreams = json?.audioStreams;
      if (audioStreams?.length > 0) {
        console.log("🎉 [PIPED] SUCCESS from:", base);
        return audioStreams.sort((a, b) => b.bitrate - a.bitrate)[0].url;
      }
    } catch (err) {
      console.log(`⚠️ [PIPED FAIL] ${base}:`, err.message);
    }
  }

  return null;
}

/* ========================================================================
   3) MAIN ENDPOINT
======================================================================== */
app.post("/transcribe", async (req, res) => {
  const { youtube_url } = req.body;
  console.log("🔥 [SERVICE HIT]:", youtube_url);

  if (!youtube_url)
    return res.status(400).json({ success: false, message: "youtube_url required" });

  const videoId = extractVideoId(youtube_url);
  if (!videoId)
    return res.status(400).json({ success: false, message: "Invalid YouTube URL" });

  try {
    /* ---------------------------------------------------------------
       STEP A → Try YouTubei (BEST METHOD)
    ---------------------------------------------------------------- */
    console.log("🔵 Trying YOUTUBEI…");
    let audioUrl = await getAudioViaYouTubei(videoId);

    /* ---------------------------------------------------------------
       STEP B → If YouTubei fails, try Piped fallback
    ---------------------------------------------------------------- */
    if (!audioUrl) {
      console.log("🟡 YouTubei failed → Trying PIPED fallback");
      audioUrl = await getAudioViaPiped(videoId);
    }

    /* ---------------------------------------------------------------
       STEP C → If all fail → throw
    ---------------------------------------------------------------- */
    if (!audioUrl) {
      return res.status(500).json({
        success: false,
        message: "Failed to fetch audio stream from YouTube or Piped.",
      });
    }

    console.log("🎧 FINAL AUDIO URL:", audioUrl);

    /* ---------------------------------------------------------------
       STEP D → Deepgram transcription
    ---------------------------------------------------------------- */
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

    const dgText = await dgRes.text();
    console.log("🟠 [DEEPGRAM] Status:", dgRes.status);

    if (!dgRes.ok) {
      console.error("❌ [DEEPGRAM ERROR]:", dgText);
      return res.status(500).json({
        success: false,
        message: "Deepgram transcription failed",
        detail: dgText,
      });
    }

    const dgJson = JSON.parse(dgText);
    const transcript =
      dgJson?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    console.log("✅ [TRANSCRIPT LENGTH]:", transcript.length);

    return res.json({ success: true, transcript, chars: transcript.length });

  } catch (err) {
    console.error("❌ [FATAL ERROR]:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  }
});

/* ========================================================================
   HEALTH CHECK
======================================================================== */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "YouTubei + Piped → Deepgram Transcriber" });
});

/* ========================================================================
   START SERVER
======================================================================== */
app.listen(PORT, () => {
  console.log(`🚀 Transcriber service running on port ${PORT}`);
});
