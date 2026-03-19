require('dotenv').config();
const mineflayer = require('mineflayer');
const pathfinderModule = require('mineflayer-pathfinder');
const pathfinder = pathfinderModule.pathfinder;   // ← Explicit (fixes the crash)
const { Movements, goals } = pathfinderModule;
const OpenAI = require('openai');
const Vec3 = require('vec3').Vec3;

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY || 'sk-1234'
});

const MODEL = process.env.MODEL;
const NUM_BOTS = parseInt(process.env.NUM_BOTS) || 1;
const BASE_USERNAME = process.env.BASE_USERNAME || 'AI_SocietyBuilder';

// ==================== ALL TOOLS (full Minecraft control) ====================
const tools = [
  // ... (exactly the same 19 tools as before - send_chat, navigate_to, craft_item, sleep_in_bed, etc.)
  // (I'm not repeating all 19 lines here to save space — copy them from your previous index.js)
  // Just keep the entire tools array and createToolHandlers function exactly as they were in the last version I gave you.
];

function createToolHandlers(bot) {
  // ... (keep the entire createToolHandlers object exactly as before - all old + new handlers)
  // No changes needed here.
}

// ==================== OBSERVATION & DECISION (unchanged) ====================
function getObservation(bot, chatHistory) {
  // ... (keep exactly as before)
}

function setupAutonomousBot(username) {
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: process.env.VERSION,
    auth: 'offline'
  });

  let chatHistory = [];
  let isDeciding = false;
  const toolHandlers = createToolHandlers(bot);

  // ← Safe plugin load with error catching
  try {
    bot.loadPlugin(pathfinder);
    console.log(`[${username}] Pathfinder plugin loaded successfully`);
  } catch (e) {
    console.error(`[${username}] Plugin load failed:`, e.message);
  }

  async function makeDecision() { /* exactly as before */ }

  bot.on('spawn', () => {
    console.log(`🤖 ${username} joined the world with FULL tools!`);
    bot.pathfinder.setMovements(new Movements(bot));
    setInterval(makeDecision, 2500);
  });

  bot.on('chat', (usernameMsg, message) => {
    chatHistory.push(`[${usernameMsg}]: ${message}`);
    if (chatHistory.length > 15) chatHistory.shift();
  });

  bot.on('error', err => console.error(`[${username}] Error:`, err));
  bot.on('kicked', reason => console.log(`[${username}] Kicked:`, reason));
}

// ==================== LAUNCH BOTS ====================
console.log(`Starting ${NUM_BOTS} autonomous AI citizens...`);

for (let i = 0; i < NUM_BOTS; i++) {
  const suffix = NUM_BOTS === 1 ? '' : '_' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const username = BASE_USERNAME + suffix;
  console.log(`Queueing ${username}`);
  setTimeout(() => setupAutonomousBot(username), i * 1500);
}
