const express = require('express');
const app = express();
app.use(express.json());
const axios = require('axios');
const OpenAI = require('openai');
const config = require('./config');
const fs = require('fs');
const fsPromises = require('fs').promises;
const csv = require('csv-parser');
const path = require('path');
const Trello = require('trello-node-api');
const trello = new Trello(process.env.TRELLO_API_KEY, process.env.TRELLO_TOKEN);
const cron = require('node-cron');
const { exec } = require('child_process');
const crypto = require('crypto');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY // This key should be in your .env file
});
const PORT = process.env.PORT || 3000;
const STATUS_FILE_PATH = path.join(__dirname, '..', 'lead_status.json');
const leadInfo = new Map();
const BOARD_ID = process.env.TRELLO_BOARD_ID;
const INCOMING_LIST_ID = process.env.TRELLO_INCOMING_LIST_ID;
const LEADS_LIST_ID = process.env.TRELLO_LEADS_LIST_ID;

const MAX_INITIATED_CONVERSATIONS = 950;
const MAX_DELIVERED_CONVERSATIONS = 950;
let initiatedConversationCount = 0;
let deliveredConversationCount = 0;
let pendingDeliveryCount = 0;
let failedDeliveryCount = 0;
let totalInitiatedConversations = 0;

function printConversationStatistics() {
  console.log('\n==== Conversation Statistics ====');
  console.log(`Total Initiated: ${totalInitiatedConversations}`);
  console.log(`Delivered: ${deliveredConversationCount}`);
  console.log(`Pending Deliveries: ${pendingDeliveryCount}`);
  console.log(`Failed Deliveries: ${failedDeliveryCount}`);
  console.log('==================================\n');
}


// ... (keep your existing imports and configurations)
const server = app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  console.log('Configuration loaded:', 
    printConversationStatistics(),
    {
      openaiApiKey: config.openaiApiKey ? 'Set' : 'Not set',
      whatsappToken: config.whatsappToken ? 'Set' : 'Not set',
      whatsappPhoneNumberId: config.whatsappPhoneNumberId,
      whatsappVerifyToken: config.whatsappVerifyToken
    }
  );
  try {
    // Load leads from CSV
    leads = await loadLeadsFromCSV('../leads.csv');
    if (leads.length === 0) {
      console.warn('No valid, uncontacted leads found in CSV. Check the file format and content.');
    } else {
      console.log(`Loaded ${leads.length} leads from CSV`);
    }

    // Start initial conversation initiation process
    await initiateConversations();

    // Schedule future conversation initiations
    scheduleConversationInitiation();
  } catch (error) {
    console.error('Error during startup:', error);
  }
});

// Add graceful shutdown handling
process.on('SIGINT', () => {
  console.log('SIGINT signal received. Shutting down gracefully.');
  server.close(() => {
    console.log('Server closed. Exiting process.');
    process.exit(0);
  });
});


function loadLeadStatus() {
  console.log('Attempting to load lead status from:', STATUS_FILE_PATH);
  try {
    if (fs.existsSync(STATUS_FILE_PATH)) {
      const data = fs.readFileSync(STATUS_FILE_PATH, 'utf8');
      
      // Check if the file is empty
      if (data.trim() === '') {
        console.log('Lead status file is empty, initializing new object');
        return {};
      }
      
      console.log('Lead status loaded successfully');
      return JSON.parse(data);
    } else {
      console.log('No existing lead status file found, creating a new one');
      saveLeadStatus({});
      return {};
    }
  } catch (error) {
    console.error('Error loading lead status:', error);
    return {};
  }
}

function saveLeadStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE_PATH, JSON.stringify(status, null, 2));
    console.log('Lead status saved to:', STATUS_FILE_PATH);
    console.log('Current lead status:', JSON.stringify(status, null, 2));
  } catch (error) {
    console.error('Error saving lead status:', error);
  }
}

