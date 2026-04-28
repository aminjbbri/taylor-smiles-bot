const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple in-memory call memory for prototype use
const calls = new Map();

function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      history: [],
      extracted: {
        name: "",
        callbackNumber: "",
        reason: ""
      }
    });
  }
  return calls.get(callSid);
}

function clearCall(callSid) {
  calls.delete(callSid);
}

function normalize(text = "") {
  return text.toLowerCase().trim();
}

function wantsToEnd(text = "") {
  const t = normalize(text);
  return [
    "no",
    "no thanks",
    "no thank you",
    "that's all",
    "that is all",
    "nothing else",
    "i'm good",
    "im good",
    "bye",
    "goodbye",
    "that will be all",
    "that's it",
    "thats it"
  ].includes(t);
}

// Very lightweight extraction for memory.
// This is intentionally simple so the conversation stays natural.
function updateExtractedInfo(call, text = "") {
  const raw = text.trim();

  if (!call.extracted.reason && raw.length > 6) {
    call.extracted.reason = raw;
  }

  // crude phone number capture
  const digits = raw.replace(/\D/g, "");
  if (!call.extracted.callbackNumber && digits.length >= 7) {
    call.extracted.callbackNumber = raw;
  }

  // crude name capture patterns
  const lower = raw.toLowerCase();
  const namePatterns = [
    "my name is ",
    "this is ",
    "i am ",
    "i'm "
  ];

  for (const pattern of namePatterns) {
    const idx = lower.indexOf(pattern);
    if (idx !== -1 && !call.extracted.name) {
      const nameGuess = raw.slice(idx + pattern.length).trim();
      if (nameGuess && nameGuess.length < 40) {
        call.extracted.name = nameGuess;
      }
    }
  }
}

async function getReceptionistReply(userSpeech, call) {
  const conversationHistory = call.history
    .slice(-12)
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const systemPrompt = `
You are the front-desk receptionist for Taylor Smiles orthodontic clinic.

You are speaking on the phone with a real caller.

Your personality:
- warm
- calm
- natural
- human
- slightly casual
- brief
- never robotic
- never scripted
- never overly formal

Your job:
- respond like a real person answering the front desk
- help callers with questions
- guide them toward next steps when appropriate
- naturally collect useful details if it makes sense during the conversation, such as:
  - caller name
  - callback number
  - brief reason for calling
- sound like a person first, not a workflow

Important rules:
- keep responses short, usually 1 to 3 short sentences
- do not sound like a chatbot
- do not ask too many questions at once
- ask for details only when it feels natural
- do not give exact treatment pricing
- if asked about cost, say pricing depends on the case and can be reviewed during a consultation
- if the caller mentions braces, Invisalign, consultation, broken retainer, broken bracket, pain, scheduling, or rescheduling, handle it calmly and naturally like a receptionist
- if the caller seems done, close politely
- if it makes sense, encourage a consultation or callback
- if you already have their name or number, do not ask again unless necessary

Known details already collected:
- Name: ${call.extracted.name || "unknown"}
- Callback number: ${call.extracted.callbackNumber || "unknown"}
- Reason for calling: ${call.extracted.reason || "unknown"}

Recent conversation:
${conversationHistory || "No previous conversation yet."}

Your reply should sound like a real receptionist speaking on the phone.
`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userSpeech }
    ]
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "Sorry, could you say that again?"
  );
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles receptionist bot is running");
});

// First hello only
app.all("/voice", (req, res) => {
  const callSid = req.body.CallSid || "browser-test";
  getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/conversation",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say("Hi, thank you for calling Taylor Smiles. How can I help you today?");

  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Main natural conversation loop
app.all("/conversation", async (req, res) => {
  const callSid = req.body.CallSid || "browser-test";
  const userSpeech = (req.body.SpeechResult || "").trim();

  const call = getCall(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (!userSpeech) {
      const gather = twiml.gather({
        input: "speech",
        action: "/conversation",
        method: "POST",
        speechTimeout: "auto"
      });

      gather.say("Sorry, I didn’t catch that. Could you say that again?");

      twiml.say("Thanks for calling Taylor Smiles. Goodbye.");
      twiml.hangup();

      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    updateExtractedInfo(call, userSpeech);
    call.history.push({ role: "user", content: userSpeech });

    if (wantsToEnd(userSpeech)) {
      twiml.say("Of course. Thanks for calling Taylor Smiles. Have a great day. Goodbye.");
      twiml.hangup();
      clearCall(callSid);

      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    const reply = await getReceptionistReply(userSpeech, call);

    call.history.push({ role: "assistant", content: reply });

    // Update memory from assistant side too, lightly
    updateExtractedInfo(call, reply);

    twiml.say(reply);

    const gather = twiml.gather({
      input: "speech",
      action: "/conversation",
      method: "POST",
      speechTimeout: "auto"
    });

    gather.say("Anything else I can help with today?");

    twiml.say("Thanks for calling Taylor Smiles. Goodbye.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("CONVERSATION ERROR:", error);

    twiml.say("Sorry, there was a problem on our end. Please try again later. Goodbye.");
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
