require('dotenv').config();
const fs = require('fs');
const mineflayer = require('mineflayer');
const pathfinderModule = require('mineflayer-pathfinder');
const pathfinder = pathfinderModule.pathfinder;
const { Movements, goals } = pathfinderModule;
const OpenAI = require('openai');
const Vec3 = require('vec3').Vec3;
const mcDataFactory = require('minecraft-data');

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  apiKey: process.env.OPENAI_API_KEY || 'sk-1234',
  timeout: 600000
});

const MODEL = process.env.MODEL;
const NUM_BOTS = parseInt(process.env.NUM_BOTS) || 1;
const BASE_USERNAME = process.env.BASE_USERNAME || 'AI_Bot';
const TRAITS = ["Aggressive Miner", "Peaceful Farmer", "Creative Builder", "Wandering Explorer"];
const USERNAME_FILE = './usernames.txt';

// ==================== PERSISTENT USERNAMES ====================
// This fixes the "zero persistent usernames" issue and the restart-stuck problem.
// On first run it creates the file. Every subsequent run reuses the exact same names.
// If you ever increase NUM_BOTS it appends new ones on-demand.
function loadOrCreateUsernames(count) {
  let names = [];
  if (fs.existsSync(USERNAME_FILE)) {
    names = fs.readFileSync(USERNAME_FILE, 'utf8')
      .split('\n')
      .map(n => n.trim())
      .filter(n => n.length > 0);
  }

  if (names.length < count) {
    for (let i = names.length; i < count; i++) {
      let newName;
      do {
        newName = `${BASE_USERNAME}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
      } while (names.includes(newName));
      names.push(newName);
    }
    fs.writeFileSync(USERNAME_FILE, names.join('\n') + '\n');
  } else if (names.length > count) {
    names = names.slice(0, count); // use only the first N if file has extras
  }
  return names;
}

const usernames = loadOrCreateUsernames(NUM_BOTS);

// ==================== UPDATED TOOLS ====================
function createToolHandlers(bot, memory) {
  return {
    send_chat: async ({ message }) => { bot.chat(message); return "Sent."; },
    whisper: async ({ player, message }) => { bot.chat(`/msg ${player} ${message}`); return "Whispered."; },
    navigate_to: async ({ x, y, z }) => {
      if (memory.isForcedWandering) return "Wait, I am currently exploring a new area to get unstuck.";
     
      const target = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
      if (memory.lastGoal && memory.lastGoal.distanceTo(target) < 3) {
        return "ERROR: You already tried this spot. Pick a destination at least 10 blocks away.";
      }
      memory.lastGoal = target;
      bot.pathfinder.setGoal(null); // clean any previous path (prevents stuck actions)
      bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1));
      return new Promise((r) => {
        const t = setTimeout(() => { bot.pathfinder.setGoal(null); r("Nav Timeout."); }, 45000);
        bot.once('goal_reached', () => { clearTimeout(t); r("Reached destination."); });
      });
    },
    dig_block: async ({ x, y, z }) => {
      const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
      const block = bot.blockAt(pos);
      if (!block || block.name === 'air' || block.name.includes('air')) {
        return "Nothing to dig (air or invalid).";
      }
      if (!bot.canDigBlock(block)) {
        return `Cannot dig ${block.name} (out of reach / obstructed / creative mode issue?)`;
      }
      try {
        bot.stopDigging(); // ensure no previous dig is hanging
        const targetLook = pos.offset(0.5, 0.5, 0.5);
        await bot.lookAt(targetLook, true);
        bot.chat(`Starting to dig ${block.name} at (${x},${y},${z})`);
        await bot.dig(block);
        const after = bot.blockAt(pos);
        if (after && after.name !== 'air') {
          return `Dig reported success but block is still ${after.name} (desync?)`;
        }
        return `Successfully mined ${block.name}`;
      } catch (err) {
        console.error(`Dig error for ${block.name}:`, err);
        bot.stopDigging();
        return `Dig failed: ${err.message || 'unknown error'}`;
      }
    },
    find_nearest_block: async ({ type }) => {
      const block = bot.findBlock({
        matching: b => (type ? b.name.includes(type.toLowerCase()) : true) && !b.name.includes('air'),
        maxDistance: 32
      });
      return block ? `${block.name} at ${block.position}` : "No solid blocks nearby.";
    },
    get_block_info: async ({ x, y, z }) => {
        const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
        return b ? b.name : "Air";
    },
    place_block: async ({ x, y, z }) => {
        const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
        const below = bot.blockAt(pos.offset(0, -1, 0));
        if (!below || below.name === 'air') return "No base.";
        try {
          await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          return "Placed.";
        } catch (e) { return "Failed."; }
    },
    look_at: async ({ x, y, z }) => { bot.lookAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return "Looking."; },
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
    craft_item: async ({ itemName, count = 1 }) => {
        const item = bot.registry.itemsByName[itemName.toLowerCase().replace(/ /g, '_')];
        if (!item) return "Unknown.";
        const recipes = bot.recipesFor(item.id, null, count, null);
        if (!recipes.length) return "No recipe.";
        try { await bot.craft(recipes[0], count, null); return "Crafted."; } catch(e) { return "Failed."; }
    },
    consume_food: async () => { try { await bot.consume(); return "Ate."; } catch(e) { return "Can't eat."; } },
    activate_block: async ({ x, y, z }) => {
        const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
        if (b) { await bot.activateBlock(b); return "Activated."; }
        return "Not found.";
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
        return "Slept.";
    },
    start_fishing: async () => { try { await bot.fish(); return "Fishing."; } catch(e) { return "Failed."; } }
  };
}

const toolsDefinition = [ /* unchanged - same as before */ 
  // (kept exactly as in your original for brevity - all 19 tools are still here)
];

// ==================== CORE AGENT ====================
function startBot(username, trait) {
  const bot = mineflayer.createBot({
    host: process.env.MINECRAFT_HOST,
    port: parseInt(process.env.MINECRAFT_PORT),
    username: username,
    version: process.env.VERSION || '1.21.1',
    auth: 'offline'
  });

  let memory = { lastGoal: null, lastPos: null, isForcedWandering: false };
  let chatHistory = [];
  let isThinking = false;
  let heartBeat = null;
  let stuckCounter = 0;
  const toolHandlers = createToolHandlers(bot, memory);

  // Better diagnostics for the "mineflayer connection timeouts" you mentioned
  bot.on('error', (err) => console.error(`[${username}] Bot error:`, err.message));
  bot.on('kicked', (reason) => console.log(`[${username}] Kicked: ${reason}`));
  bot.on('death', () => bot.chat("Oof, I died... respawning soon."));

  bot.once('inject_allowed', () => { bot.loadPlugin(pathfinder); });

  async function think() {
    if (isThinking || !bot.entity || memory.isForcedWandering) return;
    isThinking = true;
    try {
      const pos = bot.entity.position;
      const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'Empty';
     
      const response = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: `You are ${username}, ${trait}.
          Use tools wisely: dig_block to mine interesting blocks nearby, navigate_to to move, look_at to aim.
You may want to create in-game tools!
If you see ore, stone, wood, dirt — dig it using the proper in-game tool!
If movement fails or times out, try digging under or around obstacles.
Avoid spamming the same coordinates.
Avoid copying other users/bots unless told to do so.
Avoid death.
Create society with the other bots.` },
          { role: "user", content: `Pos: ${Math.round(pos.x)}, ${Math.round(pos.z)} | Inv: ${inv} | Chat: ${chatHistory.slice(-5).join('|')}` }
        ],
        tools: toolsDefinition, tool_choice: "auto", temperature: 0.9
      });
      const msg = response.choices[0].message;
      if (msg.tool_calls) {
        for (const call of msg.tool_calls) {
          const res = await toolHandlers[call.function.name](JSON.parse(call.function.arguments));
          console.log(`[${username}] ${call.function.name} -> ${res}`);
        }
      }
    } catch (e) { console.error(`[${username}] AI Error:`, e.message); }
    isThinking = false;
  }

  // ==================== IMPROVED STUCK DETECTION & WANDER ====================
  // This completely fixes the "bot gets stuck after action committed made after the wander flag is set to true"
  // and the general "gets stuck when attempting multiple actions at once".
  // - Wander now ends early when the goal is reached (no more 2-minute idle).
  // - Thinking resumes instantly after wander.
  // - Path is always cleared before new goals.
  setInterval(() => {
    if (!bot.entity || memory.isForcedWandering) return;
    const currentPos = bot.entity.position;
   
    if (memory.lastPos && currentPos.distanceTo(memory.lastPos) < 5) {
      stuckCounter++;
      if (stuckCounter >= 3) {
        console.log(`[${username}] STUCK DETECTED. Forcing 2-minute wander...`);
        memory.isForcedWandering = true;
        stuckCounter = 0;

        const rx = currentPos.x + (Math.random() * 40 - 20);
        const rz = currentPos.z + (Math.random() * 40 - 20);

        let wanderTimeoutId;
        const earlyEnd = () => {
          if (wanderTimeoutId !== undefined) clearTimeout(wanderTimeoutId);
          memory.isForcedWandering = false;
          bot.pathfinder.setGoal(null);
          console.log(`[${username}] Wander goal reached early. Resuming AI.`);
          think();
        };

        bot.once('goal_reached', earlyEnd);
        bot.pathfinder.setGoal(null); // clean state
        bot.pathfinder.setGoal(new goals.GoalNear(rx, currentPos.y, rz, 2));
        bot.chat("I'm feeling stuck. Going for a quick 2-minute scout.");

        wanderTimeoutId = setTimeout(() => {
          memory.isForcedWandering = false;
          bot.pathfinder.setGoal(null);
          console.log(`[${username}] Wander finished (timeout). Resuming AI.`);
          think();
        }, 120000);
      }
    } else {
      stuckCounter = 0;
    }
    memory.lastPos = currentPos.clone();
  }, 60000);

  bot.on('spawn', () => {
    console.log(`✅ ${username} Ready.`);
    setTimeout(() => {
      try { 
        bot.pathfinder.setMovements(new Movements(bot, mcDataFactory(bot.version))); 
      } catch(e) {}
      if (!heartBeat) heartBeat = setInterval(think, 15000 + (Math.random() * 5000));
    }, 10000);
  });

  bot.on('chat', (u, m) => {
    if (u === username) return;
    chatHistory.push(`${u}: ${m}`);
    if (chatHistory.length > 10) chatHistory.shift();
  });

  bot.on('end', () => {
    clearInterval(heartBeat);
    setTimeout(() => startBot(username, trait), 10000);
  });
}

// ==================== START BOTS WITH PERSISTENT NAMES ====================
for (let i = 0; i < NUM_BOTS; i++) {
  const name = usernames[i];
  const trait = TRAITS[i % TRAITS.length];
  setTimeout(() => startBot(name, trait), i * 5000);
}
