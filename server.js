// transcriber-service/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5051;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// 60-second chunks (option B)
const CHUNK_SECONDS = 60;

/* ============================================================================
   Helper: run a command with logging
============================================================================ */
function runCommand(cmd, args, logPrefix) {
  return new Promise((resolve, reject) => {
    console.log(`${logPrefix} Spawning:`, cmd, args.join(" "));
    const child = spawn(cmd, args);

    let stderrData = "";
    let stdoutData = "";

    child.stdout.on("data", (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderrData += text;
      // Basic progress parsing for yt-dlp and ffmpeg
      if (/(\d{1,3}\.\d)% of/.test(text) || /time=\d{2}:\d{2}:\d{2}/.test(text)) {
        console.log(`${logPrefix} ${text.trim()}`);
      }
    });

    child.on("error", (err) => {
      console.error(`${logPrefix} SPAWN ERROR:`, err);
      reject(err);
    });

    child.on("close", (code) => {
      console.log(`${logPrefix} exited with code`, code);
      if (code !== 0) {
        console.error(`${logPrefix} ERROR:`, stderrData);
        return reject(new Error(`${cmd} failed`));
      }
      resolve({ stdout: stdoutData, stderr: stderrData });
    });
  });
}

/* ============================================================================
   1) Download YouTube audio into a temp file using yt-dlp
============================================================================ */
async function downloadAudioToFile(youtubeUrl) {
  const tmpDir = os.tmpdir();
  const outFile = path.join(
    tmpDir,
    `yt-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.webm`
  );

  console.log("🎧 [YT-DLP] Downloading to file:", outFile);

  const args = [
    youtubeUrl,
    "-f",
    "bestaudio",
    "-o",
    outFile,
    "--cookies-from-browser",
    "chrome",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "--referer",
    "https://www.youtube.com/",
    "--add-header",
    "Origin: https://www.youtube.com",
    "--add-header",
    "Accept-Language: en-US,en;q=0.9",
    "--force-ipv4",
    "--no-check-certificates",
  ];

  await runCommand("yt-dlp", args, "🎧 [YT-DLP]");

  const stats = await fsp.stat(outFile);
  console.log("🎧 [YT-DLP] Final audio file size:", stats.size);

  return outFile;
}

/* ============================================================================
   2) Split audio file into 60s WAV chunks using ffmpeg
============================================================================ */
async function splitAudioIntoChunks(inputFile) {
  console.log("🎬 [FFMPEG] Splitting into chunks:", inputFile);

  const dir = path.dirname(inputFile);
  const base = path.basename(inputFile, path.extname(inputFile));
  const pattern = path.join(dir, `${base}-chunk-%03d.wav`);

  const args = [
    "-y", // overwrite
    "-i",
    inputFile,
    "-ac",
    "1", // mono
    "-ar",
    "16000", // 16kHz (good for STT)
    "-f",
    "segment",
    "-segment_time",
    String(CHUNK_SECONDS),
    pattern,
  ];

  await runCommand("ffmpeg", args, "🎬 [FFMPEG]");

  // Collect chunk files
  const files = await fsp.readdir(dir);
  const chunkFiles = files
    .filter((f) => f.startsWith(`${base}-chunk-`) && f.endsWith(".wav"))
    .map((f) => path.join(dir, f))
    // Sort by index number in the file name
    .sort((a, b) => {
      const na = parseInt(a.match(/chunk-(\d{3})\.wav$/)?.[1] || "0", 10);
      const nb = parseInt(b.match(/chunk-(\d{3})\.wav$/)?.[1] || "0", 10);
      return na - nb;
    });

  console.log("🎬 [FFMPEG] Chunk files:", chunkFiles);

  if (chunkFiles.length === 0) {
    throw new Error("No chunk files created by ffmpeg");
  }

  return chunkFiles;
}