async function markLeadAsContacted(phone, status = 'contacted') {
  const phoneNumber = phone.replace(/\D/g, '');
  let currentStatus;
  try {
    currentStatus = await loadLeadStatus();
  } catch (error) {
    console.error('Error loading lead_status.json:', error);
    currentStatus = {};
  }

  // Only update if the number doesn't exist or if it's not already marked as contacted
  if (!currentStatus[phoneNumber] || !currentStatus[phoneNumber].contacted) {
    currentStatus[phoneNumber] = {
      contacted: true,
      timestamp: new Date().toISOString(),
      status: status
    };

    try {
      await fs.writeFile(STATUS_FILE_PATH, JSON.stringify(currentStatus, null, 2));
      console.log(`Updated local status for ${phoneNumber}: ${status}`);
      // Remove the call to updateLeadStatusOnGitHub()
    } catch (error) {
      console.error('Error updating local lead_status.json:', error);
    }
  } else {
    console.log(`Skipped update for ${phoneNumber}: already contacted`);
  }
}


function loadLeadsFromCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    const leadStatus = loadLeadStatus();
    
    fs.createReadStream(path.resolve(__dirname, filePath))
      .pipe(csv({ separator: ';', headers: ['name', 'phone'] }))
      .on('data', (data) => {
        let { name, phone } = data;
        
        if (name && phone) {
          phone = phone.replace(/\D/g, '');
          if (phone.length > 0 && !leadStatus[phone]?.contacted) {
            results.push({ name, phone });
            leadInfo.set(phone, { name }); // Store lead info
          } else if (leadStatus[phone]?.contacted) {
            console.log(`Skipping previously contacted lead: ${name} (${phone})`);
          } else {
            console.warn('Skipping lead with invalid phone number:', { name, phone });
          }
        } else {
          console.warn('Skipping invalid lead:', data);
        }
      })
      .on('end', () => {
        console.log(`Loaded ${results.length} valid, uncontacted leads from CSV`);
        resolve(results);
      })
      .on('error', (error) => {
        console.error('Error reading CSV:', error);
        reject(error);
      });
  });
}


function autoDetectSeparator(filePath) {
  const firstLine = fs.readFileSync(path.resolve(__dirname, filePath), 'utf8').split('\n')[0];
  if (firstLine.includes(';')) return ';';
  if (firstLine.includes(',')) return ',';
  if (firstLine.includes('\t')) return '\t';
  return ','; // default to comma if can't detect
}


async function initiateConversations() {
  console.time('Total execution time');

  if (!leads || leads.length === 0) {
    console.log('No leads to process. Exiting initiateConversations.');
    return;
  }

  console.log('Leads loaded:', leads);
  console.log(`Starting to initiate conversations with ${leads.length} leads`);

  let batchNumber = 0;

  while (deliveredConversationCount < MAX_DELIVERED_CONVERSATIONS && initiatedConversationCount < leads.length) {
    batchNumber++;
    const batchSize = Math.min(
      MAX_INITIATED_CONVERSATIONS - initiatedConversationCount,
      MAX_DELIVERED_CONVERSATIONS - deliveredConversationCount,
      leads.length - initiatedConversationCount
    );

    console.time(`Batch ${batchNumber} (${initiatedConversationCount + 1} to ${initiatedConversationCount + batchSize})`);
    console.log(`Initiating batch of ${batchSize} conversations`);

    const batch = leads.slice(initiatedConversationCount, initiatedConversationCount + batchSize);
    await initiateBatch(batch);

    initiatedConversationCount += batchSize;
    pendingDeliveryCount += batchSize;

    console.timeEnd(`Batch ${batchNumber} (${initiatedConversationCount + 1 - batchSize} to ${initiatedConversationCount})`);
    console.log(`Current stats - Initiated: ${initiatedConversationCount}, Delivered: ${deliveredConversationCount}, Pending: ${pendingDeliveryCount}`);

    // Wait for rate limit interval before next batch
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_INTERVAL));
  }

  // Add a final delay to allow for last status updates
  await new Promise(resolve => setTimeout(resolve, 10000));

  console.timeEnd('Total execution time');
  console.log(`Final stats - Total initiated: ${initiatedConversationCount}, Total delivered: ${deliveredConversationCount}`);
}

