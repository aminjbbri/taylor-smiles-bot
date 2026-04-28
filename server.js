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

// Change this if your Render URL changes
const BASE_URL = process.env.BASE_URL || "https://taylor-smiles-bot.onrender.com";

// OpenAI TTS female-style voice
const TTS_VOICE = "nova";

// Audio storage
const AUDIO_DIR = path.join(__dirname, "audio");

if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR);
}

app.use("/audio", express.static(AUDIO_DIR));

// Simple call memory
const calls = new Map();

function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      history: [],
      startedAt: Date.now(),
    });
  }

  return calls.get(callSid);
}

function clearCall(callSid) {
  calls.delete(callSid);
}

function wantsToEnd(text = "") {
  const t = text.toLowerCase().trim();

  return [
    "bye",
    "goodbye",
    "no",
    "no thanks",
    "no thank you",
    "that's all",
    "that is all",
    "nothing else",
    "i'm good",
    "im good",
    "that's it",
    "thats it",
    "all good",
  ].includes(t);
}

async function makeSpeechAudio(text) {
  const cleanText = String(text || "").trim();

  const tts = await client.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: TTS_VOICE,
    input: cleanText,
  });

  const fileName = `speech-${Date.now()}-${Math.floor(Math.random() * 100000)}.mp3`;
  const filePath = path.join(AUDIO_DIR, fileName);

  const buffer = Buffer.from(await tts.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  // delete old audio after 10 minutes
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, 10 * 60 * 1000);

  return `${BASE_URL}/audio/${fileName}`;
}

async function playOrSay(twiml, text) {
  try {
    const audioUrl = await makeSpeechAudio(text);
    twiml.play(audioUrl);
  } catch (err) {
    console.error("TTS ERROR:", err);
    // fallback if TTS fails
    twiml.say(text);
  }
}

async function getNaturalReply(userSpeech, call) {
  const history = call.history.slice(-10);

  const systemPrompt = `
You are the phone receptionist voice for Taylor Smiles.

The experience matters more than sounding like a business script.

Speak like a normal warm woman on the phone.

You are not a form.
You are not a customer service script.
You are not a chatbot.
You are just having a natural phone conversation.

Style:
- very conversational
- calm
- casual
- warm
- short
- easy to talk to
- not overly professional
- not overly helpful
- not robotic

Very important:
- keep replies short, usually 5 to 15 words
- do not always ask a follow-up question
- do not say "anything else I can help with"
- do not repeat phrases
- do not force the caller through a process
- do not ask multiple questions at once
- do not over-explain
- let the conversation breathe

Natural phrases are okay:
- yeah
- sure
- of course
- no problem
- okay
- absolutely
- I get you

Business context:
Taylor Smiles is an orthodontic clinic.
They may ask about braces, Invisalign, retainers, appointments, adults, children, consultations, or rescheduling.

Business rules:
- do not give exact treatment prices
- if they ask price, say it depends on the case and the team can go over it during a consultation
- if they want to book or need help, naturally ask for name or number only when it feels normal
- if they seem done, close warmly

If asked whether you are AI, do not lie. Say you're the phone assistant for Taylor Smiles.

The goal is not to sound smart.
The goal is to sound easy and human.
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userSpeech },
    ],
  });

  return completion.choices?.[0]?.message?.content?.trim() || "Sorry, I missed that.";
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles natural receptionist bot is running");
});

// First greeting only
app.all("/voice", async (req, res) => {
  const callSid = req.body.CallSid || "test-call";
  getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/conversation",
    method: "POST",
    speechTimeout: "auto",
    timeout: 6,
  });

  await playOrSay(
    gather,
    "Hi, thanks for calling Taylor Smiles. How can I help?"
  );

  await playOrSay(twiml, "No worries. You can call us back anytime. Take care.");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// Main natural conversation loop
app.all("/conversation", async (req, res) => {
  const callSid = req.body.CallSid || "test-call";
  const userSpeech = (req.body.SpeechResult || "").trim();

  const call = getCall(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (!userSpeech) {
      const gather = twiml.gather({
        input: "speech",
        action: "/conversation",
        method: "POST",
        speechTimeout: "auto",
        timeout: 5,
      });

      await playOrSay(gather, "Sorry, I missed that. Say that again?");

      await playOrSay(twiml, "No worries. Take care.");
      twiml.hangup();

      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    if (wantsToEnd(userSpeech)) {
      await playOrSay(twiml, "Okay, sounds good. Have a great day.");
      twiml.hangup();
      clearCall(callSid);

      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    call.history.push({ role: "user", content: userSpeech });

    const reply = await getNaturalReply(userSpeech, call);

    call.history.push({ role: "assistant", content: reply });

    await playOrSay(twiml, reply);

    // After replying, just listen quietly.
    // No forced "anything else" line.
    const gather = twiml.gather({
      input: "speech",
      action: "/conversation",
      method: "POST",
      speechTimeout: "auto",
      timeout: 6,
    });

    // Empty gather means the line stays open naturally after the reply.
    // If caller speaks, conversation continues.
    // If not, Twilio continues to polite close below.

    await playOrSay(twiml, "Okay, take care.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (err) {
    console.error("CONVERSATION ERROR:", err);

    await playOrSay(twiml, "Sorry, something went wrong on my end. Please try again later.");
    twiml.hangup();
    clearCall(callSid);

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
