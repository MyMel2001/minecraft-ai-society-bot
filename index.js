require('dotenv').config();
const mineflayer = require('mineflayer');
const pathfinderModule = require('mineflayer-pathfinder');
const pathfinder = pathfinderModule.pathfinder;
const { Movements, goals } = pathfinderModule;
const OpenAI = require('openai');
const Vec3 = require('vec3').Vec3;
const mcDataFactory = require('minecraft-data');

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY || 'sk-1234'
});

const MODEL = process.env.MODEL;
const NUM_BOTS = parseInt(process.env.NUM_BOTS) || 1;
const BASE_USERNAME = process.env.BASE_USERNAME || 'AI_Bot';

// PERSONALITY POOL: Distributed to bots to ensure variety
const PERSONALITIES = [
  "an obsessive builder who loves symmetry",
  "a cautious explorer who fears the dark",
  "a grumpy miner who only cares about iron and coal",
  "a social butterfly who constantly talks to others",
  "a practical survivalist focused on food and farming",
  "a chaotic decorator who places torches everywhere"
];

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
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); r("Timeout"); }, 600000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached"); });
      });
    },
    dig_block: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) return "No block";
      await bot.lookAt(b.position);
      await bot.dig(b, true); // Hold action fix
      return `Mined ${b.name}`;
    },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below) return "No base";
      await bot.lookAt(pos);
      await bot.placeBlock(below, new Vec3(0, 1, 0));
      return "Placed";
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking"; },
    equip_item: async ({ itemName }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (item) { await bot.equip(item, 'hand'); return "Equipped"; }
      return "Not found";
    },
    attack_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.attack(e); return "Attacking"; }
      return "No entity";
    },
    interact_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.useOn(e); return "Interacting"; }
      return "No entity";
    },
    get_block_info: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      return b ? b.name : "None";
    },
    find_nearest_block: async ({ type, maxDistance = 32 }) => {
      const block = bot.findBlock({ matching: (b) => b.name.includes(type.toLowerCase()), maxDistance });
      return block ? `${block.name} at ${block.position}` : "Not found";
    },
    craft_item: async ({ itemName, count = 1 }) => {
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      if (!item) return "Unknown item";
      const recipes = bot.recipesFor(item.id, null, count, null);
      if (!recipes.length) return "No recipe";
      await bot.craft(recipes[0], count, null);
      return "Crafted";
    },
    consume_food: async () => { try { await bot.consume(); return "Ate"; } catch (e) { return "Can't eat"; } },
    activate_block: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b) { await bot.activateBlock(b); return "Activated"; }
      return "No block";
    },
    use_held_item: async () => { await bot.useItem(); return "Used"; },
    toss_item: async ({ itemName, count = 1 }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (item) await bot.toss(item.type, null, count);
      return "Tossed";
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return "Set"; },
    sleep_in_bed: async () => {
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 16 });
      if (bed) await bot.sleep(bed);
      return "Slept";
    },
    start_fishing: async () => { await bot.fish(); return "Fishing"; }
  };
}

// ==================== AGENT CORE ====================
function startBot(username, personality) {
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: process.env.VERSION || '1.21.1',
    auth: 'offline'
  });

  let chatHistory = [];
  let isDeciding = false;
  let loopTimeout = null;
  const toolHandlers = createToolHandlers(bot);

  bot.once('inject_allowed', () => { bot.loadPlugin(pathfinder); });

  async function makeDecision() {
    if (isDeciding || !bot.entity) return;
    isDeciding = true;

    try {
      const pos = bot.entity.position;
      const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty';
      
      // SOCIAL AWARENESS: Label fellow bots so they recognize colleagues
      const peers = Object.values(bot.entities)
        .filter(e => e.username && e.username.startsWith(BASE_USERNAME) && e.username !== username)
        .map(e => `${e.username} (Colleague) at ${Math.round(e.position.x)}, ${Math.round(e.position.z)}`)
        .join('; ');

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: `You are ${username}, ${personality}. 
            You are a distinct individual. While you work with other bots, you have your own goals. 
            NEVER do exactly what another bot is doing. If you see a colleague mining, you should build or explore. 
            Use chat to negotiate tasks. Your priority is survival and your unique personality.` },
          { role: "user", content: `IDENTITY: ${username}\nPOS: ${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}\nINV: ${inv}\nPEERS NEARBY: ${peers || 'none'}\nCHAT: ${chatHistory.slice(-8).join(' | ')}` }
        ],
        tools, tool_choice: "auto", temperature: 0.8
      });

      const msg = response.choices[0].message;
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          const res = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
          console.log(`[${username}] Executed ${call.function.name} -> ${res}`);
        }
      }
    } catch (e) { console.error(`[${username}] Brain Error:`, e.message); }

    isDeciding = false;
    // STAGGERED HEARTBEAT: Randomizes the decision gap per bot
    loopTimeout = setTimeout(makeDecision, 8000 + Math.random() * 5000);
  }

  bot.on('spawn', () => {
    console.log(`✅ ${username} initialized with personality: ${personality}`);
    setTimeout(() => {
      try { bot.pathfinder.setMovements(new Movements(bot, mcDataFactory(bot.version))); } catch(e) {}
      makeDecision();
    }, 5000);
  });

  bot.on('chat', (u, m) => {
    if (u === username) return;
    chatHistory.push(`${u}: ${m}`);
    if (chatHistory.length > 20) chatHistory.shift();
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ ${username} exited (${reason}). Resurrection in 10s...`);
    clearTimeout(loopTimeout);
    setTimeout(() => startBot(username, personality), 10000);
  });

  bot.on('error', (err) => console.log(`[${username}]`, err.message));
}

// ============ LAUNCH PERSISTENT SOCIETY ============
for (let i = 0; i < NUM_BOTS; i++) {
  const name = `${BASE_USERNAME}_${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
  const trait = PERSONALITIES[i % PERSONALITIES.length];
  setTimeout(() => startBot(name, trait), i * 4000);
}
