require('dotenv').config();
const mineflayer = require('mineflayer');
const pathfinderModule = require('mineflayer-pathfinder');
const pathfinder = pathfinderModule.pathfinder;
const { Movements, goals } = pathfinderModule;
const OpenAI = require('openai');
const Vec3 = require('vec3').Vec3;
const mcDataFactory = require('minecraft-data');

// BUG FIX: Set high timeout for slow LLM responses
const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY || 'sk-1234',
  timeout: 600000 // 10 minutes in milliseconds
});

const MODEL = process.env.MODEL;
const NUM_BOTS = parseInt(process.env.NUM_BOTS) || 1;
const BASE_USERNAME = process.env.BASE_USERNAME || 'AI_Bot';

// Personalities to separate the "brains"
const TRAITS = ["a builder", "a miner", "an explorer", "a farmer", "a guard"];

// ==================== ALL 19 TOOLS ====================
const tools = [
  { type: "function", function: { name: "send_chat", description: "Send public chat message", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
  { type: "function", function: { name: "whisper", description: "Private message a player", parameters: { type: "object", properties: { player: { type: "string" }, message: { type: "string" } }, required: ["player", "message"] } } },
  { type: "function", function: { name: "navigate_to", description: "Walk to coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "dig_block", description: "Mine block at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "place_block", description: "Place held item at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "look_at", description: "Look at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "equip_item", description: "Equip item", parameters: { type: "object", properties: { itemName: { type: "string" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "attack_entity", description: "Attack entity by ID", parameters: { type: "object", properties: { entityId: { type: "number" } }, required: ["entityId"] } } },
  { type: "function", function: { name: "interact_entity", description: "Interact with entity", parameters: { type: "object", properties: { entityId: { type: "number" } }, required: ["entityId"] } } },
  { type: "function", function: { name: "get_block_info", description: "Check block info", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "find_nearest_block", description: "Find nearest block", parameters: { type: "object", properties: { type: { type: "string" }, maxDistance: { type: "number" } }, required: ["type"] } } },
  { type: "function", function: { name: "craft_item", description: "Craft item", parameters: { type: "object", properties: { itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "consume_food", description: "Eat food", parameters: { type: "object", properties: { itemName: { type: "string" } } } } },
  { type: "function", function: { name: "activate_block", description: "Open/activate block", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "use_held_item", description: "Use item in hand", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "toss_item", description: "Drop items", parameters: { type: "object", properties: { itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "set_control_state", description: "Movement state", parameters: { type: "object", properties: { control: { type: "string", enum: ["forward","back","left","right","jump","sprint","sneak"] }, state: { type: "boolean" } }, required: ["control","state"] } } },
  { type: "function", function: { name: "sleep_in_bed", description: "Sleep in bed", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } } } },
  { type: "function", function: { name: "start_fishing", description: "Start fishing", parameters: { type: "object", properties: {} } } }
];

function createToolHandlers(bot) {
  return {
    send_chat: async ({ message }) => { bot.chat(message); return `Sent: ${message}`; },
    whisper: async ({ player, message }) => { bot.chat(`/msg ${player} ${message}`); return `Whispered`; },
    navigate_to: async ({ x, y, z }) => {
      const goal = new goals.GoalNear(x, y, z, 1);
      bot.pathfinder.setGoal(goal);
      return new Promise((r) => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); r("Nav Timeout"); }, 600000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached"); });
      });
    },
    dig_block: async ({ x, y, z }) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block || block.name === 'air') return "No block found.";
      
      try {
        await bot.lookAt(block.position);
        // BUG FIX: Manual validation and "swing" check to ensure it holds
        if (!bot.canDigBlock(block)) return "Can't reach it.";
        
        // Wrapping dig in a promise to ensure it doesn't "click and release"
        await bot.dig(block, 'ignore', 'raycast'); 
        return `Successfully mined ${block.name}`;
      } catch (err) { return `Digging interrupted: ${err.message}`; }
    },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below) return "No solid base.";
      await bot.lookAt(pos);
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      return "Placed.";
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking."; },
    equip_item: async ({ itemName }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (item) { await bot.equip(item, 'hand'); return "Equipped."; }
      return "Not found.";
    },
    attack_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.attack(e); return "Attacking."; }
      return "No entity.";
    },
    interact_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.useOn(e); return "Interacted."; }
      return "No entity.";
    },
    get_block_info: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      return b ? b.name : "Air";
    },
    find_nearest_block: async ({ type }) => {
      const block = bot.findBlock({ matching: b => b.name.includes(type.toLowerCase()), maxDistance: 32 });
      return block ? `${block.name} at ${block.position}` : "None nearby.";
    },
    craft_item: async ({ itemName, count = 1 }) => {
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      if (!item) return "Unknown item.";
      const recipes = bot.recipesFor(item.id, null, count, null);
      if (!recipes.length) return "No recipe found.";
      await bot.craft(recipes[0], count, null);
      return "Crafted.";
    },
    consume_food: async () => { await bot.consume(); return "Ate."; },
    activate_block: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b) { await bot.activateBlock(b); return "Activated."; }
      return "No block.";
    },
    use_held_item: async () => { await bot.useItem(); return "Used."; },
    toss_item: async ({ itemName, count = 1 }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (item) await bot.toss(item.type, null, count);
      return "Dropped.";
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return "Set."; },
    sleep_in_bed: async () => {
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 8 });
      if (bed) await bot.sleep(bed);
      return "Sleeping.";
    },
    start_fishing: async () => { await bot.fish(); return "Fishing."; }
  };
}