/* ============================================================================
   3) Send a single audio buffer to Deepgram
============================================================================ */
async function deepgramFromAudioBuffer(audioBuffer, index, total) {
  if (!DEEPGRAM_API_KEY) {
    console.warn("⚠️ [DEEPGRAM] Missing DEEPGRAM_API_KEY");
    return null;
  }

  console.log(
    `🟠 [DEEPGRAM] Sending chunk ${index + 1}/${total}… size:`,
    audioBuffer.length
  );

  try {
    const dgRes = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2-general&smart_format=true&language=en",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${DEEPGRAM_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        body: audioBuffer,
      }
    );

    console.log(
      `🟠 [DEEPGRAM] HTTP for chunk ${index + 1}/${total}:`,
      dgRes.status
    );

    if (!dgRes.ok) {
      const errText = await dgRes.text();
      console.error(`🟠 [DEEPGRAM ERR – chunk ${index + 1}]:`, errText);
      return null;
    }

    const data = await dgRes.json();
    const txt =
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";

    return txt.trim() || "";
  } catch (err) {
    console.error(`🟠 [DEEPGRAM EXCEPTION – chunk ${index + 1}]:`, err);
    return null;
  }
}

/* ============================================================================
   4) Transcribe all chunks sequentially and merge
============================================================================ */
async function transcribeChunks(chunkFiles) {
  console.log("🧠 [CHUNKS] Transcribing", chunkFiles.length, "chunks…");

  const partials = [];

  for (let i = 0; i < chunkFiles.length; i++) {
    const file = chunkFiles[i];
    console.log(`🧩 [CHUNK] ${i + 1}/${chunkFiles.length}:`, file);

    const buf = await fsp.readFile(file);
    const text = await deepgramFromAudioBuffer(buf, i, chunkFiles.length);

    if (text && text.length > 0) {
      partials.push(text);
    } else {
      console.warn(`⚠️ [CHUNK] No text returned for chunk ${i + 1}`);
    }
  }

  const finalTranscript = partials.join("\n\n");
  console.log("✅ [CHUNKS] Final merged transcript length:", finalTranscript.length);

  return finalTranscript;
}

/* ============================================================================
   5) Cleanup temp files
============================================================================ */
async function safeUnlink(filePath) {
  try {
    await fsp.unlink(filePath);
    console.log("🧹 [CLEANUP] Deleted:", filePath);
  } catch (err) {
    console.warn("🧹 [CLEANUP] Failed to delete:", filePath, err.message);
  }
}

/* ============================================================================
   HEALTH CHECK
============================================================================ */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "Chunked Transcriber (60s) running" });
});

/* ============================================================================
   MAIN ENDPOINT
============================================================================ */
app.post("/transcribe", async (req, res) => {
  const { youtube_url } = req.body || {};
  console.log("🔥 [SERVICE HIT] youtube_url:", youtube_url);

  if (!youtube_url) {
    return res.status(400).json({
      success: false,
      message: "youtube_url required",
    });
  }

  let audioFile = null;
  let chunkFiles = [];

  try {
    // 1) Download full audio to temp file
    audioFile = await downloadAudioToFile(youtube_url);

    // 2) Split into chunks
    chunkFiles = await splitAudioIntoChunks(audioFile);

    // 3) Transcribe each chunk and merge
    const transcript = await transcribeChunks(chunkFiles);

    if (!transcript) {
      return res.status(500).json({
        success: false,
        message: "No transcript generated from chunks",
      });
    }

    return res.json({
      success: true,
      transcript,
      chars: transcript.length,
      chunks: chunkFiles.length,
    });
  } catch (err) {
    console.error("❌ [SERVICE ERROR]:", err);
    return res.status(500).json({
      success: false,
      message: err.message || "Internal server error",
    });
  } finally {
    // 4) Cleanup temp files
    if (audioFile) {
      await safeUnlink(audioFile);
    }
    for (const f of chunkFiles) {
      await safeUnlink(f);
    }
  }
});

/* ============================================================================
   START SERVER
============================================================================ */
app.listen(PORT, () => {
  console.log(`🚀 Chunked Transcriber (60s) listening on port ${PORT}`);
});
