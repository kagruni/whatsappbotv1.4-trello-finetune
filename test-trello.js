const axios = require('axios');

const API_KEY = 'acceb6e1879ddd48d65b0d7d98c5f7bc';
const TOKEN = 'ATTAca044d48d207f1bc849cab55f2532adee295f844c7d6da7d597949a03e6e950cBF0CE478';

async function testTrelloCredentials() {
  try {
    const response = await axios.get(`https://api.trello.com/1/members/me/boards?key=${API_KEY}&token=${TOKEN}`);
    console.log('Trello credentials are valid. Your boards:', response.data.map(board => board.name));
  } catch (error) {
    console.error('Error testing Trello credentials:', error.response ? error.response.data : error.message);
  }
}

testTrelloCredentials();