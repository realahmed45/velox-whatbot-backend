const jwt = require("jsonwebtoken");
const asyncHandler = require("express-async-handler");
const User = require("../models/User");
const Workspace = require("../models/Workspace");

// Verify JWT and attach user to request
const protect = asyncHandler(async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    res.status(401);
    throw new Error("Not authorized — no token");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) {
      res.status(401);
      throw new Error("Not authorized — user not found");
    }

    next();
  } catch (err) {
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      res.status(401);
      throw new Error("Not authorized — invalid or expired token");
    }
    throw err;
  }
});

// Attach workspace to request and verify membership
const requireWorkspace = asyncHandler(async (req, res, next) => {
  const workspaceId = req.headers["x-workspace-id"] || req.params.workspaceId;

  if (!workspaceId) {
    res.status(400);
    throw new Error("Workspace ID required");
  }

  const workspace = await Workspace.findById(workspaceId);

  if (!workspace) {
    res.status(404);
    throw new Error("Workspace not found");
  }

  // Verify the user is a member of this workspace
  const isOwner = workspace.owner.toString() === req.user._id.toString();
  const isMember = workspace.members.some(
    (m) => m.user.toString() === req.user._id.toString(),
  );

  if (!isOwner && !isMember) {
    res.status(403);
    throw new Error("Access denied — you are not a member of this workspace");
  }

  req.workspace = workspace;

  // Attach user role + granted permissions for this workspace.
  if (isOwner) {
    req.workspaceRole = "owner";
    req.workspacePermissions = null; // owner => all permissions
  } else {
    const member = workspace.members.find(
      (m) => m.user.toString() === req.user._id.toString(),
    );
    req.workspaceRole = member?.role || "agent";
    req.workspacePermissions = member?.permissions || [];
  }

  next();
});

// Only workspace owner can access
const requireOwner = (req, res, next) => {
  if (req.workspaceRole !== "owner") {
    res.status(403);
    throw new Error("Only the workspace owner can perform this action");
  }
  next();
};

/**
 * Gate a route on a permission. Owners always pass; agents must have the key
 * in their granted permissions. Use AFTER requireWorkspace.
 *   router.post("/x", requireWorkspace, requirePermission("automations"), h)
 */
const requirePermission = (permission) => (req, res, next) => {
  if (req.workspaceRole === "owner") return next();
  const perms = req.workspacePermissions || [];
  if (perms.includes(permission)) return next();
  res.status(403);
  throw new Error(
    "You don't have permission to do this. Ask the workspace owner for access.",
  );
};

module.exports = {
  protect,
  requireWorkspace,
  requireOwner,
  requirePermission,
};
