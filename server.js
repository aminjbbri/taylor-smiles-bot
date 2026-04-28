require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.BASE_URL || "https://taylor-smiles-bot.onrender.com";

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview";
const REALTIME_VOICE = process.env.REALTIME_VOICE || "alloy";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles realtime receptionist is running.");
});

app.all("/incoming-call", (req, res) => {
  const host = new URL(BASE_URL).host;

  // IMPORTANT:
  // Twilio says the first greeting immediately.
  // Then it connects the live OpenAI Realtime stream.
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hi, thanks for calling Taylor Smiles. How can I help?</Say>
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
You are a warm woman answering the phone for Taylor Smiles.

Important context:
The caller has already heard the opening greeting:
"Hi, thanks for calling Taylor Smiles. How can I help?"

So do NOT greet again.
Wait for the caller to speak, then respond naturally.

You are a person first, receptionist second.

The business is secondary. The human experience is the priority.

Tone:
- warm
- calm
- relaxed
- natural
- human
- casual but professional
- not overly polished
- not overly eager
- thoughtful

Very important:
- Do NOT respond to unclear mumbles as if you understood.
- If the caller mumbles, makes a small sound, or says something unclear, ask naturally:
  "Sorry, what was that?"
  or
  "Sorry, I missed that."
- Do NOT say "absolutely" unless the caller clearly asked for something.
- Do NOT agree randomly.
- Do NOT over-answer.
- Do NOT force a structure.
- Do NOT repeat phrases.
- Do NOT say "anything else I can help with" repeatedly.
- Do NOT sound like a chatbot.
- Keep replies short and natural.
- Ask only one question at a time.
- Let the conversation breathe.
- If the caller pauses, do not rush too much.
- If the caller sounds unsure, be patient.

Business context:
Taylor Smiles is an orthodontic clinic.
People may ask about braces, Invisalign, retainers, appointments, adults, kids, consultations, broken retainers, broken brackets, pain, or rescheduling.

Business rules:
- Do not give exact treatment pricing.
- If asked about price, say it depends on the case and the team can go over it during a consultation.
- If the caller asks if you are AI, answer honestly: "I'm the phone assistant for Taylor Smiles."

Your goal:
Make the caller feel like they are speaking with a relaxed, thoughtful human receptionist.
          `.trim(),

          voice: REALTIME_VOICE,

          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          turn_detection: {
            type: "server_vad",

            // Higher = less likely to react to mumbling/background noise
            threshold: 0.65,

            // Keeps a bit of audio before detected speech
            prefix_padding_ms: 400,

            // Higher = waits longer before replying
            silence_duration_ms: 900,
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