// ==================== RECONNECT & UNIQUE BRAIN ====================
function startBot(username, trait) {
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: process.env.VERSION || '1.21.1',
    auth: 'offline'
  });

  let chatHistory = [];
  let isThinking = false;
  let heartBeat = null;
  const toolHandlers = createToolHandlers(bot);

  bot.once('inject_allowed', () => { bot.loadPlugin(pathfinder); });

  async function think() {
    if (isThinking || !bot.entity) return;
    isThinking = true;

    try {
      const pos = bot.entity.position;
      const nearbyPeers = Object.values(bot.entities)
        .filter(e => e.username && e.username.startsWith(BASE_USERNAME) && e.username !== username)
        .map(e => e.username).join(', ') || 'none';

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: `You are ${username}, ${trait}. Stay separate from other bots: ${nearbyPeers}. Focus on your role. Work toward survival.` },
          { role: "user", content: `Pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)} | Inv: ${bot.inventory.items().length} items | Chat: ${chatHistory.slice(-5).join('|')}` }
        ],
        tools, tool_choice: "auto"
      });

      const msg = response.choices[0].message;
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          const res = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
          console.log(`[${username}] ${call.function.name}: ${res}`);
        }
      }
    } catch (e) { console.error(`[${username}] AI Timeout/Error:`, e.message); }

    isThinking = false;
  }

  bot.on('spawn', () => {
    console.log(`✅ ${username} (${trait}) has joined.`);
    setTimeout(() => {
      try { bot.pathfinder.setMovements(new Movements(bot, mcDataFactory(bot.version))); } catch(e) {}
      if (!heartBeat) heartBeat = setInterval(think, 12000 + Math.random() * 5000);
    }, 5000);
  });

  bot.on('chat', (u, m) => {
    if (u === username) return;
    chatHistory.push(`${u}: ${m}`);
    if (chatHistory.length > 15) chatHistory.shift();
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ ${username} disconnected (${reason}). Reconnecting in 10s...`);
    clearInterval(heartBeat);
    heartBeat = null;
    setTimeout(() => startBot(username, trait), 10000);
  });
}

// Initial Spawn
for (let i = 0; i < NUM_BOTS; i++) {
  const name = `${BASE_USERNAME}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const trait = TRAITS[i % TRAITS.length];
  setTimeout(() => startBot(name, trait), i * 5000);
}