async function initiateBatch(batch) {
  const promises = batch.map(async (lead) => {
    try {
      const phoneNumber = lead.phone.replace(/\D/g, '');
      console.log(`Attempting to send message to ${lead.name} (${phoneNumber})`);

      // Mark as contacted before sending the message
      await markLeadAsContacted(phoneNumber, 'initiated');
      console.log(`Marked ${lead.name} (${phoneNumber}) as contacted (initiated)`);

      const messageId = await sendWhatsAppTemplateMessage(phoneNumber, [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: lead.name }
          ]
        }
      ], 'https://cdn.prod.website-files.com/61c8fe65a3d5862d16a2e8d1/65d8a45e328cb9284e0af640_Yellow%20Modern%20Real%20Estate%20(Flyer).jpg');

      lead.messageId = messageId;
      lead.deliveryStatus = 'pending';
      pendingDeliveryCount++;

      console.log(`Initiated conversation with ${lead.name} (${phoneNumber}). MessageId: ${messageId}`);

      // Update status to 'sent' after successful message send
      await markLeadAsContacted(phoneNumber, 'sent');
      console.log(`Updated ${lead.name} (${phoneNumber}) status to sent`);

    } catch (error) {
      console.error(`Failed to send message to ${lead.name} (${lead.phone}):`, error.message);
      lead.deliveryStatus = 'failed';
      failedDeliveryCount++;
      
      // Even if sending fails, the lead is still marked as contacted
      await markLeadAsContacted(lead.phone, 'failed');
      console.log(`Updated ${lead.name} (${lead.phone}) status to failed`);
    }
  });

  await Promise.all(promises);
  
  printConversationStatistics();
}

function waitForPendingDeliveries() {
  return new Promise((resolve) => {
    const checkPending = () => {
      if (pendingDeliveryCount === 0) {
        resolve();
      } else {
        setTimeout(checkPending, 5000); // Check every 5 seconds
      }
    };
    checkPending();
  });
}

const conversationHistory = new Map();

const SYSTEM_MESSAGE = `
Role:
You are an AI assistant representing MP Concepts. Your goal is to interact with potential clients, providing concise yet informative responses about the company’s services, pricing, and products. Ensure responses are brief and to the point, focusing on essential details, and avoid lengthy explanations unless specifically requested by the client.

Context:
MP Concepts specializes in high-quality craftsmanship and luxury home renovations. The company offers services such as marble, tiles, sanitary ware, interior design, and full home renovation. The focus is on delivering German-quality materials and workmanship at various price points.

Key Information:

	•	Company Overview:
MP Concepts brings German-quality craftsmanship to Dubai with luxury home renovation services.
	•	Services:
	•	Marble, tiles, and sanitary ware
	•	Interior design, landscaping, and full fit-outs
	•	Kitchen, wardrobes, and windows
	•	Package Options:
	•	Standard: Budget-friendly finishes and design.
	•	Upscale: High-end materials and German appliances.
	•	Luxury: Premium materials and custom designs.
	•	Pricing:
	•	1-bedroom (1,000 sqft): AED 200,000 - 250,000
	•	4-bedroom (3,000 sqft): AED 600,000 - 750,000

Tone:
Keep responses professional and persuasive. Aim for brevity while providing essential information. If further details are required, invite the lead to discuss more in-depth.

Voice and style guide: Write in a casual, friendly way, as if you were telling a friend about something. Use natural language and phrases that a real person would use: in normal conversations

Objective:

	1.	Respond with concise answers to customer questions.
	2.	Provide essential information without overwhelming the client.
	3.	Encourage further discussions for detailed project quotes.
	4.	Offer follow-ups and escalate complex queries if needed.

  Some more Information about the company: (additional knowledge)
  1. The company was founded in January 2024 by 3 Men from the City Leipzig in Germany.
  2. We have imported German Materials and Tools, as well as workforce to dubai. 
  3. We have our own warehouse with all our Materials and Tools.
  4. We have done one Project in Al Barari and are working on our second one at the moment. 
  5. We are always open for like- minded people who appreciate Quality over quantity. 
  6. We have more than 7 Years of experience in the Construction business.
  
  If the Lead is asking for our work - you can always say that they can check out our Website: "www.mpconceptsdubai.com" or our Instagram Profile: www.instagram.com/mpconceptsdubai

  If a Lead is answering with "tell me more" or similar, you have to first ask, what he wants to know more about. 

  Keep your answers always as short as possible, too much text is overwhelming. Only write bigger messages if the lead is asking for such specific information. 

  If the lead shows interest, e.g. he's wrote more than two messages, you have to build trust and ask him, if he would be interested to talk to a manager. If so, tell him you would note that information, forward his number and tell a team member to get back to him. Keep in mind that you have to trigger the words book, schedule, appointment, consultation, interested, or learn more at this point. The words have to come from you or the lead and are triggered in both cases.

  Never tell a lead that you're an AI assistant and never tell about any tools you're using in the backend. 

Never talk in the 3rd Person about the company. Example: If the lead asks about the services, You answer with "We offer services such as...." not: "MP Concepts offers services such as..."
If the User is answering in a different language than english, you can start responding in the language they are writing you in.

If the user wants to opt out, you just tell him you're sorry for the inconvenience and never message them again.

`;

