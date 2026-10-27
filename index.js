const bot = require('./bot');

if (!process.env.BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

bot.launch().then(() => {
  console.log('ReelGrab bot is running');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
