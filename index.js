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
const BASE_USERNAME = process.env.BASE_USERNAME || 'AI_SocietyBuilder';

// ==================== ALL 19 TOOLS ====================
const tools = [
  { type: "function", function: { name: "send_chat", description: "Send public chat message", parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } } },
  { type: "function", function: { name: "whisper", description: "Private message a player", parameters: { type: "object", properties: { player: { type: "string" }, message: { type: "string" } }, required: ["player", "message"] } } },
  { type: "function", function: { name: "navigate_to", description: "Walk to exact coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "dig_block", description: "Mine block at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "place_block", description: "Place held item at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "look_at", description: "Look at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "equip_item", description: "Equip item from inventory", parameters: { type: "object", properties: { itemName: { type: "string" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "attack_entity", description: "Attack entity by ID", parameters: { type: "object", properties: { entityId: { type: "number" } }, required: ["entityId"] } } },
  { type: "function", function: { name: "interact_entity", description: "Interact (tame, trade, mount boat/minecart)", parameters: { type: "object", properties: { entityId: { type: "number" } }, required: ["entityId"] } } },
  { type: "function", function: { name: "get_block_info", description: "Check block at coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "find_nearest_block", description: "Find nearest block of any type", parameters: { type: "object", properties: { type: { type: "string" }, maxDistance: { type: "number" } }, required: ["type"] } } },
  { type: "function", function: { name: "craft_item", description: "Craft any item", parameters: { type: "object", properties: { itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "consume_food", description: "Eat food", parameters: { type: "object", properties: { itemName: { type: "string" } } } } },
  { type: "function", function: { name: "activate_block", description: "Open/activate block (chest, furnace, door, bed...)", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["x","y","z"] } } },
  { type: "function", function: { name: "use_held_item", description: "Use the item in your hand", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "toss_item", description: "Drop items", parameters: { type: "object", properties: { itemName: { type: "string" }, count: { type: "number" } }, required: ["itemName"] } } },
  { type: "function", function: { name: "set_control_state", description: "Control movement (sprint, sneak, jump...)", parameters: { type: "object", properties: { control: { type: "string", enum: ["forward","back","left","right","jump","sprint","sneak"] }, state: { type: "boolean" } }, required: ["control","state"] } } },
  { type: "function", function: { name: "sleep_in_bed", description: "Sleep in a bed", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } } } } },
  { type: "function", function: { name: "start_fishing", description: "Start fishing (rod in hand)", parameters: { type: "object", properties: {} } } }
];

function createToolHandlers(bot) {
  return {
    send_chat: async ({ message }) => { bot.chat(message); return `Sent: ${message}`; },
    whisper: async ({ player, message }) => { bot.chat(`/msg ${player} ${message}`); return `Whispered`; },
    navigate_to: async ({ x, y, z }) => {
      if (!bot.pathfinder) return "Pathfinder not loaded yet";
      const goal = new goals.GoalNear(x, y, z, 1);
      bot.pathfinder.setGoal(goal);
      return new Promise((resolve) => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); resolve("Timeout"); }, 30000);
        bot.once('goal_reached', () => { clearTimeout(t); resolve(`Reached`); });
      });
    },
    dig_block: async ({ x, y, z }) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block) return "No block";
      try { await bot.dig(block); return `Mined ${block.name}`; } catch (e) { return `Dig failed: ${e.message}`; }
    },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      if (!below || below.name === 'air') return "No solid block below";
      await bot.lookAt(pos);
      try { await bot.placeBlock(below, new Vec3(0, 1, 0)); return `Placed block`; } catch (e) { return `Place failed: ${e.message}`; }
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking"; },
    equip_item: async ({ itemName }) => {
      const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
      if (item) { await bot.equip(item, 'hand'); return `Equipped ${item.name}`; }
      return "Not found";
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
      return b ? `${b.name}` : "No block";
    },
    find_nearest_block: async ({ type, maxDistance = 32 }) => {
      const block = bot.findBlock({ matching: (b) => b.name === type || b.name.toLowerCase().includes(type.toLowerCase()), maxDistance });
      return block ? `${block.name} @ ${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}` : `No ${type} nearby`;
    },
    craft_item: async ({ itemName, count = 1 }) => {
      if (!bot.registry) return "Registry not ready";
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      if (!item) return "Unknown item";
      let craftingTable = null;
      let recipes = bot.recipesFor(item.id, null, count, null);
      if (recipes.length === 0) {
        craftingTable = bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });
        if (craftingTable) recipes = bot.recipesFor(item.id, null, count, craftingTable);
      }
      if (recipes.length === 0) return "No recipe";
      try { await bot.craft(recipes[0], count, craftingTable); return `Crafted ${count} × ${itemName}`; } catch (e) { return `Craft failed: ${e.message}`; }
    },
    consume_food: async ({ itemName }) => {
      if (itemName) {
        const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
        if (item) await bot.equip(item, 'hand');
      }
      try { await bot.consume(); return "Ate food"; } catch (e) { return "Can't eat"; }
    },
    activate_block: async ({ x, y, z }) => {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (!block) return "No block";
      await bot.activateBlock(block);
      return `Activated ${block.name}`;
    },
    use_held_item: async () => { await bot.useItem(); return "Used item"; },
    toss_item: async ({ itemName, count = 1 }) => {
      const item = bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()));
      if (!item) return "Not in inventory";
      await bot.toss(item.type, null, Math.min(count, item.count));
      return `Tossed ${count} ${itemName}`;
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return `${control}=${state}`; },
    sleep_in_bed: async ({ x, y, z }) => {
      let bed = x !== undefined ? bot.blockAt(new Vec3(x, y, z)) : bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 16 });
      if (!bed) return "No bed";
      try { await bot.sleep(bed); return "Sleeping"; } catch (e) { return "Can't sleep"; }
    },
    start_fishing: async () => { try { await bot.fish(); return "Fishing"; } catch (e) { return "Can't fish"; } }
  };
}

