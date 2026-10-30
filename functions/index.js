const { onRequest } = require("firebase-functions/v2/https");
const { createApp } = require("./app");

exports.api = onRequest({
  region: "us-central1",
  memory: "512MiB",
  timeoutSeconds: 300,
  invoker: "public",
  cors: true,
}, createApp());
