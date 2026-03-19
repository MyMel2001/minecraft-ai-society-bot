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
      if (!bot.pathfinder) return "Pathfinder failed.";
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 1));
      return new Promise((r) => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); r("Timeout"); }, 45000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached"); });
      });
    },
    dig_block: async ({ x, y, z }) => { 
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b) { await bot.dig(b); return "Mined"; } return "No block";
    },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      const b = bot.blockAt(pos.offset(0, -1, 0));
      if (b) { await bot.placeBlock(b, new Vec3(0, 1, 0)); return "Placed"; } return "No base";
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking"; },
    equip_item: async ({ itemName }) => {
      const i = bot.inventory.items().find(it => it.name.includes(itemName.toLowerCase()));
      if (i) { await bot.equip(i, 'hand'); return "Equipped"; } return "Not found";
    },
    attack_entity: async ({ entityId }) => { 
      const e = bot.entities[entityId]; if (e) { bot.attack(e); return "Attacked"; } return "No entity"; 
    },
    interact_entity: async ({ entityId }) => { 
      const e = bot.entities[entityId]; if (e) { bot.useOn(e); return "Interacted"; } return "No entity"; 
    },
    get_block_info: async ({ x, y, z }) => { return bot.blockAt(new Vec3(x, y, z))?.name || "None"; },
    find_nearest_block: async ({ type }) => {
      const b = bot.findBlock({ matching: bl => bl.name.includes(type), maxDistance: 32 });
      return b ? `${b.name} @ ${b.position}` : "None";
    },
    craft_item: async ({ itemName, count = 1 }) => {
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      if (!item) return "Unknown item";
      const recipes = bot.recipesFor(item.id, null, count, null);
      if (recipes.length) { await bot.craft(recipes[0], count, null); return "Crafted"; } return "No recipe";
    },
    consume_food: async () => { try { await bot.consume(); return "Ate"; } catch(e) { return "Can't eat"; } },
    activate_block: async ({ x, y, z }) => { 
      const b = bot.blockAt(new Vec3(x, y, z));
      if (b) { await bot.activateBlock(b); return "Activated"; } return "No block";
    },
    use_held_item: async () => { await bot.useItem(); return "Used"; },
    toss_item: async ({ itemName, count = 1 }) => {
      const i = bot.inventory.items().find(it => it.name.includes(itemName.toLowerCase()));
      if (i) { await bot.toss(i.type, null, count); return "Tossed"; } return "Not in inv";
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return "Set"; },
    sleep_in_bed: async () => { 
      const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 16 });
      if (bed) { await bot.sleep(bed); return "Slept"; } return "No bed";
    },
    start_fishing: async () => { try { await bot.fish(); return "Fishing"; } catch(e) { return "Failed"; } }
  };
}

function getObservation(bot) {
  if (!bot.entity) return "Loading...";
  const pos = bot.entity.position;
  const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty';
  return `Pos: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)} | HP: ${bot.health} | Hunger: ${bot.food} | Inv: ${inv}`;
}

function setupAutonomousBot(username) {
  const version = process.env.VERSION || '1.21.1';
  
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: version, 
    auth: 'offline'
  });

  let isDeciding = false;
  const toolHandlers = createToolHandlers(bot);

  // THE FIX: Wait for Mineflayer to finalize the 1.21 registry before loading Pathfinder
  bot.once('inject_allowed', () => {
    bot.loadPlugin(pathfinder);
    console.log(`[${username}] Plugin injected.`);
  });

  bot.on('spawn', () => {
    console.log(`🤖 ${username} joined!`);
    
    // Set up pathfinder movements
    setTimeout(() => {
      try {
        const mcData = mcDataFactory(bot.version);
        const movements = new Movements(bot, mcData);
        bot.pathfinder.setMovements(movements);
        console.log(`[${username}] Pathfinder ready.`);
      } catch (e) {
        console.error(`[${username}] Pathfinder error: ${e.message}`);
      }
    }, 2000);

    // AI Decision Loop
    setInterval(async () => {
      if (isDeciding || !bot.entity) return;
      isDeciding = true;
      try {
        const obs = getObservation(bot);
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: "You are an AI player in Minecraft. Act helpful and autonomous." },
            { role: "user", content: `Observation: ${obs}. Decide your next action.` }
          ],
          tools: tools,
          tool_choice: "auto"
        });

        const msg = response.choices[0].message;
        if (msg.tool_calls) {
          for (const call of msg.tool_calls) {
            const result = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
            console.log(`[${username}] ${call.function.name}: ${result}`);
          }
        }
      } catch (e) { console.error(`[${username}] AI Error:`, e.message); }
      isDeciding = false;
    }, 12000);
  });

  bot.on('error', e => console.log(`[${username}] Connection Error: ${e.message}`));
  bot.on('kicked', r => console.log(`[${username}] Kicked: ${r}`));
}

// Start sequence
console.log("Launching Society Bots...");
for (let i = 0; i < NUM_BOTS; i++) {
  const name = `${BASE_USERNAME}_${i}`;
  setTimeout(() => setupAutonomousBot(name), i * 5000);
}