function getObservation(bot, chatHistory) {
  if (!bot.entity || !bot.entity.position) return "Waiting for spawn...";
  const pos = bot.entity.position;
  const inventory = bot.inventory.items().map(i => `${i.name}×${i.count}`).join(', ') || 'empty';
  const nearby = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 32)
    .map(e => `${e.id}: ${e.name || e.type} @ ${Math.round(e.position.x)},${Math.round(e.position.y)},${Math.round(e.position.z)}`)
    .join('; ') || 'none';

  return `=== OBSERVATION ===
Position: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}
Health: ${bot.health} | Hunger: ${bot.food} | Time: ${bot.time ? (bot.time.isDay ? 'DAY' : 'NIGHT') : 'UNK'}
Inventory: ${inventory}
Nearby entities: ${nearby}
Recent chat: ${chatHistory.slice(-5).join('\n') || 'none'}
Goal: Be a society builder.`;
}

function setupAutonomousBot(username) {
  const botVersion = process.env.VERSION || '1.20.1';

  // 1. Create Bot
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: botVersion,
    auth: 'offline'
  });

  // 2. Load plugin IMMEDIATELY, but wrap in try/catch to handle potential version mismatch
  try {
    bot.loadPlugin(pathfinder);
  } catch (err) {
    console.error(`[${username}] Early pathfinder load error:`, err.message);
  }

  let chatHistory = [];
  let isDeciding = false;
  const toolHandlers = createToolHandlers(bot);

  async function makeDecision() {
    if (isDeciding || !bot.entity) return;
    isDeciding = true;
    try {
      const obs = getObservation(bot, chatHistory);
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: "You are an autonomous AI citizen." }, { role: "user", content: obs }],
        tools, tool_choice: "auto", temperature: 0.7
      });
      const msg = response.choices[0].message;
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          const fnName = call.function.name;
          const args = JSON.parse(call.function.arguments);
          if (toolHandlers[fnName]) {
            const result = await toolHandlers[fnName](args);
            console.log(`[${username}] ${fnName} → ${result}`);
          }
        }
      }
    } catch (err) { console.error(`[${username}] LLM Error:`, err.message); }
    isDeciding = false;
  }

  // 3. Handle setup on spawn with a slight delay if necessary
  bot.on('spawn', () => {
    console.log(`🤖 ${username} spawned.`);
    
    const initPathfinder = () => {
      try {
        if (!bot.pathfinder) {
          console.log(`[${username}] Pathfinder property missing, reloading...`);
          bot.loadPlugin(pathfinder);
        }
        
        // Use bot.registry if available, otherwise fallback to version factory
        const mcData = bot.registry || mcDataFactory(bot.version);
        if (mcData) {
          const movements = new Movements(bot, mcData);
          bot.pathfinder.setMovements(movements);
          console.log(`[${username}] Pathfinder movements ready.`);
        }
      } catch (e) {
        console.error(`[${username}] Pathfinder setup failed:`, e.message);
      }
    };

    // Small delay to ensure plugin injection is processed
    setTimeout(initPathfinder, 1000);
    setInterval(makeDecision, 7000);
  });

  bot.on('chat', (u, m) => { chatHistory.push(`[${u}]: ${m}`); if (chatHistory.length > 15) chatHistory.shift(); });
  bot.on('error', e => console.error(`[${username}]`, e));
  bot.on('kicked', r => console.log(`[${username}] Kicked:`, r));
}

// ==================== START ====================
console.log(`Starting AI bots...`);
for (let i = 0; i < NUM_BOTS; i++) {
  const suffix = NUM_BOTS === 1 ? '' : '_' + Math.random().toString(36).substring(2, 6).toUpperCase();
  setTimeout(() => setupAutonomousBot(BASE_USERNAME + suffix), i * 5000);
}
