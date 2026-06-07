// ─── Role IDs (must match the roles table) ────────────────────────────────────
const ROLE_IDS = {
  student: 1,
  teacher: 2,
  admin:   3,
};

/**
 * Middleware factory — pass the role_ids that are allowed.
 * Reads req.userRoleId set by authMiddleware (comes from the JWT — no DB query).
 *
 * Usage:
 *   router.post('/', authenticate, authorizeRole(ROLE_IDS.teacher, ROLE_IDS.admin), handler)
 *
 * Returns 401 if roleId is missing from the token (old token — ask user to re-login).
 * Returns 403 if the role is not in the allowed list.
 */
function authorizeRole(...allowedRoleIds) {
  return (req, res, next) => {
    const roleId = req.userRoleId;

    if (roleId === undefined || roleId === null) {
      // Token is valid but has no roleId — issued before this feature was added.
      return res.status(401).json({
        success: false,
        message: 'Session outdated. Please log in again to continue.',
      });
    }

    if (!allowedRoleIds.includes(roleId)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only teachers and admins can perform this action.',
      });
    }

    next();
  };
}

module.exports = { authorizeRole, ROLE_IDS };