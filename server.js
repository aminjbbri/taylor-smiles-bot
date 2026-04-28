const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Temporary in-memory call state
const calls = {};

function getCall(callSid) {
  if (!calls[callSid]) {
    calls[callSid] = {
      intent: "",
      name: "",
      phone: "",
      patientType: "",
      reason: "",
      summary: ""
    };
  }
  return calls[callSid];
}

function cleanupCall(callSid) {
  delete calls[callSid];
}

function detectIntent(text) {
  const t = (text || "").toLowerCase();

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
    t.includes("change my appointment") ||
    t.includes("move my appointment") ||
    t.includes("missed my appointment")
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
    t.includes("existing patient") ||
    t.includes("already a patient")
  ) {
    return "existing_patient_issue";
  }

  return "general_question";
}

function wantsToEnd(text) {
  const t = (text || "").toLowerCase().trim();
  return [
    "no",
    "no thanks",
    "no thank you",
    "that's all",
    "that is all",
    "nothing else",
    "bye",
    "goodbye",
    "i'm good",
    "im good"
  ].includes(t);
}

async function receptionistReply(userSpeech, callData) {
  const systemPrompt = `
You are the front-desk receptionist for Taylor Smiles orthodontic clinic.

You are speaking on the phone with a real caller.

Your style:
- warm
- short
- natural
- organized
- human-like
- never sound like a chatbot

Rules:
- keep answers brief, like a real receptionist
- do not give exact treatment pricing
- if asked about cost, say pricing depends on the case and the clinic can review it during a consultation
- if appropriate, guide the caller toward booking a consultation
- if the caller has an urgent issue like pain, broken bracket, broken wire, or retainer problem, respond calmly and say the clinic team can help review it
- answer in 1 to 3 short sentences max

Known call context:
- intent: ${callData.intent || "unknown"}
- caller name: ${callData.name || "unknown"}
- patient type: ${callData.patientType || "unknown"}
- reason: ${callData.reason || "unknown"}
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
    "Sorry, could you repeat that?"
  );
}

app.get("/", (req, res) => {
  res.send("Taylor Smiles receptionist bot is running");
});

// First greeting
app.all("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/detect-intent",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say(
    "Hi, thank you for calling Taylor Smiles. How can I help you today?"
  );

  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

// Detect type of call
app.all("/detect-intent", async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  callData.reason = userSpeech;
  callData.intent = detectIntent(userSpeech);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    let firstReply = "";

    if (callData.intent === "consultation") {
      firstReply =
        "Of course. I can help with that. Is this for you or for your child?";
    } else if (callData.intent === "appointment_change") {
      firstReply =
        "No problem. I can help with that. Can I get the patient's name, please?";
    } else if (callData.intent === "existing_patient_issue") {
      firstReply =
        "I'm sorry to hear that. I can help note that for the team. Can I get the patient's name, please?";
    } else {
      firstReply = await receptionistReply(userSpeech, callData);
    }

    twiml.say(firstReply);

    const nextAction =
      callData.intent === "consultation"
        ? "/collect-patient-type"
        : callData.intent === "general_question"
        ? "/general-followup"
        : "/collect-name";

    const gather = twiml.gather({
      input: "speech",
      action: nextAction,
      method: "POST",
      speechTimeout: "auto"
    });

    if (callData.intent === "general_question") {
      gather.say("Can I get your name, please?");
    }

    twiml.say("Sorry, I didn't catch that. Let's try again.");
    twiml.redirect({ method: "POST" }, "/voice");

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("DETECT INTENT ERROR:", error);
    twiml.say("Sorry, there was a problem. Please try again later. Goodbye.");
    twiml.hangup();
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// Consultation path: for you or child
app.all("/collect-patient-type", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  callData.patientType = userSpeech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Perfect. Can I get the patient's name, please?");

  const gather = twiml.gather({
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

// Collect caller/patient name
app.all("/collect-name", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  callData.name = userSpeech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thank you. What is the best phone number for a callback?");

  const gather = twiml.gather({
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

// Collect phone number
app.all("/collect-phone", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  callData.phone = userSpeech;

  const twiml = new twilio.twiml.VoiceResponse();

  if (callData.intent === "consultation") {
    twiml.say(
      `Thanks. I have ${callData.name}. The best callback number is ${callData.phone}. You are calling about a consultation.`
    );
    twiml.say(
      "Perfect. The clinic team can follow up about booking your consultation. Is there anything else I can help you with?"
    );
  } else if (callData.intent === "appointment_change") {
    twiml.say(
      `Thanks. I have ${callData.name}, and the best callback number is ${callData.phone}. You are calling about changing an appointment.`
    );
    twiml.say(
      "Perfect. The clinic team can follow up to help with that. Is there anything else I can help you with?"
    );
  } else if (callData.intent === "existing_patient_issue") {
    twiml.say(
      `Thanks. I have ${callData.name}, and the best callback number is ${callData.phone}. I’ve noted the issue for the team.`
    );
    twiml.say(
      "The clinic team can review that and follow up. Is there anything else I can help you with?"
    );
  } else {
    twiml.say(
      `Thanks. I have ${callData.name}, and the best callback number is ${callData.phone}. Is there anything else I can help you with?`
    );
  }

  const gather = twiml.gather({
    input: "speech",
    action: "/process-followup",
    method: "POST",
    speechTimeout: "auto"
  });

  twiml.say("Thank you for calling Taylor Smiles. Goodbye.");
  twiml.hangup();

  res.type("text/xml");
  res.send(twiml.toString());
});

// General question path before collecting name
app.all("/general-followup", (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  callData.name = userSpeech;

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Thank you. What is the best callback number, in case the team needs to reach you?");

  const gather = twiml.gather({
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

// Continue the conversation naturally
app.all("/process-followup", async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult || "";
  const callData = getCall(callSid);

  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (wantsToEnd(userSpeech)) {
      twiml.say("Thank you for calling Taylor Smiles. Have a great day. Goodbye.");
      twiml.hangup();
      cleanupCall(callSid);
      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }

    const reply = await receptionistReply(userSpeech, callData);

    twiml.say(reply);

    const gather = twiml.gather({
      input: "speech",
      action: "/process-followup",
      method: "POST",
      speechTimeout: "auto"
    });

    gather.say("Is there anything else I can help you with?");

    twiml.say("Thank you for calling Taylor Smiles. Goodbye.");
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("FOLLOWUP ERROR:", error);
    twiml.say("Sorry, there was a problem. Please try again later. Goodbye.");
    twiml.hangup();
    cleanupCall(callSid);
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
