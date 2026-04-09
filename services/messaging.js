const axios = require("axios");

const SENDBLUE_HEADERS = {
  "sb-api-key-id": process.env.SENDBLUE_API_KEY_ID,
  "sb-api-secret-key": process.env.SENDBLUE_API_SECRET_KEY,
  "Content-Type": "application/json"
};

/* ─── Send a plain text message ─────────────────────────────── */
async function sendHumanMessage(to, content) {
  try {
    const response = await axios.post(
      "https://api.sendblue.com/api/send-message",
      { number: to, content },
      { headers: SENDBLUE_HEADERS }
    );
    console.log("✅ Message sent:", response.data);
  } catch (err) {
    console.log("❌ Sendblue ERROR:", err.response?.data || err.message);
  }
}

/* ─── Forward an image URL to another number ────────────────── */
async function forwardImage(to, mediaUrl, caption) {
  try {
    const body = { number: to, media_url: mediaUrl };
    if (caption) body.content = caption;

    const response = await axios.post(
      "https://api.sendblue.com/api/send-message",
      body,
      { headers: SENDBLUE_HEADERS }
    );
    console.log("✅ Image forwarded:", response.data);
  } catch (err) {
    console.log("❌ Sendblue image forward ERROR:", err.response?.data || err.message);
  }
}

module.exports = { sendHumanMessage, forwardImage };