# WhatsApp Chatbot Documentation

## Project Overview

This project implements a WhatsApp chatbot using Node.js, Express, and the OpenAI GPT-3.5 model. The bot is designed to handle incoming messages from WhatsApp, process them using AI, and send appropriate responses back to users.

## Key Components

1. Express server
2. WhatsApp Business API integration
3. OpenAI GPT-3.5 model integration
4. Conversation history management

## Development Process

### Version 0.1

Initial setup of the project structure and basic Express server.

- Created `app.js`, `config.js`, and `.env` files
- Installed necessary dependencies: express, dotenv, axios, openai

### Version 0.2

Implemented basic webhook handling for WhatsApp.

- Added GET route for webhook verification
- Added POST route for receiving messages

### Version 0.3

Integrated OpenAI API for generating responses.

- Implemented `handleMessage` function to process incoming messages
- Added OpenAI API call to generate responses

### Version 0.4

Improved error handling and logging.

- Added more detailed logging throughout the application
- Improved error messages for better debugging

### Version 0.5

Implemented conversation history.

- Added `conversationHistory` Map to store user interactions
- Modified `handleMessage` function to use conversation history in OpenAI API calls

### Version 0.6

Refined the bot's responses and added basic command handling.

- Implemented handling for specific commands ('help', 'products', 'contact')
- Updated the system message to provide more context to the AI

## Final Code Structure

### app.js

```javascript
const express = require('express');
const axios = require('axios');
const { Configuration, OpenAIApi } = require('openai');
const config = require('./config');

const app = express();
app.use(express.json());

const openai = new OpenAIApi(new Configuration({
  apiKey: config.openaiApiKey,
}));

const PORT = process.env.PORT || 3000;

const conversationHistory = new Map();

const SYSTEM_MESSAGE = `
You are an AI assistant for a WhatsApp business account. Your role is to:
1. Provide helpful and concise information about the company's products and services.
2. Answer customer queries politely and professionally.
3. Escalate complex issues to human support when necessary.
4. Understand and respond to specific commands like 'help', 'products', or 'contact'.
Always maintain a friendly and professional tone.
`;

app.get('/webhook', (req, res) => {
  console.log('Received GET request to /webhook');
  console.log('Query parameters:', req.query);

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('Mode:', mode);
  console.log('Token:', token);
  console.log('Challenge:', challenge);

  if (mode && token) {
    if (mode === 'subscribe' && token === config.whatsappVerifyToken) {
      console.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.log('Webhook verification failed');
      console.log('Expected token:', config.whatsappVerifyToken);
      res.sendStatus(403);
    }
  } else {
    console.log('Missing mode or token');
    res.sendStatus(400);
  }
});

app.post('/webhook', async (req, res) => {
  console.log('Received POST request to /webhook');
  try {
    const { body } = req;
    
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            for (const message of change.value.messages) {
              await handleMessage(message);
            }
          }
        }
      }
    }
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

async function handleMessage(message) {
  console.log('Processing message:', message);
  if (message.type === 'text') {
    try {
      const userId = message.from;
      let userHistory = conversationHistory.get(userId) || [];
      const userMessage = message.text.body.toLowerCase();

      // Handle specific commands
      if (userMessage === 'help') {
        await sendWhatsAppMessage(userId, "Welcome! I can assist you with product information, answer questions, or connect you with human support. Try asking about our 'products' or say 'contact' for human assistance.");
        return;
      } else if (userMessage === 'products') {
        await sendWhatsAppMessage(userId, "We offer a range of products including X, Y, and Z. Which would you like to know more about?");
        return;
      } else if (userMessage === 'contact') {
        await sendWhatsAppMessage(userId, "I'll connect you with a human support agent shortly. In the meantime, can you please describe your issue?");
        // Here you would typically trigger a notification to your human support team
        return;
      }

      userHistory.push({ role: "user", content: message.text.body });
      
      // Limit history to last 10 messages
      if (userHistory.length > 10) {
        userHistory = userHistory.slice(-10);
      }
      
      const response = await openai.createChatCompletion({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: SYSTEM_MESSAGE },
          ...userHistory
        ],
        max_tokens: 150
      });
      
      const aiResponse = response.data.choices[0].message.content.trim();
      userHistory.push({ role: "assistant", content: aiResponse });
      
      conversationHistory.set(userId, userHistory);
      
      await sendWhatsAppMessage(userId, aiResponse);
    } catch (error) {
      console.error('Error generating AI response:', error);
      await sendWhatsAppMessage(message.from, "I apologize, but I'm having trouble processing your request at the moment. Could you please try again later or contact our support team for assistance?");
    }
  } else {
    await sendWhatsAppMessage(message.from, "I apologize, but I can only process text messages at the moment. If you need assistance, please send your query as a text message.");
  }
}

async function sendWhatsAppMessage(to, text) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${config.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.whatsappToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent successfully:', response.data);
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Configuration loaded:', {
    openaiApiKey: config.openaiApiKey ? 'Set' : 'Not set',
    whatsappToken: config.whatsappToken ? 'Set' : 'Not set',
    whatsappPhoneNumberId: config.whatsappPhoneNumberId,
    whatsappVerifyToken: config.whatsappVerifyToken
  });
});
```

### config.js

```javascript
require('dotenv').config();

const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  whatsappToken: process.env.WHATSAPP_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN
};

module.exports = config;
```

### .env

```
OPENAI_API_KEY=your_openai_api_key_here
WHATSAPP_TOKEN=your_whatsapp_token_here
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id_here
WHATSAPP_VERIFY_TOKEN=your_custom_verify_token_here
```

## Setup and Running

1. Install dependencies: `npm install`
2. Set up environment variables in `.env` file
3. Run the server: `npm start`

## Webhook Setup

1. Set up a WhatsApp Business account and obtain necessary credentials
2. Use a service like ngrok to expose your local server to the internet
3. Configure the webhook URL in the Meta Developer Portal, using the ngrok URL + '/webhook'
4. Use the WHATSAPP_VERIFY_TOKEN from your .env file when setting up the webhook

## Future Improvements

- Implement a knowledge base for faster and more accurate responses
- Add support for handling media messages
- Implement more sophisticated conversation management
- Add analytics and monitoring

This documentation covers the development process and final state of the WhatsApp chatbot up to the point specified. It provides a solid foundation for understanding the project structure and functionality.
