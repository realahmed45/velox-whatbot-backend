const CryptoJS = require("crypto-js");

const SECRET = process.env.AES_SECRET_KEY;

if (!SECRET && process.env.NODE_ENV === "production") {
  throw new Error(
    "AES_SECRET_KEY environment variable is required in production",
  );
}

const encrypt = (plainText) => {
  if (!plainText) return null;
  return CryptoJS.AES.encrypt(plainText, SECRET).toString();
};

const decrypt = (cipherText) => {
  if (!cipherText) return null;
  const bytes = CryptoJS.AES.decrypt(cipherText, SECRET);
  return bytes.toString(CryptoJS.enc.Utf8);
};

module.exports = { encrypt, decrypt };
