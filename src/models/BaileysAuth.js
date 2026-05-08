/**
 * BaileysAuth — persists Baileys credentials and signal keys per workspace.
 *
 * Baileys' default `useMultiFileAuthState` writes hundreds of files to disk,
 * which doesn't survive Render dyno restarts. We replace it with a single
 * Mongo document per workspace: `creds` + a sparse `keys` map.
 */
const mongoose = require("mongoose");

const baileysAuthSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      unique: true,
      index: true,
    },
    // Baileys creds object — JSON with Buffers/keys serialised through the
    // BufferJSON helpers exported by Baileys.
    creds: { type: mongoose.Schema.Types.Mixed, default: null },
    // keys: { [type]: { [id]: serializedValue } }
    keys: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, minimize: false },
);

module.exports =
  mongoose.models.BaileysAuth ||
  mongoose.model("BaileysAuth", baileysAuthSchema);
