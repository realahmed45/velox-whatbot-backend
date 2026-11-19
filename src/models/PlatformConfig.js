const mongoose = require("mongoose");

/**
 * PlatformConfig — tiny key/value store for platform-wide values that are
 * created once at runtime and must survive restarts (e.g. Xendit split-rule
 * ids, one per fee percentage).
 */
const platformConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

platformConfigSchema.statics.get = async function (key) {
  const doc = await this.findOne({ key }).lean();
  return doc ? doc.value : null;
};

platformConfigSchema.statics.set = async function (key, value) {
  await this.updateOne({ key }, { $set: { value } }, { upsert: true });
  return value;
};

module.exports =
  mongoose.models.PlatformConfig || mongoose.model("PlatformConfig", platformConfigSchema);
