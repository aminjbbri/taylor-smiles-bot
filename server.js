app.all("/conversation", async (req, res) => {
  const callSid = req.body.CallSid || "test";
  const userSpeech = (req.body.SpeechResult || "").trim();

  const call = getCall(callSid);
  const twiml = new twilio.twiml.VoiceResponse();

  try {
    if (!userSpeech) {
      const file = await generateSpeech("Sorry, I didn't catch that.");
      const url = `https://taylor-smiles-bot.onrender.com/audio/${file}`;

      twiml.play(url);
      twiml.hangup();

      return res.type("text/xml").send(twiml.toString());
    }

    call.history.push({ role: "user", content: userSpeech });

    // 🧠 MUCH BETTER PROMPT
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a real woman answering the phone at Taylor Smiles.

You are NOT a chatbot.

You are:
- relaxed
- human
- casual
- warm
- not overly helpful
- not structured

Very important:
- keep replies SHORT (under 12 words if possible)
- do NOT always ask a follow-up
- do NOT say "anything else I can help with"
- sometimes just answer and stop
- sometimes ask something simple naturally
- sometimes end casually

Speak like a real person:
- "yeah"
- "of course"
- "no problem"
- "okay"
- "sure"

If conversation feels done:
say something like:
"okay perfect, take care"
"alright sounds good"
"okay, have a great day"

Do NOT sound like customer service training.
`
        },
        ...call.history
      ]
    });

    const reply = completion.choices[0].message.content.trim();
    call.history.push({ role: "assistant", content: reply });

    // 🎤 FEMALE VOICE
    const file = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "nova",
      input: reply
    });

    const fileName = `speech-${Date.now()}.mp3`;
    const filePath = path.join(__dirname, "audio", fileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const audioUrl = `https://taylor-smiles-bot.onrender.com/audio/${fileName}`;

    twiml.play(audioUrl);

    // 🎯 RANDOM HUMAN BEHAVIOR
    const continueConversation = Math.random() > 0.5;

    if (continueConversation) {
      const gather = twiml.gather({
        input: "speech",
        action: "/conversation",
        method: "POST",
        speechTimeout: "auto"
      });
    } else {
      twiml.hangup();
      clearCall(callSid);
    }

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (err) {
    console.error(err);

    const fallback = await generateSpeech("Sorry, something went wrong.");
    const url = `https://taylor-smiles-bot.onrender.com/audio/${fallback}`;

    twiml.play(url);
    twiml.hangup();

    res.type("text/xml");
    res.send(twiml.toString());
  }
});
