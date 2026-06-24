/**
 * Botlify — Database Indexes for Performance
 * Run this once to optimize query performance
 */
const mongoose = require("mongoose");
const logger = require("../utils/logger");

const createIndexes = async () => {
  try {
    const db = mongoose.connection.db;

    logger.info("[DB] Creating performance indexes...");

    // Messages collection - most queried
    await db
      .collection("messages")
      .createIndex({ conversationId: 1, createdAt: -1 });
    await db
      .collection("messages")
      .createIndex({ workspaceId: 1, createdAt: -1 });
    await db
      .collection("messages")
      .createIndex({ direction: 1, createdAt: -1 });

    // Conversations collection
    await db
      .collection("conversations")
      .createIndex({ workspaceId: 1, updatedAt: -1 });
    await db.collection("conversations").createIndex({ contactId: 1 });
    await db
      .collection("conversations")
      .createIndex({ status: 1, workspaceId: 1 });

    // Contacts collection - heavily queried
    await db
      .collection("contacts")
      .createIndex({ workspaceId: 1, instagramId: 1 }, { unique: true });
    await db
      .collection("contacts")
      .createIndex({ workspaceId: 1, username: 1 });
    await db.collection("contacts").createIndex({ workspaceId: 1, tags: 1 });
    await db
      .collection("contacts")
      .createIndex({ workspaceId: 1, createdAt: -1 });

    // Flows collection
    await db.collection("flows").createIndex({ workspaceId: 1, status: 1 });
    await db.collection("flows").createIndex({ workspaceId: 1, type: 1 });

    // Webhook integrations
    await db
      .collection("webhookintegrations")
      .createIndex({ workspaceId: 1, enabled: 1 });
    await db
      .collection("webhookintegrations")
      .createIndex({ workspaceId: 1, events: 1 });

    // Broadcasts
    await db
      .collection("broadcastcampaigns")
      .createIndex({ workspaceId: 1, status: 1 });
    await db
      .collection("broadcastcampaigns")
      .createIndex({ workspaceId: 1, scheduledAt: 1 });

    // Drip campaigns
    await db
      .collection("dripcampaigns")
      .createIndex({ workspaceId: 1, status: 1 });
    await db
      .collection("dripcampaigns")
      .createIndex({ workspaceId: 1, triggerTag: 1 });

    // Orders
    await db
      .collection("orders")
      .createIndex({ workspaceId: 1, createdAt: -1 });
    await db.collection("orders").createIndex({ contactId: 1, status: 1 });

    // Users collection
    await db.collection("users").createIndex({ email: 1 }, { unique: true });

    // Workspaces collection
    await db.collection("workspaces").createIndex({ "members.userId": 1 });

    logger.info("[DB] ✅ All indexes created successfully!");

    // List all indexes for verification
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      const indexes = await db.collection(col.name).indexes();
      logger.info(`[DB] ${col.name}: ${indexes.length} indexes`);
    }
  } catch (err) {
    logger.error("[DB] Index creation failed", { error: err.message });
    throw err;
  }
};

module.exports = { createIndexes };