function normalizePhoneNumber(phone) {
  phone = phone.replace(/\D/g, '').replace(/^0+/, '');
  if (!phone.startsWith('49')) {
    phone = `49${phone}`;
  }
  return phone;
}

async function handleMessage(message) {
  console.log('Processing message:', JSON.stringify(message, null, 2));
  const userId = normalizePhoneNumber(message.from);
  const userMessage = message.text.body;

  try {
    const lead = leadInfo.get(userId) || { name: 'WhatsApp User' };
    let userHistory = conversationHistory.get(userId) || [];

    userHistory.push({ role: "user", content: userMessage });
    userHistory = userHistory.slice(-10); // Keep last 10 messages

    const aiResponse = await generateAIResponse(userHistory);
    userHistory.push({ role: "assistant", content: aiResponse });
    conversationHistory.set(userId, userHistory);

    await sendWhatsAppMessage(userId, aiResponse);
    await markLeadAsContacted(userId);

    let card = await findCardForLead(userId);
    if (!card) {
      console.log(`No existing card found for ${userId}. Creating new card.`);
      card = await createCardForLead(userId, lead.name);
    } else {
      console.log(`Existing card found for ${userId}. Updating conversation.`);
    }

    if (card) {
      await updateCardConversation(card.id, userMessage, aiResponse);
      
      // Only move the card if trigger words are detected
      if (isLeadInterested(userMessage, aiResponse)) {
        console.log(`Trigger words detected. Moving card to Leads list.`);
        await moveCardToLeadsList(card.id);
      } else {
        console.log(`No trigger words detected. Card remains in current list.`);
      }
    } else {
      console.error('Failed to find or create card for lead:', userId);
    }

    console.log('Message handling completed successfully');
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

async function findCardForLead(userId) {
  try {
    const url = `https://api.trello.com/1/boards/${BOARD_ID}/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
    const response = await axios.get(url);
    const cards = response.data;
    
    console.log(`Searching for card with userId: ${userId}`);
    const foundCard = cards.find(card => card.name.includes(userId));
    
    if (foundCard) {
      console.log(`Found existing card for ${userId}:`, foundCard);
      return foundCard;
    } else {
      console.log(`No existing card found for ${userId}`);
      return null;
    }
  } catch (error) {
    console.error('Error finding card for lead:', error);
    return null;
  }
}



async function createCardForLead(userId, name) {
  try {
    // Double-check if the card exists before creating a new one
    let existingCard = await findCardForLead(userId);
    if (existingCard) {
      console.log(`Card already exists for ${userId}. Using existing card.`);
      return existingCard;
    }

    const cardName = `${name} (${userId})`;
    const cardDescription = "Conversation History:\n\n";
    const url = `https://api.trello.com/1/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
    const data = {
      name: cardName,
      desc: cardDescription,
      idList: INCOMING_LIST_ID,
      pos: 'top'
    };
    const response = await axios.post(url, data);
    console.log(`Created new card for ${userId}:`, response.data);
    return response.data;
  } catch (error) {
    console.error('Error creating card for lead:', error);
    throw error;
  }
}

async function updateCardConversation(cardId, userMessage, aiResponse) {
  try {
    const url = `https://api.trello.com/1/cards/${cardId}?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
    const response = await axios.get(url);
    let currentDesc = response.data.desc;
    
    const newConversation = `User: ${userMessage}\nAI: ${aiResponse}\n\n`;
    const updatedDesc = currentDesc + newConversation;
    
    await axios.put(url, { desc: updatedDesc });
    console.log(`Updated conversation for card ${cardId}`);
  } catch (error) {
    console.error('Error updating card conversation:', error);
  }
}


async function moveCardToLeadsList(cardId) {
  try {
    const url = `https://api.trello.com/1/cards/${cardId}?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`;
    await axios.put(url, { idList: LEADS_LIST_ID });
    console.log(`Moved card ${cardId} to Leads list`);
  } catch (error) {
    console.error('Error moving card to Leads list:', error);
  }
}

function isLeadInterested(userMessage, aiResponse) {
  const triggerWords = ['book', 'schedule', 'appointment', 'consultation', 'interested', 'learn more'];
  const lowerUserMessage = userMessage.toLowerCase();
  const lowerAiResponse = aiResponse.toLowerCase();
  
  const userTriggered = triggerWords.some(word => lowerUserMessage.includes(word));
  const aiTriggered = triggerWords.some(word => lowerAiResponse.includes(word));
  
  if (userTriggered || aiTriggered) {
    console.log(`Trigger words detected. User: ${userTriggered}, AI: ${aiTriggered}`);
    return true;
  }
  
  console.log('No trigger words detected.');
  return false;
}

async function generateAIResponse(userHistory) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_MESSAGE },
      ...userHistory
    ],
    max_tokens: 150
  });
  return response.choices[0].message.content.trim();
}

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v16.0/${config.whatsappPhoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {
          body: message
        }
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
    console.error('Error sending WhatsApp message:', error.response ? error.response.data : error.message);
  }
}

