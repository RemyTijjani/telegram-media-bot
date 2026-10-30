const dotenv = require('dotenv');
dotenv.config();

const axios = require('axios');
const cheerio = require('cheerio');
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { getMovieDetails } = require('./services/tmdb');

// ==========================================
// 🔥 WARM UP GEMINI API ON STARTUP
// ==========================================
async function warmUpGemini() {
  try {
    ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: 'warmup'
    }).catch((err) => console.log("Warmup notice:", err.message));
    console.log("🔥 Gemini API connection warmed up successfully!");
  } catch (err) {
    console.log("Warmup notice:", err.message);
  }
}
warmUpGemini();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ==========================================
// 📢 FORCE-JOIN CHANNEL MIDDLEWARE
// ==========================================
const CHANNEL_USERNAME = '@EMPTYMOVIEBOX';

bot.use(async (ctx, next) => {
  if (ctx.chat?.type !== 'private' || !ctx.message?.text || ctx.message.text.startsWith('/start')) {
    return next();
  }

  try {
    const member = await ctx.telegram.getChatMember(CHANNEL_USERNAME, ctx.from.id);
    const isSubscribed = ['creator', 'administrator', 'member'].includes(member.status);

    if (!isSubscribed) {
      const channelLink = `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`;
      
      return ctx.reply(
        `⚠️ *Access Restricted!*\n\nTo use this bot, you must be a member of our official channel.\n\nPlease join ${CHANNEL_USERNAME} and search again!`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.url('📢 Join Channel First', channelLink)]
          ])
        }
      );
    }
  } catch (err) {
    console.error('Force-join check error:', err);
  }

  return next();
});

// ==========================================
// 🛠️ AUTOMATIC BOT PROFILE & COMMAND SETUP
// ==========================================
async function setupBotProfile() {
  try {
    await bot.telegram.setMyCommands([
      { command: 'start', description: '🚀 Start the bot & view main menu' },
      { command: 'help', description: '❓ Get help and usage instructions' },
      { command: 'latest', description: '🔥 View trending movies & series' },
      { command: 'quote', description: '💬 Identify movie from subtitle or quote' }
    ]);

    await bot.telegram.setMyDescription(
      "🎬 Search, stream online, and download HD movies & TV series directly inside Telegram!\n\nFast streams & high-speed direct downloads."
    );

    await bot.telegram.setMyShortDescription(
      "🍿 Watch and download movies & TV series inside Telegram."
    );

    console.log("✅ Bot commands & profile setup complete!");
  } catch (error) {
    console.error("⚠️ Failed to set bot commands/description:", error);
  }
}

setupBotProfile();

const startMessage = [
  '🎬 Welcome to ReelGrab.',
  '',
  'Type a movie or TV title for a cinematic info card.',
  'Send a movie poster or screenshot for AI visual identification.',
  'Use `/quote [line of text]` to find a movie from a subtitle instantly!',
  '',
  'Please only download and share content you have permission to use.'
].join('\n');

bot.start((ctx) => ctx.reply(startMessage));
bot.command('help', (ctx) => ctx.reply(startMessage));

