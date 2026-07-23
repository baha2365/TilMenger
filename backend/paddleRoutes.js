const express = require('express');
const { authenticate } = require('./authMiddleware');
const { getConfig, getStatus, getManageLink } = require('./paddleController');

const router = express.Router();
router.use(authenticate);

router.get('/config',      getConfig);       // client token + price ID for Paddle.js
router.get('/status',      getStatus);       // current user's subscription/trial state
router.get('/manage-link', getManageLink);   // fresh Paddle customer-portal links

module.exports = router;