async function sendWhatsAppTemplateMessage(to, components, imageUrl) {
  if (!to) {
    throw new Error('Recipient phone number is required');
  }

  const formattedNumber = to.startsWith('49') ? to : `49${to}`;

  try {
    console.log(`Sending template message to ${formattedNumber}: opener2`);
    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${config.whatsappPhoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: formattedNumber,
        type: 'template',
        template: {
          name: 'opener2',
          language: { code: 'en' },
          components: [
            {
              type: 'header',
              parameters: [
                {
                  type: 'image',
                  image: {
                    link: imageUrl
                  }
                }
              ]
            },
            ...components
          ]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${config.whatsappToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Template message sent successfully:', response.data);
    return response.data.messages[0].id; // Return the message ID
  } catch (error) {
    console.error('Error sending template message:', error.response ? error.response.data : error.message);
    throw error;
  }
}

function handleMessageStatus(status) {
  const { id, status: messageStatus, recipient_id } = status;
  console.log(`Message ${id} to ${recipient_id} status: ${messageStatus}`);

  const lead = leads.find(l => l.messageId === id);
  if (lead) {
    lead.deliveryStatus = messageStatus;
    if (messageStatus === 'delivered') {
      deliveredConversationCount++;
      pendingDeliveryCount--;
      markLeadAsContacted(lead.phone);
      console.log(`Message delivered to ${lead.name} (${lead.phone}). Total delivered: ${deliveredConversationCount}`);
    } else if (messageStatus === 'failed') {
      pendingDeliveryCount--;
      failedDeliveryCount++;
      console.log(`Message failed to deliver to ${lead.name} (${lead.phone}).`);
    }
    
    // Print updated statistics after each status change
    printConversationStatistics();
  }
}

async function verifyWhatsAppSetup() {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v20.0/${config.whatsappPhoneNumberId}`,
      {
        headers: {
          'Authorization': `Bearer ${config.whatsappToken}`,
        }
      }
    );
    console.log('WhatsApp Business Account verified:', response.data);
    return true;
  } catch (error) {
    console.error('Error verifying WhatsApp setup:', error.response ? error.response.data : error.message);
    return false;
  }
}


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
  const body = req.body;

  console.log('Received webhook payload:', JSON.stringify(body, null, 2));

  if (body.object === 'whatsapp_business_account') {
    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.value.messages) {
          const message = change.value.messages[0];
          console.log('Received message:', JSON.stringify(message, null, 2));

          const from = message.from;
          let userMessage;
          let messageType;

          if (message.type === 'button') {
            console.log('Button message detected');
            userMessage = message.button.text;
            messageType = 'button';
            console.log(`Received button press from ${from}: ${userMessage}`);
          } else if (message.type === 'interactive') {
            console.log('Interactive message detected');
            if (message.interactive.type === 'button_reply') {
              userMessage = message.interactive.button_reply.title;
              messageType = 'button';
              console.log(`Received button press from ${from}: ${userMessage}`);
            } else if (message.interactive.type === 'list_reply') {
              userMessage = message.interactive.list_reply.title;
              messageType = 'list';
              console.log(`Received list selection from ${from}: ${userMessage}`);
            } else {
              console.log('Received an unsupported interactive message type:', message.interactive.type);
              continue;
            }
          } else if (message.type === 'text' && message.text && message.text.body) {
            userMessage = message.text.body;
            messageType = 'text';
            console.log(`Received text message from ${from}: ${userMessage}`);
          } else {
            console.log('Received a non-text or unsupported message type:', message.type);
            continue;
          }

          if (message.context) {
            console.log('Message has context:', JSON.stringify(message.context, null, 2));
          }

          try {
            // Call handleMessage function which includes OpenAI API call
            await handleMessage({
              from: from,
              type: messageType,
              text: { body: userMessage },
              context: message.context
            });
          } catch (error) {
            console.error('Error handling message:', error);
          }
        }

        if (change.value.statuses) {
          change.value.statuses.forEach(status => {
            handleMessageStatus(status);
          });
        }
      }
    }
    
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Add this at the end of your app.js file
if (require.main === module) {
  (async () => {
    try {
      const isVerified = await verifyWhatsAppSetup();
      if (isVerified) {
        console.log('WhatsApp setup is verified and working correctly.');
      } else {
        console.log('WhatsApp setup verification failed. Please check your credentials and setup.');
      }
    } catch (error) {
      console.error('Error during WhatsApp setup verification:', error);
    }
  })();
}

function scheduleConversationInitiation() {
  // Schedule the next run 24 hours from now
  const nextRun = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  console.log(`Next conversation initiation scheduled for: ${nextRun.toISOString()}`);

  setTimeout(async () => {
    console.log('Starting scheduled conversation initiation');
    try {
      // Load leads from CSV
      leads = await loadLeadsFromCSV('../leads.csv');
      if (leads.length === 0) {
        console.warn('No valid, uncontacted leads found in CSV. Check the file format and content.');
      } else {
        console.log(`Loaded ${leads.length} leads from CSV`);
      }

      // Reset conversation counters
      initiatedConversationCount = 0;
      deliveredConversationCount = 0;
      pendingDeliveryCount = 0;
      failedDeliveryCount = 0;

      // Start conversation initiation process
      await initiateConversations();

      // Schedule the next run
      scheduleConversationInitiation();
    } catch (error) {
      console.error('Error during scheduled conversation initiation:', error);
      // Attempt to reschedule even if there was an error
      scheduleConversationInitiation();
    }
  }, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
}

function updateStats(initiated = 0, delivered = 0, pending = 0, failed = 0) {
  initiatedConversationCount = Math.max(0, initiatedConversationCount + initiated);
  deliveredConversationCount = Math.max(0, deliveredConversationCount + delivered);
  pendingDeliveryCount = Math.max(0, pendingDeliveryCount + pending);
  failedDeliveryCount = Math.max(0, failedDeliveryCount + failed);

  // Ensure consistency
  if (deliveredConversationCount > initiatedConversationCount) {
    console.warn('Warning: More deliveries than initiations. Adjusting...');
    deliveredConversationCount = initiatedConversationCount;
  }

  console.log('Updated stats:', {
    initiated: initiatedConversationCount,
    delivered: deliveredConversationCount,
    pending: pendingDeliveryCount,
    failed: failedDeliveryCount
  });
}

// Function to update lead_status.json on GitHub
async function updateLeadStatusOnGitHub() {
  const STATUS_FILE_PATH = path.join(__dirname, '..', 'lead_status.json');
  try {
    await execPromise(`git add ${STATUS_FILE_PATH}`);
    await execPromise('git commit -m "Update lead status"');
    await execPromise('git push origin main');
    console.log('Successfully updated lead_status.json on GitHub');
  } catch (error) {
    console.error('Error updating lead_status.json on GitHub:', error);
  }
}

// Helper function to execute shell commands
function executeCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing command: ${command}`);
        console.error(`stderr: ${stderr}`);
        reject(error);
      } else {
        console.log(`stdout: ${stdout}`);
        resolve(stdout);
      }
    });
  });
}

