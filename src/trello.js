const Trello = require('trello-node-api');
const trello = new Trello(process.env.TRELLO_API_KEY, process.env.TRELLO_TOKEN);

const BOARD_ID = process.env.TRELLO_BOARD_ID;
const INCOMING_LIST_ID = process.env.TRELLO_INCOMING_LIST_ID;
const LEADS_LIST_ID = process.env.TRELLO_LEADS_LIST_ID;

// These functions should be imported from where they are defined
// const generateAIResponse = ...
// const sendWhatsAppMessage = ...
// const markLeadAsContacted = ...
// const normalizePhoneNumber = ...

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
      card = await createCardForLead(userId, lead.name);
    }
    await updateCardConversation(card.id, userMessage, aiResponse);

    if (isLeadInterested(userMessage, aiResponse)) {
      await moveCardToLeadsList(card.id);
    }

    console.log('Message handling completed successfully');
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

async function findCardForLead(userId) {
  try {
    const cards = await trello.card.search({
      query: userId,
      modelTypes: 'cards',
      boardId: BOARD_ID,
      card_fields: 'name,id'
    });
    return cards.find(card => card.name.includes(userId));
  } catch (error) {
    console.error('Error finding card for lead:', error);
    return null;
  }
}

async function createCardForLead(userId, name) {
  try {
    const cardName = `${name} (${userId})`;
    const cardDescription = "Conversation History:\n\n";
    const card = await trello.card.create({
      name: cardName,
      desc: cardDescription,
      idList: INCOMING_LIST_ID,
      pos: 'top'
    });
    console.log(`Created new card for ${userId}`);
    return card;
  } catch (error) {
    console.error('Error creating card for lead:', error);
    throw error;
  }
}

async function updateCardConversation(cardId, userMessage, aiResponse) {
  try {
    const card = await trello.card.get(cardId);
    let newDescription = card.desc || "Conversation History:\n\n";
    newDescription += `User: ${userMessage}\nAI: ${aiResponse}\n\n`;
    await trello.card.update(cardId, { desc: newDescription });
    console.log(`Updated conversation for card ${cardId}`);
  } catch (error) {
    console.error('Error updating card conversation:', error);
  }
}

async function moveCardToLeadsList(cardId) {
  try {
    await trello.card.update(cardId, { idList: LEADS_LIST_ID });
    console.log(`Moved card ${cardId} to Leads list`);
  } catch (error) {
    console.error('Error moving card to Leads list:', error);
  }
}

function isLeadInterested(userMessage, aiResponse) {
  const triggerWords = ['book', 'schedule', 'appointment', 'consultation', 'interested', 'learn more'];
  const lowerUserMessage = userMessage.toLowerCase();
  const lowerAiResponse = aiResponse.toLowerCase();
  return triggerWords.some(word => lowerUserMessage.includes(word) || lowerAiResponse.includes(word));
}

module.exports = {
  handleMessage,
  findCardForLead,
  createCardForLead,
  updateCardConversation,
  moveCardToLeadsList,
  isLeadInterested
};