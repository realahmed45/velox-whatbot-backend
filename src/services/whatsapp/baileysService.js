/**
 * Baileys WhatsApp service — QR-scan provider using @whiskeysockets/baileys.
 *
 * One socket per workspace, kept in memory. Auth state persisted to Mongo
 * via the BaileysAuth model so sessions survive dyno restarts.
 *
 * Public surface:
 *   - startSession(workspaceId)        → kicks off a session; returns immediately
 *   - getSessionState(workspaceId)     → { status, qr, phoneNumber, ... }
 *   - sendTextMessage({ workspaceId, to, text })
 *   - sendImageMessage({ workspaceId, to, imageUrl, caption })
 *   - sendDocumentMessage({ workspaceId, to, fileUrl, fileName })
 *   - logout(workspaceId)
 *   - bootstrapSessions()              → reconnect all "connected" workspaces on boot
 */
const path = require("path");
const QRCode = require("qrcode");
const pino = require("pino");
const Workspace = require("../../models/Workspace");
const BaileysAuth = require("../../models/BaileysAuth");
const { processIncomingMessage } = require("../botEngine");
const logger = require("../../utils/logger");

// Baileys is published as ESM only — load it via dynamic import once and
// cache the resulting module so all callers share the same handles.
let _baileysPromise = null;
function loadBaileys() {
  if (!_baileysPromise) {
    _baileysPromise = import("@whiskeysockets/baileys").then((mod) => {
      const m = mod.default && mod.default.makeWASocket ? mod.default : mod;
      return {
        makeWASocket: m.default || m.makeWASocket,
        DisconnectReason: m.DisconnectReason,
        fetchLatestBaileysVersion: m.fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore: m.makeCacheableSignalKeyStore,
        initAuthCreds: m.initAuthCreds,
        BufferJSON: m.BufferJSON,
        proto: m.proto,
      };
    });
  }
  return _baileysPromise;
}

// Silence Baileys' built-in logger
const baileysLogger = pino({ level: "silent" });

// In-memory session map: workspaceId(string) → SessionEntry
// SessionEntry = { sock, status, qrDataUrl, phoneNumber, displayName, lastError, startedAt }
const SESSIONS = new Map();

const STATUSES = {
  CONNECTING: "connecting",
  QR: "qr",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
  LOGGED_OUT: "logged_out",
};

// ──────────────────────────────────────────────────────────
// Mongo-backed auth state (replaces useMultiFileAuthState)
// ──────────────────────────────────────────────────────────
async function useMongoAuthState(workspaceId) {
  const { initAuthCreds, BufferJSON, proto } = await loadBaileys();
  let doc = await BaileysAuth.findOne({ workspaceId });
  if (!doc) {
    doc = await BaileysAuth.create({
      workspaceId,
      creds: initAuthCreds(),
      keys: {},
    });
  }

  // Re-hydrate creds (Buffers were JSON-stringified)
  let creds = doc.creds
    ? JSON.parse(JSON.stringify(doc.creds), BufferJSON.reviver)
    : initAuthCreds();
  let keys = doc.keys
    ? JSON.parse(JSON.stringify(doc.keys), BufferJSON.reviver)
    : {};

  const writeData = async () => {
    try {
      await BaileysAuth.updateOne(
        { workspaceId },
        {
          $set: {
            creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
            keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer)),
          },
        },
      );
    } catch (err) {
      logger.error("[baileys] writeData failed", err);
    }
  };

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = keys?.[type]?.[id];
            if (value) {
              if (type === "app-state-sync-key") {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          }
          return data;
        },
        set: (data) => {
          for (const type of Object.keys(data)) {
            keys[type] = keys[type] || {};
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              if (value) keys[type][id] = value;
              else delete keys[type][id];
            }
          }
          // Fire-and-forget write
          writeData();
        },
      },
    },
    saveCreds: writeData,
    clear: async () => {
      keys = {};
      creds = initAuthCreds();
      await BaileysAuth.deleteOne({ workspaceId });
    },
  };
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
const toJid = (phone) => {
  if (!phone) return null;
  if (phone.includes("@")) return phone;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
};

const safePhone = (jid) => {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
};

const getEntry = (workspaceId) => SESSIONS.get(String(workspaceId));

const setEntry = (workspaceId, patch) => {
  const id = String(workspaceId);
  const cur = SESSIONS.get(id) || {};
  const next = { ...cur, ...patch };
  SESSIONS.set(id, next);
  return next;
};

const clearEntry = (workspaceId) => {
  SESSIONS.delete(String(workspaceId));
};

