/**
 * JazzCash Payment Service — Pakistan Mobile Wallet
 * API Docs: https://sandbox.jazzcash.com.pk/Sandbox/Docs
 *
 * Flow:
 * 1. Build transaction params with HMAC-SHA256 hash
 * 2. POST to JazzCash API
 * 3. Check response code: 000 = Success
 */
const axios = require("axios");
const { buildJazzCashHash } = require("../../utils/crypto");
const logger = require("../../utils/logger");
const moment = require("moment");

const getConfig = () => ({
  merchantId: process.env.JAZZCASH_MERCHANT_ID,
  password: process.env.JAZZCASH_PASSWORD,
  integritySalt: process.env.JAZZCASH_INTEGRITY_SALT,
  apiUrl: process.env.JAZZCASH_API_URL,
  isSandbox: process.env.JAZZCASH_IS_SANDBOX === "true",
});

/**
 * Initiate a Mobile Account (MWALLET) payment
 * @param {string} mobileNumber - Customer's JazzCash number (e.g. 03001234567)
 * @param {number} amountPKR - Amount in PKR
 * @param {string} txnRefNo - Unique transaction reference
 * @param {string} description - Bill reference / description
 */
const initiatePayment = async ({
  mobileNumber,
  amountPKR,
  txnRefNo,
  description = "Velox-Whatbot Subscription",
}) => {
  try {
    const config = getConfig();
    const dateTime = moment().format("YYYYMMDDHHmmss");
    const expiryDateTime = moment().add(1, "hour").format("YYYYMMDDHHmmss");

    const params = {
      pp_Version: "1.1",
      pp_TxnType: "MWALLET",
      pp_Language: "EN",
      pp_MerchantID: config.merchantId,
      pp_Password: config.password,
      pp_MobileNumber: mobileNumber.replace(/^0/, "92"), // Convert 03xx to 923xx
      pp_CNIC: "",
      pp_TxnRefNo: txnRefNo,
      pp_Amount: String(amountPKR * 100), // JazzCash uses paisas (multiply by 100)
      pp_TxnCurrency: "PKR",
      pp_TxnDateTime: dateTime,
      pp_BillReference: description,
      pp_Description: description,
      pp_TxnExpiryDateTime: expiryDateTime,
      pp_ReturnURL: `${process.env.CLIENT_URL}/billing/payment-callback`,
      pp_SecureHash: "",
    };

    // Build hash (remove pp_SecureHash from hash calculation)
    const { pp_SecureHash, ...hashParams } = params;
    params.pp_SecureHash = buildJazzCashHash(hashParams, config.integritySalt);

    const response = await axios.post(config.apiUrl, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    const data = response.data;
    const success = data.pp_ResponseCode === "000";

    return {
      success,
      responseCode: data.pp_ResponseCode,
      responseMessage: data.pp_ResponseMessage,
      transactionId: data.pp_TxnRefNo,
      amount: data.pp_Amount,
      raw: data,
    };
  } catch (err) {
    logger.error("JazzCash payment error", {
      error: err.response?.data || err.message,
    });
    return { success: false, error: err.message };
  }
};

/**
 * Verify transaction status
 */
const verifyTransaction = async (txnRefNo) => {
  try {
    const config = getConfig();
    const params = {
      pp_Version: "1.1",
      pp_TxnType: "MWALLET",
      pp_Language: "EN",
      pp_MerchantID: config.merchantId,
      pp_Password: config.password,
      pp_TxnRefNo: txnRefNo,
      pp_SecureHash: "",
    };

    const { pp_SecureHash, ...hashParams } = params;
    params.pp_SecureHash = buildJazzCashHash(hashParams, config.integritySalt);

    // Status inquiry endpoint
    const statusUrl = config.apiUrl.replace(
      "DoMWalletTransaction",
      "GetTransactionStatus",
    );
    const response = await axios.post(statusUrl, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    const data = response.data;
    return {
      success: data.pp_ResponseCode === "000",
      responseCode: data.pp_ResponseCode,
      responseMessage: data.pp_ResponseMessage,
      raw: data,
    };
  } catch (err) {
    logger.error("JazzCash verify error", err.message);
    return { success: false, error: err.message };
  }
};

module.exports = { initiatePayment, verifyTransaction };
