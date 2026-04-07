
require("dotenv").config();
const express = require("express");
const smsRoute = require("./routes/sms");

const app = express();
app.use(express.json());

app.use("/sms", smsRoute);

app.listen(3000, () => {
  console.log("ELITE CLOSER SYSTEM LIVE 🚀");
});
