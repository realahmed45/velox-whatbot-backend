/**
 * EasyPaisa Payment Service — Pakistan Mobile Wallet
 * API Docs: https://easypay.easypaisa.com.pk/
 *
 * EasyPaisa uses OTPV2/Mobile Account payment flow
 * Flow:
 * 1. POST transaction request with hash
 * 2. Customer gets OTP on their EasyPaisa account
 * 3. Customer enters OTP on EasyPaisa app
 * 4. Poll/receive callback for payment status
 */
const axios = require("axios");
const crypto = require("crypto");
const logger = require("../../utils/logger");
const moment = require("moment");

const getConfig = () => ({
  storeId: process.env.EASYPAISA_STORE_ID,
  hashKey: process.env.EASYPAISA_HASH_KEY,
  accountNum: process.env.EASYPAISA_ACCOUNT_NUM,
  apiUrl: process.env.EASYPAISA_API_URL,
  isSandbox: process.env.EASYPAISA_IS_SANDBOX === "true",
});

/**
 * Build EasyPaisa HMAC SHA-256 hash
 */
const buildHash = (params, hashKey) => {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, key) => {
      acc[key] = params[key];
      return acc;
    }, {});
  const hashStr = Object.values(sorted).join("&");
  return crypto
    .createHmac("sha256", hashKey)
    .update(hashStr)
    .digest("hex")
    .toUpperCase();
};

/**
 * Initiate EasyPaisa Mobile Account Payment
 * @param {string} mobileNumber - Customer's EasyPaisa number (03xx format)
 * @param {number} amountPKR - Amount in PKR
 * @param {string} orderRefNum - Unique order reference
 */
const initiatePayment = async ({
  mobileNumber,
  amountPKR,
  orderRefNum,
  description = "Velox-Whatbot",
}) => {
  try {
    const config = getConfig();
    const dateTime = moment().format("YYYYMMDDHHmmss");

    const params = {
      storeId: config.storeId,
      amount: String(amountPKR),
      postBackURL: `${process.env.CLIENT_URL}/billing/payment-callback`,
      orderRefNum,
      expiryDate: moment().add(1, "day").format("YYYYMMDDHHmmss"),
      autoRedirect: "0",
      mobileNum: mobileNumber,
      emailAddress: "",
      merchantPaymentMethod: "MA", // Mobile Account
      desc: description,
      language: "EN",
    };

    params.signature = buildHash(
      { ...params, hashKey: config.hashKey },
      config.hashKey,
    );

    const response = await axios.post(`${config.apiUrl}?payment`, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    const data = response.data;

    // EasyPaisa returns HTML redirect or JSON depending on flow
    const success = data?.responseCode === "0000" || data?.status === "Paid";

    return {
      success,
      responseCode: data?.responseCode,
      responseMessage: data?.responseDesc || data?.message,
      transactionId: data?.transactionId || orderRefNum,
      raw: data,
    };
  } catch (err) {
    logger.error("EasyPaisa payment error", {
      error: err.response?.data || err.message,
    });
    return { success: false, error: err.message };
  }
};

/**
 * Check EasyPaisa transaction status
 */
const checkStatus = async (orderRefNum) => {
  try {
    const config = getConfig();
    const params = {
      storeId: config.storeId,
      orderId: orderRefNum,
      transactionType: "MA",
      encryptionKey: config.hashKey,
    };

    const response = await axios.post(
      `${config.apiUrl}?inquiryPayment`,
      params,
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );

    const data = response.data;
    return {
      success: data?.responseCode === "0000",
      responseCode: data?.responseCode,
      responseMessage: data?.responseDesc,
      status: data?.transactionStatus,
      raw: data,
    };
  } catch (err) {
    logger.error("EasyPaisa check status error", err.message);
    return { success: false, error: err.message };
  }
};

module.exports = { initiatePayment, checkStatus };
