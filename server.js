require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL || "https://taylor-smiles-bot.onrender.com";

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";

// Single best voice choice
const REALTIME_VOICE = process.env.REALTIME_VOICE || "marin";
const GREETING_VOICE = process.env.GREETING_VOICE || "marin";

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const AUDIO_DIR = path.join(__dirname, "audio");

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

app.use("/audio", express.static(AUDIO_DIR));

// New file name so old cedar/alloy/nova greeting is not reused
const GREETING_FILE = path.join(AUDIO_DIR, "greeting-marin-final-v2.mp3");

async function makeGreetingIfNeeded() {
  if (fs.existsSync(GREETING_FILE)) return;

  console.log("Creating Marin greeting audio...");

  const speech = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: GREETING_VOICE,
    input: "Thank you for calling Taylor Smiles.",
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(GREETING_FILE, buffer);

  console.log("Marin greeting audio created.");
}

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles realtime receptionist is running.");
});

app.get("/greeting.mp3", async (req, res) => {
  try {
    await makeGreetingIfNeeded();
    res.sendFile(GREETING_FILE);
  } catch (err) {
    console.error("Greeting TTS error:", err);
    res.status(500).send("Greeting error");
  }
});

app.all("/incoming-call", async (req, res) => {
  const host = new URL(BASE_URL).host;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${BASE_URL}/greeting.mp3</Play>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>`;

  res.type("text/xml");
  res.send(twiml);
});

const wss = new WebSocket.Server({
  server,
  path: "/media-stream",
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected.");

  let streamSid = null;
  let openAiWs = null;
  let openAiReady = false;

  function safeSendToTwilio(payload) {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(payload));
    }
  }

  function safeSendToOpenAI(payload) {
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.send(JSON.stringify(payload));
    }
  }

  function connectOpenAI() {
    const openAiUrl = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

    openAiWs = new WebSocket(openAiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime.");
      openAiReady = true;

      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: `
You are a normal receptionist answering the phone for Taylor Smiles.

You are a person first, receptionist second.

You are not overly cheerful.
You are not cold or rude.
You are not fake.
You are not emotionally intense.
You are not trying to impress anyone.
You are just a regular front-desk employee doing the job properly.

The caller already heard:
"Hi, Taylor Smiles."

So do not greet again.
Wait for the caller to speak, then respond normally.

Your tone:
- calm
- normal
- polite
- easy-going
- practical
- lightly friendly
- clear
- patient
- not too formal
- not too casual
- not too sweet
- not blunt
- not overly energetic
- not emotionally over-invested

The caller should feel like they are speaking to a normal, reasonable person at the front desk.

You should sound like someone who:
- is doing her job properly
- is helpful enough
- does not overdo it
- does not sound scripted
- does not sound annoyed
- does not sound fake-happy

Use natural phrases like:
- yeah
- okay
- sure
- no problem
- alright
- I see
- that's fine
- one sec
- let me check that
- what's the name?

Avoid over-polished phrases like:
- absolutely
- wonderful
- fantastic
- I'd be happy to assist
- my pleasure
- thank you so much
- I completely understand
- I'm sorry to hear that, unless it is actually serious

Do not be rude.
Do not be blunt.
Do not sound bored.
Do not sound excited.
Do not sound like a therapist.
Do not sound like a salesperson.
Do not sound like a chatbot.
Do not sound like customer service training.

Conversation style:
- keep replies short
- answer directly
- ask one question at a time
- do not over-explain
- do not force a structure
- do not repeat phrases
- do not agree randomly
- do not say "anything else I can help with" repeatedly
- do not rush if the caller pauses
- if the caller mumbles, say: "Sorry, what was that?" or "Sorry, I missed that."

Business context:
Taylor Smiles is an orthodontic clinic.
People may ask about braces, Invisalign, retainers, appointments, adults, kids, consultations, broken retainers, broken brackets, pain, or rescheduling.

Business rules:
- Do not give exact treatment pricing.
- If asked about price, say: "It depends on the case, but they can go over that at the consultation."
- If the caller asks if you are AI, answer honestly: "I'm the phone assistant for Taylor Smiles."
- If the caller wants to book or needs a callback, naturally ask for their name and phone number.
- If the caller has a broken retainer, broken bracket, pain, or wire issue, be calm and practical, not dramatic.
- Ask only one question at a time.

Examples of the right style:

Caller: Do you do Invisalign?
You: Yeah, we do. Were you looking to book a consult?

Caller: How much is it?
You: It depends on the case. They’d go over that at the consult.

Caller: My retainer broke.
You: Okay. What’s the patient’s name?

Caller: Can I book?
You: Sure. What’s your name?

Caller: Are you open today?
You: I’d have to check the exact schedule. What were you hoping to come in for?

Caller: Thanks, bye.
You: Okay, sounds good. Take care.

Your goal:
Sound like a normal receptionist — polite, useful, and easy to talk to, without being fake or overly enthusiastic.
          `.trim(),

          voice: REALTIME_VOICE,

          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          turn_detection: {
            type: "server_vad",

            // Less jumpy, less likely to respond to tiny noises
            threshold: 0.68,

            // Keeps a bit of speech before detection
            prefix_padding_ms: 400,

            // Waits a little before replying, so it feels less rushed
            silence_duration_ms: 1000,
          },
        },
      };

      safeSendToOpenAI(sessionUpdate);
    });

    openAiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === "response.audio.delta" && event.delta && streamSid) {
          safeSendToTwilio({
            event: "media",
            streamSid,
            media: {
              payload: event.delta,
            },
          });
        }

        if (event.type === "input_audio_buffer.speech_started" && streamSid) {
          safeSendToTwilio({
            event: "clear",
            streamSid,
          });
        }

        if (event.type === "error") {
          console.error("OpenAI Realtime error:", JSON.stringify(event, null, 2));
        }
      } catch (err) {
        console.error("Error parsing OpenAI message:", err);
      }
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WebSocket error:", err);
    });

    openAiWs.on("close", (code, reason) => {
      openAiReady = false;
      console.log("OpenAI WebSocket closed:", code, reason?.toString());
    });
  }

  connectOpenAI();

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("Twilio stream started:", streamSid);
      }

      if (msg.event === "media") {
        if (openAiReady) {
          safeSendToOpenAI({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          });
        }
      }

      if (msg.event === "stop") {
        console.log("Twilio stream stopped.");

        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
      }
    } catch (err) {
      console.error("Error parsing Twilio message:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected.");

    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
      openAiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WebSocket error:", err);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
