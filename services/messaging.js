
const axios = require("axios");

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function humanize(text) {
  return text.replace(/—/g, "").replace(/\s+/g, " ").trim();
}

async function sendHumanMessage(to, text) {
  const parts = humanize(text).split("\n\n");

  for (let part of parts) {
    const typing = Math.min(1500 + part.length * 20, 4000);
    await delay(typing);

    await axios.post("https://api.sendblue.co/api/send-message", {
      number: to,
      content: part,
      from_number: process.env.SENDBLUE_PHONE_NUMBER
    }, {
      headers: {
        "SB-API-KEY-ID": process.env.SENDBLUE_API_KEY_ID,
        "SB-API-SECRET-KEY": process.env.SENDBLUE_API_SECRET_KEY
      }
    });

    await delay(800);
  }
}

module.exports = { sendHumanMessage };