// ──────────────────────────────────────────────────────────
// Session lifecycle
// ──────────────────────────────────────────────────────────
async function startSession(workspaceId, { reset = false } = {}) {
  const id = String(workspaceId);
  const existing = getEntry(id);
  if (
    existing &&
    (existing.status === STATUSES.CONNECTED ||
      existing.status === STATUSES.QR ||
      existing.status === STATUSES.CONNECTING)
  ) {
    if (!reset) return existing;
    try {
      existing.sock?.end?.();
    } catch (_) {}
    clearEntry(id);
  }

  setEntry(id, {
    status: STATUSES.CONNECTING,
    qrDataUrl: null,
    lastError: null,
    startedAt: Date.now(),
  });

  if (reset) {
    await BaileysAuth.deleteOne({ workspaceId: id });
  }

  const {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
  } = await loadBaileys();
  const auth = await useMongoAuthState(id);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({
    version: undefined,
  }));

  const sock = makeWASocket({
    version,
    auth: {
      creds: auth.state.creds,
      keys: makeCacheableSignalKeyStore(auth.state.keys, baileysLogger),
    },
    logger: baileysLogger,
    printQRInTerminal: false,
    browser: ["Botlify", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  setEntry(id, { sock });

  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
        setEntry(id, { status: STATUSES.QR, qrDataUrl, qrRaw: qr });
        logger.info(`[baileys] QR generated for workspace ${id}`);
      } catch (err) {
        logger.error("[baileys] QR encoding failed", err);
      }
    }

    if (connection === "open") {
      const me = sock.user || {};
      const phone = safePhone(me.id);
      const displayName = me.name || me.verifiedName || null;

      setEntry(id, {
        status: STATUSES.CONNECTED,
        qrDataUrl: null,
        qrRaw: null,
        phoneNumber: phone,
        displayName,
        lastError: null,
      });

      try {
        await Workspace.findByIdAndUpdate(id, {
          $set: {
            "whatsapp.status": "connected",
            "whatsapp.type": "baileys",
            "whatsapp.phoneNumber": phone ? `+${phone}` : undefined,
            "whatsapp.displayName": displayName || undefined,
            "whatsapp.connectedAt": new Date(),
            "whatsapp.lastWebhookAt": new Date(),
            "whatsapp.webhookSubscribed": true,
          },
        });
      } catch (err) {
        logger.error("[baileys] failed to mark workspace connected", err);
      }

      logger.info(`[baileys] connected for workspace ${id} as +${phone}`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const { DisconnectReason: DR } = await loadBaileys();
      const loggedOut = code === DR.loggedOut;

      logger.warn(
        `[baileys] connection closed for ${id} (code=${code}, loggedOut=${loggedOut})`,
      );

      if (loggedOut) {
        setEntry(id, { status: STATUSES.LOGGED_OUT, lastError: "logged_out" });
        try {
          await BaileysAuth.deleteOne({ workspaceId: id });
          await Workspace.findByIdAndUpdate(id, {
            $set: {
              "whatsapp.status": "disconnected",
              "whatsapp.type": "none",
            },
          });
        } catch (_) {}
        clearEntry(id);
      } else {
        // Auto-reconnect after a delay
        setEntry(id, {
          status: STATUSES.DISCONNECTED,
          lastError: code ? `code_${code}` : "unknown",
        });
        setTimeout(() => {
          // Only retry if entry still exists (user didn't disconnect)
          if (SESSIONS.has(id)) {
            startSession(id).catch((e) =>
              logger.error("[baileys] reconnect failed", e),
            );
          }
        }, 4000);
      }
    }
  });

  // Inbound messages → bot engine
  sock.ev.on("messages.upsert", async (m) => {
    if (!m || m.type !== "notify") return;
    for (const msg of m.messages || []) {
      try {
        await handleIncoming(id, sock, msg);
      } catch (err) {
        logger.error("[baileys] handleIncoming failed", err);
      }
    }
  });

  return getEntry(id);
}

async function handleIncoming(workspaceId, sock, msg) {
  if (!msg.message) return;
  if (msg.key?.fromMe) return; // skip our own outbound
  if (msg.key?.remoteJid?.endsWith("@g.us")) return; // skip groups
  if (msg.key?.remoteJid === "status@broadcast") return;

  const phone = safePhone(msg.key.remoteJid);
  if (!phone) return;

  // Extract text/media
  const m = msg.message;
  let text = null;
  let mediaUrl = null;
  let type = "text";

  if (m.conversation) {
    text = m.conversation;
  } else if (m.extendedTextMessage?.text) {
    text = m.extendedTextMessage.text;
  } else if (m.imageMessage) {
    type = "image";
    text = m.imageMessage.caption || "";
    // Note: downloading media requires sock.downloadMediaMessage. For now we
    // just record the message as image without the binary; bot engine sees it.
  } else if (m.videoMessage) {
    type = "video";
    text = m.videoMessage.caption || "";
  } else if (m.audioMessage) {
    type = "audio";
  } else if (m.documentMessage) {
    type = "document";
    text = m.documentMessage.fileName || "";
  } else if (m.buttonsResponseMessage) {
    text =
      m.buttonsResponseMessage.selectedDisplayText ||
      m.buttonsResponseMessage.selectedButtonId ||
      "";
  } else if (m.listResponseMessage) {
    text =
      m.listResponseMessage.title ||
      m.listResponseMessage.singleSelectReply?.selectedRowId ||
      "";
  } else {
    return; // unsupported
  }

  // Mark as read (best effort)
  try {
    await sock.readMessages([msg.key]);
  } catch (_) {}

  // Look up workspace fresh — bot engine expects the full doc
  const workspace = await Workspace.findById(workspaceId);
  if (!workspace) return;

  // Update last-seen
  workspace.whatsapp.lastMessageAt = new Date();
  workspace.whatsapp.lastWebhookAt = new Date();
  workspace.save().catch(() => {});

  await processIncomingMessage({
    workspace,
    phone,
    messageBody: text || "",
    messageType: type,
    mediaUrl,
    senderName: msg.pushName || null,
  });
}

