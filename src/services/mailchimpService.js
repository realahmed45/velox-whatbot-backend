/**
 * Mailchimp integration service (G5).
 * Forward Instagram-captured emails to a Mailchimp audience list.
 *
 * Mailchimp API docs:
 *   POST https://{dc}.api.mailchimp.com/3.0/lists/{list_id}/members
 *
 * Auth: HTTP Basic with user="anystring", password=api_key
 * `dc` (datacenter) is the suffix of the API key after "-".
 */
const axios = require("axios");
const logger = require("../utils/logger");

const getDc = (apiKey) => {
  const idx = apiKey.lastIndexOf("-");
  return idx > 0 ? apiKey.slice(idx + 1) : null;
};

const client = (apiKey, serverPrefix) => {
  const dc = serverPrefix || getDc(apiKey);
  if (!dc)
    throw new Error("Invalid Mailchimp API key — missing datacenter suffix");
  return axios.create({
    baseURL: `https://${dc}.api.mailchimp.com/3.0`,
    auth: { username: "botlify", password: apiKey },
    timeout: 10000,
  });
};

const testConnection = async (apiKey, serverPrefix) => {
  try {
    const c = client(apiKey, serverPrefix);
    const { data } = await c.get("/ping");
    return { ok: true, health: data.health_status };
  } catch (err) {
    return {
      ok: false,
      error: err.response?.data?.detail || err.message,
    };
  }
};

const listAudiences = async (apiKey, serverPrefix) => {
  const c = client(apiKey, serverPrefix);
  const { data } = await c.get("/lists", { params: { count: 50 } });
  return (data.lists || []).map((l) => ({
    id: l.id,
    name: l.name,
    members: l.stats?.member_count || 0,
  }));
};

const subscribe = async (
  apiKey,
  serverPrefix,
  listId,
  { email, firstName, lastName, tags = [], source = "Botlify/Instagram" } = {},
) => {
  try {
    const c = client(apiKey, serverPrefix);
    const { data } = await c.post(`/lists/${listId}/members`, {
      email_address: email,
      status: "subscribed",
      merge_fields: {
        FNAME: firstName || "",
        LNAME: lastName || "",
      },
      tags,
      marketing_permissions: [],
      ip_signup: "",
      language: "",
      source,
    });
    return { ok: true, id: data.id };
  } catch (err) {
    const detail = err.response?.data?.title || err.message;
    // Duplicate = already subscribed. Not an error.
    if (err.response?.status === 400 && /already a list member/i.test(detail)) {
      return { ok: true, duplicate: true };
    }
    logger.warn(`[mailchimp] subscribe failed: ${detail}`);
    return { ok: false, error: detail };
  }
};

module.exports = { testConnection, listAudiences, subscribe };
