/**
 * Minimal XML-RPC client (no extra dependency) — enough for WuBook's classic
 * Wired API: ints, doubles, booleans, strings, arrays, structs, nil.
 *
 *   const r = await xmlrpcCall(url, "fetch_rooms", [token, lcode]);
 *
 * Throws on HTTP errors and on XML-RPC <fault>.
 */
const axios = require("axios");
const cheerio = require("cheerio");

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function serialize(v) {
  if (v === null || v === undefined) return "<value><string></string></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (v instanceof Date) return `<value><string>${esc(v.toISOString())}</string></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(serialize).join("")}</data></array></value>`;
  if (typeof v === "object") {
    const members = Object.entries(v)
      .map(([k, val]) => `<member><name>${esc(k)}</name>${serialize(val)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${esc(v)}</string></value>`;
}

const buildCall = (method, params = []) =>
  `<?xml version="1.0"?><methodCall><methodName>${esc(method)}</methodName><params>${params
    .map((p) => `<param>${serialize(p)}</param>`)
    .join("")}</params></methodCall>`;

/** Parse one <value> element (cheerio node) into JS. */
function parseValue($, el) {
  const child = $(el).children().first();
  if (!child.length) return $(el).text(); // bare <value>text</value> = string
  const tag = child[0].tagName.toLowerCase();
  const text = child.text();
  switch (tag) {
    case "int":
    case "i4":
    case "i8":
      return parseInt(text, 10);
    case "double":
      return parseFloat(text);
    case "boolean":
      return text.trim() === "1";
    case "string":
      return text;
    case "nil":
      return null;
    case "datetime.iso8601":
      return text;
    case "base64":
      return Buffer.from(text, "base64");
    case "array":
      return child
        .children("data")
        .children("value")
        .toArray()
        .map((v) => parseValue($, v));
    case "struct": {
      const out = {};
      child.children("member").each((_, m) => {
        out[$(m).children("name").text()] = parseValue($, $(m).children("value")[0]);
      });
      return out;
    }
    default:
      return text;
  }
}

function parseResponse(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const fault = $("methodResponse > fault > value");
  if (fault.length) {
    const f = parseValue($, fault[0]) || {};
    const e = new Error(`XML-RPC fault ${f.faultCode}: ${f.faultString}`);
    e.code = f.faultCode;
    throw e;
  }
  const v = $("methodResponse > params > param > value");
  if (!v.length) throw new Error("XML-RPC: empty response");
  return parseValue($, v[0]);
}

async function xmlrpcCall(url, method, params = [], { timeout = 20000 } = {}) {
  const { data } = await axios.post(url, buildCall(method, params), {
    headers: { "Content-Type": "text/xml" },
    timeout,
    responseType: "text",
    transformResponse: (r) => r,
  });
  return parseResponse(data);
}

module.exports = { xmlrpcCall, buildCall, parseResponse, serialize };
