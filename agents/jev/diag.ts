// Ad-hoc diagnostics against a running dev stack (agents/jev/dev-stack.sh up).
//   cd <rs-sdk> && bun bots/jev/diag.ts [botname]
import { BotSDK } from '../../sdk/index';
import { BotActions } from '../../sdk/actions';

const bot_name = process.argv[2] || 'agent1';
const sdk = new BotSDK({ botUsername: bot_name, password: 'test', gatewayUrl: 'ws://localhost:7780', connectionMode: 'control', autoLaunchBrowser: false, showChat: false });
await sdk.connect();
await sdk.waitForCondition(s => s.inGame && s.skills.length > 0 && !!s.player && s.player.worldX > 0, 60_000);
const bot = new BotActions(sdk);
const st = () => sdk.getState()!;
const pos = () => `(${st().player!.worldX}, ${st().player!.worldZ})`;
const msgs = (n = 5) => st().gameMessages.filter(m => m.type === 0).slice(-n).map(m => m.text);

console.log('start', pos(), 'hp', st().player!.hp, 'inv', st().inventory.map(i => `${i.name}x${i.count}`).join(', '));
console.log('skills', st().skills.map(k => `${k.name}:${k.baseLevel}`).join(' '));

// 1. walking speed: Lumbridge -> Draynor bank
let t0 = Date.now();
let r = await bot.walkTo(3092, 3243, 3);
console.log(`walk to Draynor bank: ${r.success} ${r.message} in ${((Date.now() - t0) / 1000).toFixed(1)}s, now ${pos()}`);
t0 = Date.now();
r = await bot.walkTo(3222, 3218, 3);
console.log(`walk back to Lumbridge: ${r.success} ${r.message} in ${((Date.now() - t0) / 1000).toFixed(1)}s, now ${pos()}`);

// 2. pickpocket men x5
for (let i = 0; i < 5; i++) {
    const man = sdk.findNearbyNpc(/^man$/i, { reachable: true });
    if (!man) { console.log('no man nearby'); break; }
    t0 = Date.now();
    const pr = await bot.pickpocketNpc(man);
    console.log(`pickpocket #${i + 1}: ${JSON.stringify(pr)} in ${((Date.now() - t0) / 1000).toFixed(1)}s; msgs=${JSON.stringify(msgs(3))}; hp=${st().player!.hp}`);
    await new Promise(res => setTimeout(res, 400));
}

// 3. Bob's axes stock
r = await bot.walkTo(3231, 3204, 3);
const shop = await bot.openShop(/bob/i);
console.log('open Bob:', shop.success, shop.message);
if (st().shop.isOpen) {
    console.log('Bob sells:', st().shop.shopItems.map(i => `${i.name} x${i.count} buy=${i.buyPrice} sell=${i.sellPrice}`).join(' | '));
    console.log('Bob buys my:', st().shop.playerItems.map(i => `${i.name} sell=${i.sellPrice}`).join(' | '));
    await bot.closeShop();
}

// 4. General store sell prices for the kit
r = await bot.walkTo(3211, 3246, 3);
const gs = await bot.openShop(/shop keeper|shop assistant/i);
console.log('open general store:', gs.success, gs.message);
if (st().shop.isOpen) {
    console.log('GS sells:', st().shop.shopItems.map(i => `${i.name} x${i.count} buy=${i.buyPrice}`).join(' | '));
    console.log('GS pays for my items:', st().shop.playerItems.map(i => `${i.name} sell=${i.sellPrice}`).join(' | '));
    await bot.closeShop();
}

// 5. chop timing at level 1 with bronze axe
r = await bot.walkTo(3195, 3220, 5);
t0 = Date.now();
let logs = 0;
for (let i = 0; i < 5; i++) { const cr = await bot.chopTree(/^tree$/i); if (cr.success) logs++; else console.log('chop fail', cr.message); }
console.log(`chopped ${logs} logs in ${((Date.now() - t0) / 1000).toFixed(1)}s; WC xp ${sdk.getSkillXp('Woodcutting')}`);

await sdk.disconnect();
process.exit(0);
