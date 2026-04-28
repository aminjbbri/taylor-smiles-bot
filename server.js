const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple per-call memory for prototype use
const calls = new Map();

function getCall(callSid) {
  if (!calls.has(callSid)) {
    calls.set(callSid, {
      stage: "intro",
      intent: "",
      name: "",
      callbackNumber: "",
      patientType: "",
      reason: "",
      notes: ""
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
    "goodbye"
  ].includes(t);
}

function detectIntent(text = "") {
  const t = normalize(text);

  if (
    t.includes("consult") ||
    t.includes("invisalign") ||
    t.includes("braces") ||
    t.includes("aligner") ||
    t.includes("new patient")
  ) {
    return "consultation";
  }

  if (
    t.includes("reschedule") ||
    t.includes("cancel") ||
    t.includes("change appointment") ||
    t.includes("move appointment") ||
    t.includes("missed appointment")
  ) {
    return "appointment_change";
  }

  if (
    t.includes("bracket") ||
    t.includes("wire") ||
    t.includes("retainer") ||
    t.includes("pain") ||
    t.includes("broken") ||
    t.includes("loose") ||
    t.includes("already a patient") ||
    t.includes("existing patient")
  ) {
    return "existing_patient_issue";
  }

  return "general_question";
}

async function receptionistReply(userSpeech, call) {
  const systemPrompt = `
You are the real front-desk receptionist for Taylor Smiles orthodontic clinic.

You are speaking on the phone with a real caller.

Your style:
- warm
- natural
- calm
- slightly casual
- short
- human-like
- never robotic
- never overly formal

Rules:
- sound like a real receptionist, not a chatbot
- keep replies short: usually 1 or 2 short sentences
- ask only one question at a time
- do not repeat the full greeting unless the call restarts
- do not give exact pricing
- if asked about cost, say pricing depends on the case and the clinic can go over that during a consultation
- if appropriate, guide the caller toward booking or next steps
- if they mention pain, a broken bracket, broken wire, or retainer issue, sound calm and say the clinic team can help review it
- use natural phrases like:
  "of course"
  "no problem"
  "absolutely"
  "let me get a few details"
  "sure"
  "okay"

Current call context:
- intent: ${call.intent || "unknown"}
- caller name: ${call.name || "unknown"}
- callback number: ${call.callbackNumber || "unknown"}
- patient type: ${call.patientType || "unknown"}
- reason: ${call.reason || "unknown"}

Answer the caller's latest message naturally, like a front-desk receptionist on the phone.
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

// First greeting only
app.all("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/handle-intro",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say("Hi, thank you for calling Taylor Smiles. How can I help you today?");

  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Handle first caller message and choose path
app.all("/handle-intro", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const call = getCall(callSid);

  call.reason = speech;
  call.intent = detectIntent(speech);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (call.intent === "consultation") {
      twiml.say("Of course. Is this for you or for your child?");
      const gather = twiml.gather({
        input: "speech",
        action: "/collect-patient-type",
        method: "POST",
        speechTimeout: "auto"
      });
      gather.say("You can just say for me, or for my child.");
    } else if (call.intent === "appointment_change") {
      twiml.say("No problem. Can I get the patient's name, please?");
      twiml.gather({
        input: "speech",
        action: "/collect-name",
        method: "POST",
        speechTimeout: "auto"
      });
    } else if (call.intent === "existing_patient_issue") {
      twiml.say("I’m sorry to hear that. Can I get the patient's name, please?");
      twiml.gather({
        input: "speech",
        action: "/collect-name",
        method: "POST",
        speechTimeout: "auto"
      });
    } else {
      const reply = await receptionistReply(speech, call);
      twiml.say(reply);
      twiml.say("Can I get your name, please?");
      twiml.gather({
        input: "speech",
        action: "/collect-name",
        method: "POST",
        speechTimeout: "auto"
      });
    }

    twiml.say("Sorry, I didn't catch that. Let's try again.");
    twiml.redirect({ method: "POST" }, "/voice");

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("HANDLE INTRO ERROR:", error);
    twiml.say("Sorry, there was a problem. Please try again later. Goodbye.");
    twiml.hangup();
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

app.all("/collect-patient-type", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const call = getCall(callSid);

  call.patientType = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Okay, and what’s the patient's name?");
  twiml.gather({
    input: "speech",
    action: "/collect-name",
    method: "POST",
    speechTimeout: "auto"
  });

  twiml.say("Sorry, I didn't catch that.");
  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

app.all("/collect-name", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const call = getCall(callSid);

  call.name = speech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thanks. What’s the best number to reach you on?");
  twiml.gather({
    input: "speech",
    action: "/collect-phone",
    method: "POST",
    speechTimeout: "auto"
  });

  twiml.say("Sorry, I didn't catch that.");
  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

app.all("/collect-phone", (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const call = getCall(callSid);

  call.callbackNumber = speech;

  const twiml = new twilio.twiml.VoiceResponse();

  if (call.intent === "consultation") {
    twiml.say(
      `Perfect. I’ve got ${call.name}, and the best number to reach you is ${call.callbackNumber}.`
    );
    twiml.say("The team can follow up with you about booking a consultation.");
  } else if (call.intent === "appointment_change") {
    twiml.say(
      `Okay. I’ve got ${call.name}, and the best number to reach you is ${call.callbackNumber}.`
    );
    twiml.say("I’ll note that this is about changing an appointment.");
  } else if (call.intent === "existing_patient_issue") {
    twiml.say(
      `Okay. I’ve got ${call.name}, and the best number to reach you is ${call.callbackNumber}.`
    );
    twiml.say("I’ll note that for the team so they can review it.");
  } else {
    twiml.say(
      `Perfect. I’ve got ${call.name}, and the best number to reach you is ${call.callbackNumber}.`
    );
    twiml.say("I can help with anything else you need.");
  }

  const gather = twiml.gather({
    input: "speech",
    action: "/followup",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say("Anything else I can help with today?");

  twiml.say("Thanks for calling Taylor Smiles. Goodbye.");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

app.all("/followup", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();
  const call = getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (wantsToEnd(speech)) {
      twiml.say("Thanks for calling Taylor Smiles. Have a great day. Goodbye.");
      twiml.hangup();
      clearCall(callSid);
      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    const reply = await receptionistReply(speech, call);
    twiml.say(reply);

    const gather = twiml.gather({
      input: "speech",
      action: "/followup",
      method: "POST",
      speechTimeout: "auto"
    });

    gather.say("Anything else I can help with today?");

    twiml.say("Thanks for calling Taylor Smiles. Goodbye.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("FOLLOWUP ERROR:", error);
    twiml.say("Sorry, there was a problem. Please try again later. Goodbye.");
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
