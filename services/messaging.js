const axios = require("axios");

async function sendHumanMessage(to, content) {
  try {
    const response = await axios.post(
      "https://api.sendblue.com/api/send-message",
      {
        number: to,
        content: content
      },
      {
        headers: {
          "sb-api-key-id": process.env.SENDBLUE_API_KEY_ID,
          "sb-api-secret-key": process.env.SENDBLUE_API_SECRET_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ Message sent:", response.data);

  } catch (err) {
    console.log("❌ Sendblue ERROR:");
    console.log(err.response?.data || err.message);
  }
}

module.exports = { sendHumanMessage };