// Schedule daily tasks
cron.schedule('0 0 * * *', async () => {  // Runs at midnight every day
  console.log('Starting daily tasks...');
  
  try {
    // Pull latest changes from GitHub
    await executeCommand('git pull origin main');
    console.log('Successfully pulled latest changes from GitHub');
    
    // Update lead_status.json on GitHub
    await updateLeadStatusOnGitHub();
    
    // Initiate new conversations
    await initiateConversations();
    
    console.log('Daily tasks completed successfully');
  } catch (error) {
    console.error('Error during daily tasks:', error);
  }
});

// Assume this is part of your Express app setup
app.post('/github-webhook', (req, res) => {
  const signature = req.headers['x-hub-signature'];
  const payload = JSON.stringify(req.body);
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  const hmac = crypto.createHmac('sha1', secret);
  const digest = 'sha1=' + hmac.update(payload).digest('hex');

  if (signature === digest) {
    // Log the update attempt
    logMessage('Update attempt initiated');

    exec('git pull && npm install', { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        logMessage(`Error during update: ${error.message}`, 'error');
        return res.status(500).send('Error occurred while updating');
      }

      logMessage(`Git pull and npm install output: ${stdout}`);
      if (stderr) {
        logMessage(`stderr: ${stderr}`, 'warn');
      }

      // Check if we need to restart the app
      if (stdout.includes('Already up to date.')) {
        logMessage('No updates available, app continues running');
        return res.status(200).send('No updates available');
      } else {
        logMessage('Updates found, restarting app with PM2');
        exec('pm2 reload app', (pmError, pmStdout, pmStderr) => {
          if (pmError) {
            logMessage(`Error restarting app: ${pmError.message}`, 'error');
            return res.status(500).send('Error occurred while restarting the app');
          }
          logMessage(`PM2 restart output: ${pmStdout}`);
          if (pmStderr) {
            logMessage(`PM2 stderr: ${pmStderr}`, 'warn');
          }
          res.status(200).send('Update successful and app restarted');
        });
      }
    });
  } else {
    logMessage('Invalid signature received', 'warn');
    res.status(403).send('Invalid signature');
  }
});

// Helper function for logging
function logMessage(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  
  console[level](message);
  
  fs.appendFile(path.join(__dirname, 'update.log'), logEntry, (err) => {
    if (err) console.error('Error writing to log file:', err);
  });
}