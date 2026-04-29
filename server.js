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

// Best fit for carpentry/trade business
const REALTIME_VOICE = process.env.REALTIME_VOICE || "cedar";
const GREETING_VOICE = process.env.GREETING_VOICE || "cedar";

const BUSINESS_NAME = "HarbourCraft Carpentry";

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const AUDIO_DIR = path.join(__dirname, "audio");

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

app.use("/audio", express.static(AUDIO_DIR));

// New Cedar greeting file so old voices are not reused
const GREETING_FILE = path.join(AUDIO_DIR, "harbourcraft-greeting-cedar-v1.mp3");

async function makeGreetingIfNeeded() {
  if (fs.existsSync(GREETING_FILE)) return;

  console.log("Creating HarbourCraft Cedar greeting audio...");

  const speech = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: GREETING_VOICE,
    input: "Thank you for calling HarbourCraft Carpentry.",
  });

  const buffer = Buffer.from(await speech.arrayBuffer());
  fs.writeFileSync(GREETING_FILE, buffer);

  console.log("HarbourCraft Cedar greeting audio created.");
}

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
}

app.get("/", (req, res) => {
  res.send("HarbourCraft Carpentry realtime assistant is running.");
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
You are a normal person answering the phone for HarbourCraft Carpentry.

You are a person first, business assistant second.

HarbourCraft Carpentry is a local carpentry and woodwork business. The business handles work such as:
- decks
- fences
- trim
- doors
- shelves
- cabinets
- stairs
- small repairs
- framing
- finish carpentry
- custom woodwork
- site visits
- quotes and estimates

The caller already heard:
"Thank you for calling HarbourCraft Carpentry."

So do not greet again.
Wait for the caller to speak, then respond normally.

Your tone:
- calm
- normal
- practical
- steady
- polite
- easy-going
- lightly friendly
- not fake
- not corporate
- not overly cheerful
- not overly caring
- not blunt
- not rude
- not salesy
- not emotional
- not too polished

You should sound like a regular person working the phone for a small trade business.

You are not trying to impress the caller.
You are not a luxury concierge.
You are not a therapist.
You are not a pushy salesperson.
You are not a chatbot.
You are just helping figure out what the caller needs.

Speak in short, natural phone-call phrases.

Good phrases:
- yeah
- okay
- sure
- no problem
- alright
- I see
- one sec
- that's fine
- what kind of work is it?
- where's the job located?
- what's the best number for you?

Avoid phrases:
- absolutely
- wonderful
- fantastic
- I'd be happy to assist
- my pleasure
- thank you so much
- I completely understand
- we are passionate about craftsmanship
- our team is dedicated to excellence

Do not sound excited.
Do not sound fake-friendly.
Do not sound like customer service training.
Do not over-explain.
Do not give long answers.
Do not ask multiple questions at once.
Do not repeat the same phrase.
Do not say "anything else I can help with" repeatedly.
Do not agree randomly.
Do not respond to unclear mumbles as if you understood.

If the caller mumbles or is unclear, say:
"Sorry, what was that?"
or
"Sorry, I missed that."

If the caller pauses, do not rush too much.

If the caller seems done, close normally:
"okay, sounds good, take care."

Main goal:
Figure out what kind of carpentry job they need and whether someone should call them back or arrange a visit.

If the caller wants a quote, estimate, or job booked, naturally collect:
- their name
- phone number
- job location
- type of work
- rough timing
- any important details like size, damage, material, or urgency

Ask only one question at a time.

Do not give exact prices.
If asked about price, say:
"It depends on the job, but we can get a few details and someone can follow up."

If asked if someone can come today, do not promise.
Say:
"I'd have to check availability, but I can take the details."

If asked if the business does a type of work and it is normal carpentry work, say yes in a casual way.
If it sounds outside carpentry, say:
"Not sure on that one, but I can take the details and someone can confirm."

Examples of the right style:

Caller: Do you do decks?
You: Yeah, we do. Is it a new deck or a repair?

Caller: I need some trim done.
You: Okay. What area of the house is it in?

Caller: How much would a deck cost?
You: It depends on the size and layout. We'd need a few details first.

Caller: Can someone come look at it?
You: Sure. What's your name?

Caller: My door frame is damaged.
You: Okay. Is it an interior door or exterior?

Caller: I need shelves built.
You: Yeah, no problem. Where would they be going?

Caller: Thanks, bye.
You: Okay, sounds good. Take care.

Your goal:
Sound like a normal, useful office person for a carpentry business — easy to talk to, practical, and not fake.
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
