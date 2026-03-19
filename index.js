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
      if (!bot.pathfinder) return "Pathfinder not ready";
      const goal = new goals.GoalNear(x, y, z, 1);
      bot.pathfinder.setGoal(goal);
      return new Promise((r) => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); r("Navigation Timeout"); }, 600000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached Destination"); });
      });
    },
    dig_block: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b || b.name === 'air') return "No block there";
      try {
        await bot.lookAt(b.position);
        if (!bot.canDigBlock(b)) return "Can't reach/dig this block";
        await bot.dig(b, true); // True keeps the bot looking at the block while digging
        return `Successfully mined ${b.name}`;
      } catch (e) { return `Digging failed: ${e.message}`; }
    },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below || below.name === 'air') return "No solid base to place on";
      try {
        await bot.lookAt(pos);
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        return "Placed block";
      } catch (e) { return `Placement failed: ${e.message}`; }
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking"; },
    equip_item: async ({ itemName }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (item) { await bot.equip(item, 'hand'); return `Equipped ${item.name}`; }
      return "Item not found in inventory";
    },
    attack_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.attack(e); return "Attacking"; }
      return "Entity not found";
    },
    interact_entity: async ({ entityId }) => {
      const e = bot.entities[entityId]; if (e) { bot.useOn(e); return "Interacting"; }
      return "Entity not found";
    },
    get_block_info: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      return b ? `${b.name}` : "No block info";
    },
    find_nearest_block: async ({ type, maxDistance = 32 }) => {
      const block = bot.findBlock({ matching: (b) => b.name.includes(type.toLowerCase()), maxDistance });
      return block ? `${block.name} @ ${block.position}` : `No ${type} found nearby`;
    },
    craft_item: async ({ itemName, count = 1 }) => {
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      if (!item) return "Unknown item";
      const recipes = bot.recipesFor(item.id, null, count, null);
      if (recipes.length === 0) return "No recipe found";
      try { await bot.craft(recipes[0], count, null); return `Crafted ${count} ${itemName}`; } 
      catch (e) { return `Craft failed: ${e.message}`; }
    },
    consume_food: async ({ itemName }) => {
      if (itemName) {
        const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
        if (item) await bot.equip(item, 'hand');
      }
      try { await bot.consume(); return "Ate food"; } catch(e) { return "Can't eat"; }
    },
    activate_block: async ({ x, y, z }) => {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b) { await bot.activateBlock(b); return `Activated ${b.name}`; }
      return "Block not found";
    },
    use_held_item: async () => { await bot.useItem(); return "Used item"; },
    toss_item: async ({ itemName, count = 1 }) => {
      const item = bot.inventory.items().find(i => i.name.includes(itemName.toLowerCase()));
      if (!item) return "Item not in inventory";
      await bot.toss(item.type, null, Math.min(count, item.count));
      return `Tossed ${itemName}`;
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return `${control} set to ${state}`; },
    sleep_in_bed: async ({ x, y, z }) => {
      const bed = x !== undefined ? bot.blockAt(new Vec3(x, y, z)) : bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 16 });
      if (!bed) return "No bed found";
      try { await bot.sleep(bed); return "Sleeping..."; } catch(e) { return "Cannot sleep"; }
    },
    start_fishing: async () => { try { await bot.fish(); return "Fishing..."; } catch(e) { return "Failed to fish"; } }
  };
}

// ==================== RECONNECT & BRAIN LOGIC ====================
function startBot(username) {
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: process.env.VERSION || '1.21.1',
    auth: 'offline'
  });

  let chatHistory = [];
  let isDeciding = false;
  let decisionInterval = null;
  const toolHandlers = createToolHandlers(bot);

  // Fix for 1.21.1 Registry Error
  bot.once('inject_allowed', () => {
    bot.loadPlugin(pathfinder);
    console.log(`[${username}] Plugins injected.`);
  });

  async function makeDecision() {
    if (isDeciding || !bot.entity) return;
    isDeciding = true;

    try {
      const pos = bot.entity.position;
      const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty';
      const obs = `Name: ${username} | Pos: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)} | HP: ${bot.health} | Hunger: ${bot.food} | Inv: ${inv} | Chat: ${chatHistory.slice(-5).join(' | ')}`;

      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: `You are ${username}. You are an autonomous player in an AI society. Work with others starting with "${BASE_USERNAME}". Tell others your plans in chat.` },
          { role: "user", content: obs }
        ],
        tools, tool_choice: "auto", temperature: 0.8
      });

      const msg = response.choices[0].message;
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          const result = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
          console.log(`[${username}] Action: ${call.function.name} -> ${result}`);
        }
      }
    } catch (e) { console.error(`[${username}] AI Error:`, e.message); }

    isDeciding = false;
  }

  bot.on('spawn', () => {
    console.log(`✅ ${username} has joined.`);
    if (decisionInterval) clearInterval(decisionInterval);

    setTimeout(() => {
      try {
        const data = mcDataFactory(bot.version);
        bot.pathfinder.setMovements(new Movements(bot, data));
      } catch (e) {}
      // Randomize decision timing so they don't sync up
      decisionInterval = setInterval(makeDecision, 9000 + Math.random() * 4000);
    }, 3000);
  });

  bot.on('chat', (u, m) => {
    if (u === username) return;
    chatHistory.push(`${u}: ${m}`);
    if (chatHistory.length > 20) chatHistory.shift();
  });

  bot.on('end', (reason) => {
    console.log(`⚠️ ${username} disconnected (${reason}). Reconnecting in 10s...`);
    if (decisionInterval) clearInterval(decisionInterval);
    setTimeout(() => startBot(username), 10000); // Reconnect with SAME name
  });

  bot.on('error', (err) => console.error(`[${username}] Error:`, err.message));
}

// ============ LAUNCH ============
console.log(`Launching AI Persistent Society...`);
for (let i = 0; i < NUM_BOTS; i++) {
  // Generate name ONCE so it persists through reconnects
  const persistentName = `${BASE_USERNAME}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  setTimeout(() => startBot(persistentName), i * 4000);
}
