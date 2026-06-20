const { body, validationResult } = require('express-validator');

// ─── Allowed English levels ───────────────────────────────────────────────────
const ENGLISH_LEVELS = ['Beginner A1-A2', 'Intermediate B1-B2', 'Advanced C1-C2'];

// ─── Password policy ──────────────────────────────────────────────────────────
// At least 8 characters, 1 uppercase, 1 lowercase, 1 digit, 1 special char
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{8,}$/;

// ─── Registration rules ───────────────────────────────────────────────────────
const registerValidation = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required.')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters.'),

  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required.')
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('password')
    .notEmpty()
    .withMessage('Password is required.')
    .matches(PASSWORD_REGEX)
    .withMessage(
      'Password must be at least 8 characters and include at least one uppercase letter, ' +
      'one lowercase letter, one digit, and one special character.'
    ),

  body('level')
    .notEmpty()
    .withMessage('English level is required.')
    .isIn(ENGLISH_LEVELS)
    .withMessage(`English level must be one of: ${ENGLISH_LEVELS.join(', ')}.`),
];

// ─── Login rules ──────────────────────────────────────────────────────────────
const loginValidation = [
  body('email')
    .trim()
    .notEmpty()
    .withMessage('Email is required.')
    .isEmail()
    .withMessage('Please provide a valid email address.'),

  body('password')
    .notEmpty()
    .withMessage('Password is required.'),
];

// ─── Middleware: collect & return validation errors ───────────────────────────
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({
      success: false,
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
}

module.exports = { registerValidation, loginValidation, handleValidationErrors, ENGLISH_LEVELS };