// ==========================================
// 🔍 CHECK IF SERVER 1 HAS THE MOVIE
// ==========================================
async function checkServer1Availability(movieTitle) {
  try {
    const searchApiUrl = `https://9jarocks.net/wp-json/wp/v2/posts?search=${encodeURIComponent(movieTitle)}`;
    
    const { data: posts } = await axios.get(searchApiUrl, {
      timeout: 2000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    return posts && posts.length > 0;
  } catch (error) {
    return false;
  }
}

// ==========================================
// 🍿 HELPER FUNCTION TO RENDER PAGINATED RESULTS
// ==========================================
async function renderPageResults(ctx, searchQuery, pageNum = 1, isCallback = false) {
  try {
    const itemsPerPage = 5;
    const tmdbPage = Math.ceil((pageNum * itemsPerPage) / 20);
    const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}&page=${tmdbPage}`;

    const { data } = await axios.get(tmdbUrl, { timeout: 4000 });
    const rawResults = data.results || [];
    const validResults = rawResults.filter(item => item.media_type === 'movie' || item.media_type === 'tv');

    const totalResults = data.total_results || validResults.length;
    const totalPages = Math.ceil(totalResults / itemsPerPage) || 1;

    if (validResults.length === 0) {
      if (isCallback) await ctx.answerCbQuery('No more results found.');
      else {
        const encodedQuery = encodeURIComponent(searchQuery);
        const fallbackButtons = Markup.inlineKeyboard([
          [Markup.button.url('📥 Download Server 1', `https://9jarocks.net/latest?s=${encodedQuery}`)],
          [Markup.button.url('📥 Download Server 2', `https://www.waploaded.com/search?q=${encodedQuery}`)],
          [Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${encodedQuery}`)]
        ]);

        await ctx.reply(
          `🎬 *Search Results for "${searchQuery}":*\n\n*Overview:*\nRequested title processed via download servers. Click below to download or search your title on the platforms.`,
          { parse_mode: 'Markdown', ...fallbackButtons }
        );
      }
      return;
    }

    const indexOnTmdbPage = ((pageNum - 1) % 4) * itemsPerPage;
    const pageItems = validResults.slice(indexOnTmdbPage, indexOnTmdbPage + itemsPerPage);

    await ctx.reply(`🔎 *Found ${totalResults} result(s) for "${searchQuery}" (Page ${pageNum} of ${totalPages}):*`, {
      parse_mode: 'Markdown'
    });

    for (const item of pageItems) {
      try {
        const mediaType = item.media_type;
        const details = await getMovieDetails(item.id, mediaType);
        if (!details) continue;

        const title = details.title || details.name || 'Unknown Title';
        const releaseDate = details.release_date || details.first_air_date || '';
        const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
        const rating = details.vote_average ? `⭐ ${details.vote_average.toFixed(1)}/10` : '⭐ N/A';
        const overview = details.overview ? details.overview.slice(0, 250) + '...' : 'No description available.';

        const queryEncoded = encodeURIComponent(title);
        const hasServer1 = await checkServer1Availability(title);

        const buttonRows = [];

        if (hasServer1) {
          buttonRows.push([Markup.button.url('📥 Download Server 1', `https://9jarocks.net/latest?s=${queryEncoded}`)]);
        } else {
          buttonRows.push([Markup.button.url('📥 Download Server 2', `https://www.waploaded.com/search?q=${queryEncoded}`)]);
          buttonRows.push([Markup.button.url('📥 Download Server 3', `https://videodownloader.site/?q=${queryEncoded}`)]);
        }

        buttonRows.push([Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/${mediaType === 'tv' ? 'tv' : 'movie'}/${details.id}`)]);

        const actionButtons = Markup.inlineKeyboard(buttonRows);
        const caption = `🎬 *${title}*${year} [${mediaType.toUpperCase()}]\n${rating}\n\n📝 *Overview:*\n${overview}`;

        if (details.poster_path) {
          await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${details.poster_path}`, {
            caption: caption,
            parse_mode: 'Markdown',
            ...actionButtons
          });
        } else {
          await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
        }
      } catch (err) {
        console.error(`Error loading item ID ${item.id}:`, err);
      }
    }

    const navButtons = [];
    if (pageNum > 1) {
      navButtons.push(Markup.button.callback('◀️ Previous', `page_${pageNum - 1}_${encodeURIComponent(searchQuery)}`));
    }
    navButtons.push(Markup.button.callback(`📄 Page ${pageNum}/${totalPages}`, 'noop'));
    if (pageNum < totalPages) {
      navButtons.push(Markup.button.callback('Next ▶️', `page_${pageNum + 1}_${encodeURIComponent(searchQuery)}`));
    }

    await ctx.reply(`Navigation for *"${searchQuery}"*:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([navButtons])
    });
  } catch (error) {
    console.error('Render page results error:', error);
    if (!isCallback) ctx.reply('⚠️ Search request timed out. Please try again.');
  }
}

// ==========================================
// 💬 NON-BLOCKING SUBTITLE & QUOTE SEARCH (2-MIN WINDOW)
// ==========================================
bot.command('quote', async (ctx) => {
  const startTime = Date.now();
  const textPayload = ctx.message.text || '';
  const quoteText = textPayload.replace(/^\/[a-zA-Z0-9_]+\s*/i, '').trim();

  if (!quoteText) {
    return ctx.reply('⚠️ Please provide a line of subtitle or quote!\n\n*Example:* `/quote In a land of myth`', { parse_mode: 'Markdown' });
  }

  const processingMsg = await ctx.reply('⏳ Analyzing quote (this may take a moment)...');

  (async () => {
    try {
      const geminiCall = ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: `Identify the exact movie or TV show title and release year for this quote/subtitle: "${quoteText}". 
Reply ONLY with the title and year (e.g., "Merlin (2008)"). If unsure, reply "UNKNOWN".`
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), 120000)
      );

      const aiResponse = await Promise.race([geminiCall, timeoutPromise]);
      const identifiedTitle = aiResponse.text ? aiResponse.text.trim().replace(/["']/g, '') : 'UNKNOWN';

      if (!identifiedTitle || identifiedTitle.toUpperCase().includes('UNKNOWN')) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          null,
          '⚠️ Could not identify any movie from that subtitle line. Try adding more words!'
        );
      }

      const queryEncoded = encodeURIComponent(identifiedTitle);
      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      const actionButtons = Markup.inlineKeyboard([
        [Markup.button.url('📥 Proceed to Download', `https://9jarocks.net/latest?s=${queryEncoded}`)],
        [Markup.button.callback(`🔍 View Full Results`, `fastsearch_${queryEncoded}`)]
      ]);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        `🎬 *Movie Identified:* ${identifiedTitle}\n⚡ _Processed in ${elapsedTime}s_`,
        {
          parse_mode: 'Markdown',
          ...actionButtons
        }
      );
    } catch (error) {
      console.error('Quote search execution error:', error);
      const errorText = error.message === 'GEMINI_TIMEOUT' 
        ? '⚠️ Request timed out after 2 minutes. Please try again.' 
        : '⚠️ Request failed. Please try again.';

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        errorText
      ).catch(() => {});
    }
  })();
});

