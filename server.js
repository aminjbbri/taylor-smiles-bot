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

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles realtime receptionist is running");
});

app.all("/incoming-call", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${new URL(BASE_URL).host}/media-stream" />
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
  console.log("Twilio connected to media stream");

  let streamSid = null;
  let openAiWs = null;

  const connectToOpenAI = () => {
    openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openAiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime");

      const sessionUpdate = {
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime",
          instructions: `
You are a warm woman answering the phone for Taylor Smiles.

The experience matters more than business scripting.

You are a person first, receptionist second.

Speak naturally, casually, and briefly.
You are not a form.
You are not a chatbot.
You are not a customer-service script.

Tone:
- warm
- relaxed
- human
- calm
- easy to talk to
- lightly conversational
- not overly polished

Rules:
- keep responses short
- do not over-explain
- do not ask too many questions
- do not repeat the same phrase
- do not say "anything else I can help with" repeatedly
- do not force a structure
- do not give exact treatment pricing
- if asked about price, say it depends on the case and the team can go over that during a consultation
- if the caller asks if you are AI, answer honestly: "I'm the phone assistant for Taylor Smiles."

Business context:
Taylor Smiles is an orthodontic clinic.
People may ask about braces, Invisalign, retainers, appointments, adults, kids, consultations, broken retainers, broken brackets, pain, or rescheduling.

Your goal is to make the phone call feel natural, easy, and human.
          `,
          voice: "marin",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        },
      };

      openAiWs.send(JSON.stringify(sessionUpdate));

      const initialResponse = {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Greet the caller naturally in one short sentence. Do not sound scripted.",
        },
      };

      openAiWs.send(JSON.stringify(initialResponse));
    });

    openAiWs.on("message", (data) => {
      try {
        const event = JSON.parse(data.toString());

        if (event.type === "response.audio.delta" && event.delta && streamSid) {
          const audioDelta = {
            event: "media",
            streamSid,
            media: {
              payload: event.delta,
            },
          };

          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify(audioDelta));
          }
        }

        if (event.type === "input_audio_buffer.speech_started") {
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(
              JSON.stringify({
                event: "clear",
                streamSid,
              })
            );
          }
        }

        if (event.type === "error") {
          console.error("OpenAI error:", event);
        }
      } catch (err) {
        console.error("OpenAI message parse error:", err);
      }
    });

    openAiWs.on("close", () => {
      console.log("OpenAI Realtime disconnected");
    });

    openAiWs.on("error", (err) => {
      console.error("OpenAI WebSocket error:", err);
    });
  };

  connectToOpenAI();

  twilioWs.on("message", (message) => {
    try {
      const msg = JSON.parse(message.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("Twilio stream started:", streamSid);
      }

      if (msg.event === "media") {
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: msg.media.payload,
            })
          );
        }
      }

      if (msg.event === "stop") {
        console.log("Twilio stream stopped");
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
          openAiWs.close();
        }
      }
    } catch (err) {
      console.error("Twilio message parse error:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");

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
