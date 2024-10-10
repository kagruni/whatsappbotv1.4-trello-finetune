require('dotenv').config();

const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  hubspotAccessToken: process.env.HUBSPOT_ACCESS_TOKEN,
  hubspotOwnerId: process.env.HUBSPOT_OWNER_ID,
};

console.log('Loaded config:', config);

module.exports = config;