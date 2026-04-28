const express = require("express");
const twilio = require("twilio");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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

app.all("/process-speech", (req, res) => {
  const userSpeech = req.body.SpeechResult || "";

  const twiml = new twilio.twiml.VoiceResponse();

  if (userSpeech) {
    twiml.say(`You said: ${userSpeech}`);
  } else {
    twiml.say("Sorry, I did not catch that.");
  }

  twiml.redirect({ method: "POST" }, "/voice");

  res.type("text/xml");
  res.send(twiml.toString());
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
