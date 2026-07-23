const express = require('express');
const { handleWebhook } = require('./paddleController');

const router = express.Router();

// Needs the RAW request body to verify Paddle's HMAC signature — must be
// mounted in server.js BEFORE app.use(express.json()), otherwise Express
// will have already parsed (and re-serialized) the body and the signature
// will never match what Paddle signed. See server_integration_notes.md.
router.post('/', express.raw({ type: 'application/json' }), handleWebhook);

module.exports = router;