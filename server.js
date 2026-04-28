const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("Taylor Smiles bot is running");
});

app.all("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const gather = twiml.gather({
    input: "speech",
    action: "/process-speech",
    method: "POST",
    speechTimeout: "auto"
  });

  gather.say("Hi, thank you for calling Taylor Smiles. How can I help you today?");

  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

app.all("/process-speech", async (req, res) => {
  try {
    const userSpeech = req.body.SpeechResult || "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a friendly and professional receptionist for Taylor Smiles orthodontic clinic.
Keep answers short, warm, and clear.
Never give exact treatment pricing.
Try to guide the caller toward booking a consultation.
If the caller asks about braces, Invisalign, appointments, retainer issues, or general orthodontic questions, answer briefly and helpfully.
If you are unsure, say the clinic team can confirm details during a consultation.`
        },
        {
          role: "user",
          content: userSpeech
        }
      ]
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "Sorry, could you say that again?";

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(reply);
    twiml.redirect({ method: "POST" }, "/voice");

    res.type("text/xml");
    res.send(twiml.toString());
  } catch (error) {
    console.error("PROCESS-SPEECH ERROR:", error);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("Sorry, there was a problem. Please try again.");
    twiml.redirect({ method: "POST" }, "/voice");

    res.type("text/xml");
    res.send(twiml.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
