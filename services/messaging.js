const axios = require("axios");

async function sendHumanMessage(to, content) {
  try {
    await axios.post("https://api.sendblue.com/api/send-message", {
      number: to,
      content
    }, {
      headers: {
        "sb-api-key-id": process.env.SENDBLUE_KEY_ID,
        "sb-api-secret-key": process.env.SENDBLUE_SECRET_KEY,
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.log("Send error:", err.response?.data || err.message);
  }
}

module.exports = { sendHumanMessage };