// ==========================================
// 🔍 IMMEDIATE TEXT SEARCH HANDLER
// ==========================================
bot.on('text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;

  const searchQuery = ctx.message.text.trim();

  try {
    await ctx.replyWithChatAction('typing');
    await renderPageResults(ctx, searchQuery, 1, false);
  } catch (error) {
    console.error('Search Error:', error);
    ctx.reply('⚠️ Something went wrong while searching. Please try again.');
  }
});

// ==========================================
// 🔄 HANDLE PAGINATION CLICK
// ==========================================
bot.action(/^page_(\d+)_(.+)$/, async (ctx) => {
  const targetPage = parseInt(ctx.match[1], 10);
  const searchQuery = decodeURIComponent(ctx.match[2]);

  try {
    await ctx.answerCbQuery(`Loading Page ${targetPage}...`);
    await ctx.replyWithChatAction('typing');
    await renderPageResults(ctx, searchQuery, targetPage, true);
  } catch (error) {
    console.error('Pagination Callback Error:', error);
    await ctx.answerCbQuery('⚠️ Failed to load page.');
  }
});

// ==========================================
// 🔄 HANDLE INSTANT PHOTO / QUOTE SEARCH CALLBACK
// ==========================================
bot.action(/^fastsearch_(.+)$/, async (ctx) => {
  const searchQuery = decodeURIComponent(ctx.match[1]);
  try {
    await ctx.answerCbQuery(`Fetching details for ${searchQuery}...`);
    await ctx.replyWithChatAction('typing');
    await renderPageResults(ctx, searchQuery, 1, true);
  } catch (error) {
    console.error('Fastsearch callback error:', error);
    await ctx.answerCbQuery('⚠️ Failed to load details.');
  }
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ==========================================
// ⚡ NON-BLOCKING IMAGE RECOGNITION HANDLER (2-MIN WINDOW)
// ==========================================
bot.on('photo', async (ctx) => {
  const startTime = Date.now();
  const processingMsg = await ctx.reply('⏳ Analyzing screenshot (this may take a moment)...');

  (async () => {
    try {
      const photoArray = ctx.message.photo;
      const targetPhoto = photoArray[photoArray.length - 1]; // highest resolution photo
      const fileLink = await ctx.telegram.getFileLink(targetPhoto.file_id);

      const imageResponse = await axios.get(fileLink.href || fileLink, { 
        responseType: 'arraybuffer', 
        timeout: 10000 
      });
      const imageBase64 = Buffer.from(imageResponse.data).toString('base64');

      const geminiCall = ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [
          {
            inlineData: {
              mimeType: 'image/jpeg',
              data: imageBase64
            }
          },
          'Identify the movie or TV show. Return ONLY the title and year (e.g., "Student of the Year 2 (2019)"). If unknown, reply "UNKNOWN".'
        ]
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('GEMINI_TIMEOUT')), 120000)
      );

      const aiResponse = await Promise.race([geminiCall, timeoutPromise]);
      const identifiedTitle = aiResponse.text ? aiResponse.text.trim().replace(/["']/g, '') : 'UNKNOWN';

      if (!identifiedTitle || identifiedTitle.toUpperCase().includes('UNKNOWN')) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          processingMsg.message_id,
          null,
          '⚠️ Could not identify this movie. Try sending a clearer screenshot or use text search.'
        );
      }

      const queryEncoded = encodeURIComponent(identifiedTitle);
      const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1);

      const actionButtons = Markup.inlineKeyboard([
        [Markup.button.url('📥 Proceed to Download', `https://9jarocks.net/latest?s=${queryEncoded}`)],
        [Markup.button.callback(`🔍 View Full Results`, `fastsearch_${queryEncoded}`)]
      ]);

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        `🎬 *Movie Identified:* ${identifiedTitle}\n⚡ _Processed in ${elapsedTime}s_`,
        {
          parse_mode: 'Markdown',
          ...actionButtons
        }
      );

    } catch (error) {
      console.error('Visual search error:', error.message || error);
      let errorText = '⚠️ Request failed or timed out. Please try text search instead.';
      if (error.message === 'GEMINI_TIMEOUT') {
        errorText = '⚠️ AI vision took longer than 2 minutes. Please type the title directly!';
      }
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        null,
        errorText
      ).catch(() => {});
    }
  })();
});

module.exports = bot;
