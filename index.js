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
        const t = setTimeout(() => r("Timeout"), 30000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached"); });
      });
    },
    dig_block: async ({ x, y, z }) => { await bot.dig(bot.blockAt(new Vec3(x, y, z))); return "Mined"; },
    place_block: async ({ x, y, z }) => {
      const pos = new Vec3(x, y, z);
      await bot.placeBlock(bot.blockAt(pos.offset(0, -1, 0)), new Vec3(0, 1, 0));
      return "Placed";
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(x, y, z)); return "Looking"; },
    equip_item: async ({ itemName }) => {
      const i = bot.inventory.items().find(it => it.name.includes(itemName.toLowerCase()));
      if (i) await bot.equip(i, 'hand'); return i ? "Equipped" : "Not found";
    },
    attack_entity: async ({ entityId }) => { const e = bot.entities[entityId]; if (e) bot.attack(e); return e ? "Attacked" : "No entity"; },
    interact_entity: async ({ entityId }) => { const e = bot.entities[entityId]; if (e) bot.useOn(e); return e ? "Interacted" : "No entity"; },
    get_block_info: async ({ x, y, z }) => { return bot.blockAt(new Vec3(x, y, z))?.name || "None"; },
    find_nearest_block: async ({ type }) => {
      const b = bot.findBlock({ matching: bl => bl.name.includes(type), maxDistance: 32 });
      return b ? `${b.name} @ ${b.position}` : "None";
    },
    craft_item: async ({ itemName, count = 1 }) => {
      const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
      const recipes = bot.recipesFor(item.id, null, count, null);
      if (recipes.length) await bot.craft(recipes[0], count, null); return "Crafted";
    },
    consume_food: async () => { await bot.consume(); return "Ate"; },
    activate_block: async ({ x, y, z }) => { await bot.activateBlock(bot.blockAt(new Vec3(x, y, z))); return "Activated"; },
    use_held_item: async () => { await bot.useItem(); return "Used"; },
    toss_item: async ({ itemName, count = 1 }) => {
      const i = bot.inventory.items().find(it => it.name.includes(itemName.toLowerCase()));
      if (i) await bot.toss(i.type, null, count); return "Tossed";
    },
    set_control_state: async ({ control, state }) => { bot.setControlState(control, state); return "Set"; },
    sleep_in_bed: async () => { await bot.sleep(bot.findBlock({ matching: b => b.name.includes('bed') })); return "Slept"; },
    start_fishing: async () => { await bot.fish(); return "Fishing"; }
  };
}

function setupAutonomousBot(username) {
  const version = process.env.VERSION || '1.20.1';
  
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: version,
    auth: 'offline'
  });

  let chatHistory = [];
  let isDeciding = false;
  const toolHandlers = createToolHandlers(bot);

  // CRITICAL: Delay plugin injection until Mineflayer clears the "Injection Allowed" flag
  bot.on('inject_allowed', () => {
    // Force set version again just in case
    bot.version = version; 
    try {
      bot.loadPlugin(pathfinder);
      console.log(`[${username}] Pathfinder injected.`);
    } catch (e) {
      console.error(`[${username}] Injection error:`, e.message);
    }
  });

  bot.on('spawn', () => {
    console.log(`🤖 ${username} online.`);
    
    // We wait 2 seconds after spawn to ensure pathfinder properties are attached
    setTimeout(() => {
      try {
        const mcData = mcDataFactory(bot.version);
        bot.pathfinder.setMovements(new Movements(bot, mcData));
        console.log(`[${username}] Movements ready.`);
      } catch (e) {
        console.error(`[${username}] Setup error:`, e.message);
      }
    }, 2000);

    setInterval(async () => {
      if (isDeciding || !bot.entity) return;
      isDeciding = true;
      try {
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages: [{ role: "system", content: "You are a Minecraft AI." }, { role: "user", content: "Decide your next action." }],
          tools, tool_choice: "auto"
        });
        const msg = response.choices[0].message;
        if (msg.tool_calls) {
          for (const call of msg.tool_calls) {
            const result = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
            console.log(`[${username}] ${call.function.name}: ${result}`);
          }
        }
      } catch (e) {}
      isDeciding = false;
    }, 10000);
  });

  bot.on('chat', (u, m) => chatHistory.push(`[${u}]: ${m}`));
}

for (let i = 0; i < NUM_BOTS; i++) {
  setTimeout(() => setupAutonomousBot(BASE_USERNAME + '_' + i), i * 5000);
}