// ──────────────────────────────────────────────────────────
// Public state
// ──────────────────────────────────────────────────────────
function getSessionState(workspaceId) {
  const entry = getEntry(workspaceId);
  if (!entry) return { status: STATUSES.DISCONNECTED };
  return {
    status: entry.status,
    qr: entry.qrDataUrl || null,
    phoneNumber: entry.phoneNumber || null,
    displayName: entry.displayName || null,
    lastError: entry.lastError || null,
  };
}

async function logout(workspaceId) {
  const id = String(workspaceId);
  const entry = getEntry(id);
  if (entry?.sock) {
    try {
      await entry.sock.logout();
    } catch (_) {
      try {
        entry.sock.end?.();
      } catch (_) {}
    }
  }
  clearEntry(id);
  await BaileysAuth.deleteOne({ workspaceId: id });
}

// ──────────────────────────────────────────────────────────
// Sending
// ──────────────────────────────────────────────────────────
async function ensureReady(workspaceId) {
  const entry = getEntry(workspaceId);
  if (!entry || entry.status !== STATUSES.CONNECTED || !entry.sock) {
    throw new Error("Baileys session not connected");
  }
  return entry;
}

async function sendTextMessage({ workspaceId, to, text }) {
  try {
    const { sock } = await ensureReady(workspaceId);
    const jid = toJid(to);
    if (!jid) return { success: false, error: "Invalid recipient" };
    const sent = await sock.sendMessage(jid, { text: String(text || "") });
    return { success: true, messageId: sent?.key?.id || null };
  } catch (err) {
    logger.error("[baileys] sendTextMessage failed", err);
    return { success: false, error: err.message };
  }
}

async function sendImageMessage({ workspaceId, to, imageUrl, caption }) {
  try {
    const { sock } = await ensureReady(workspaceId);
    const jid = toJid(to);
    if (!jid) return { success: false, error: "Invalid recipient" };
    const sent = await sock.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || undefined,
    });
    return { success: true, messageId: sent?.key?.id || null };
  } catch (err) {
    logger.error("[baileys] sendImageMessage failed", err);
    return { success: false, error: err.message };
  }
}

async function sendDocumentMessage({ workspaceId, to, fileUrl, fileName }) {
  try {
    const { sock } = await ensureReady(workspaceId);
    const jid = toJid(to);
    if (!jid) return { success: false, error: "Invalid recipient" };
    const sent = await sock.sendMessage(jid, {
      document: { url: fileUrl },
      fileName: fileName || path.basename(fileUrl) || "file",
      mimetype: "application/octet-stream",
    });
    return { success: true, messageId: sent?.key?.id || null };
  } catch (err) {
    logger.error("[baileys] sendDocumentMessage failed", err);
    return { success: false, error: err.message };
  }
}

// ──────────────────────────────────────────────────────────
// Server boot — reconnect all workspaces that were connected
// ──────────────────────────────────────────────────────────
async function bootstrapSessions() {
  if (process.env.BAILEYS_DISABLE === "1") return;
  try {
    const workspaces = await Workspace.find({
      "whatsapp.type": "baileys",
      "whatsapp.status": "connected",
    }).select("_id");

    if (!workspaces.length) {
      logger.info("[baileys] no sessions to bootstrap");
      return;
    }

    logger.info(`[baileys] bootstrapping ${workspaces.length} session(s)`);
    for (const ws of workspaces) {
      // Stagger to avoid hammering WA endpoints simultaneously
      setTimeout(() => {
        startSession(ws._id).catch((err) =>
          logger.error(`[baileys] bootstrap failed for ${ws._id}`, err),
        );
      }, Math.random() * 5000);
    }
  } catch (err) {
    logger.error("[baileys] bootstrapSessions error", err);
  }
}

module.exports = {
  startSession,
  getSessionState,
  logout,
  sendTextMessage,
  sendImageMessage,
  sendDocumentMessage,
  bootstrapSessions,
  STATUSES,
};
