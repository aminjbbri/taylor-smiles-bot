const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== AUDIO STORAGE =====
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

// Serve audio files
app.get("/audio/:file", (req, res) => {
  const filePath = path.join(AUDIO_DIR, req.params.file);
  res.sendFile(filePath);
});

// Generate speech using OpenAI TTS
async function generateSpeech(text) {
  const response = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
  });

  const fileName = `speech-${Date.now()}.mp3`;
  const filePath = path.join(AUDIO_DIR, fileName);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  return fileName;
}

// ===== MEMORY =====
const calls = new Map();

function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, { history: [] });
  }
  return calls.get(callSid);
}

function clearCall(callSid) {
  calls.delete(callSid);
}

function wantsToEnd(text = "") {
  const t = text.toLowerCase();
  return t.includes("bye") || t.includes("no thanks") || t.includes("that's all");
}

// ===== CHAT =====
async function getReply(userSpeech, call) {
  const history = call.history.slice(-10);

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a real human receptionist at Taylor Smiles.

Speak naturally, casually, and briefly.

Sound like a person, not a chatbot.

Use phrases like:
"yeah", "of course", "no problem", "sure"

Keep responses short.

If caller is done, close politely.
`
      },
      ...history,
      { role: "user", content: userSpeech }
    ]
  });

  return completion.choices[0].message.content;
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.send("Bot running with TTS");
});

// Greeting
app.all("/voice", async (req, res) => {
  const callSid = req.body.CallSid || "test";
  getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  const greet = "Hi, thank you for calling Taylor Smiles. How can I help you today?";
  const file = await generateSpeech(greet);

  const audioUrl = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

  const gather = twiml.gather({
    input: "speech",
    action: "/conversation",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.play(audioUrl);

  res.type("text/xml");
  res.send(twiml.toString());
});

// Conversation
app.all("/conversation", async (req, res) => {
  const callSid = req.body.CallSid || "test";
  const userSpeech = req.body.SpeechResult || "";

  const call = getCall(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (!userSpeech) {
      const file = await generateSpeech("Sorry, I didn’t catch that.");
      const url = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

      twiml.play(url);
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    call.history.push({ role: "user", content: userSpeech });

    if (wantsToEnd(userSpeech)) {
      const file = await generateSpeech("Thanks for calling Taylor Smiles. Have a great day.");
      const url = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

      twiml.play(url);
      twiml.hangup();
      clearCall(callSid);

      return res.type("text/xml").send(twiml.toString());
    }

    const reply = await getReply(userSpeech, call);
    call.history.push({ role: "assistant", content: reply });

    const file = await generateSpeech(reply);
    const audioUrl = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

    twiml.play(audioUrl);

    const gather = twiml.gather({
      input: "speech",
      action: "/conversation",
      method: "POST",
      speechTimeout: "auto"
    });

    const followupFile = await generateSpeech("Anything else I can help with?");
    const followupUrl = `https://taylor-smiles-bot.onrender.com/audio/${followupFile}`;

    gather.play(followupUrl);

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error(err);

    const file = await generateSpeech("Sorry, something went wrong.");
    const url = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

    twiml.play(url);
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running"));
