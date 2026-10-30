const dotenv = require('dotenv');
dotenv.config();

const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const { downloadMedia } = require('./services/socialDownloader');
const { searchMovies, getMovieDetails, searchPerson, getPersonCredits } = require('./services/tmdb');

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
      { command: 'latest', description: '🔥 View trending movies & series' }
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
  'Send a movie poster or screenshot for AI visual identification and download links!',
  '',
  'Please only download and share content you have permission to use.'
].join('\n');

bot.start((ctx) => ctx.reply(startMessage));
bot.command('help', (ctx) => ctx.reply(startMessage));

// ==========================================
// 🍿 HELPER FUNCTION TO RENDER PAGINATED RESULTS
// ==========================================
async function renderPageResults(ctx, searchQuery, pageNum = 1, isCallback = false) {
  const itemsPerPage = 5;
  const tmdbPage = Math.ceil((pageNum * itemsPerPage) / 20);
  const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}&page=${tmdbPage}`;

  const { data } = await axios.get(tmdbUrl);
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
        [Markup.button.url('📥 Download Server 2', `https://videodownloader.site/?q=${encodedQuery}`)]
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

      let buttonRows = [];
      if (mediaType === 'tv') {
        buttonRows = [
          [Markup.button.url('📥 Download Series (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)],
          [Markup.button.url('▶️ Stream Series Online', `https://vidsrc.to/embed/tv/${details.id}`)]
        ];
      } else {
        buttonRows = [
          [Markup.button.url('📥 Download Server 1', `https://9jarocks.net/latest?s=${queryEncoded}`)],
          [Markup.button.url('📥 Download Server 2', `https://videodownloader.site/?q=${queryEncoded}`)],
          [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/movie/${details.id}`)]
        ];
      }

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
}

// ==========================================
// 🔍 HANDLE USER TEXT SEARCHES
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

bot.action('noop', (ctx) => ctx.answerCbQuery());

// ==========================================
// 🆕 /LATEST COMMAND
// ==========================================
bot.command('latest', async (ctx) => {
  try {
    await ctx.replyWithChatAction('typing');

    const tmdbUrl = `https://api.themoviedb.org/3/trending/all/day?api_key=${process.env.TMDB_API_KEY}`;
    const { data } = await axios.get(tmdbUrl);
    const results = (data.results || []).filter(item => item.media_type === 'movie' || item.media_type === 'tv').slice(0, 5);

    if (results.length === 0) {
      return ctx.reply('⚠️ No new releases found at the moment.');
    }

    await ctx.reply('🔥 *Latest Movies & Series Releases:*', { parse_mode: 'Markdown' });

    for (const item of results) {
      const mediaType = item.media_type;
      const title = item.title || item.name || 'Unknown Title';
      const releaseDate = item.release_date || item.first_air_date || 'Coming Soon';
      const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '⭐ N/A';
      const overview = item.overview ? item.overview.slice(0, 250) + '...' : 'No description available.';

      const queryEncoded = encodeURIComponent(title);
      let buttonRows = [];

      if (mediaType === 'tv') {
        buttonRows.push([Markup.button.url('📥 Download Series (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)]);
        buttonRows.push([Markup.button.url('▶️ Stream Series Online', `https://vidsrc.to/embed/tv/${item.id}`)]);
      } else {
        buttonRows.push([Markup.button.url('📥 Download Server 1 (9jaRocks)', `https://9jarocks.net/latest?s=${queryEncoded}`)]);
        buttonRows.push([Markup.button.url('📥 Download Server 2 (VideoDownloader)', `https://videodownloader.site/?q=${queryEncoded}`)]);
        buttonRows.push([Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/movie/${item.id}`)]);
      }

      const actionButtons = Markup.inlineKeyboard(buttonRows);
      const caption = `🎬 *${title}* (${releaseDate.split('-')[0] || '2026'})\n🏷️ Type: *${mediaType.toUpperCase()}*\n${rating}\n\n📝 *Overview:*\n${overview}`;

      if (item.poster_path) {
        await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, { caption, parse_mode: 'Markdown', ...actionButtons });
      } else {
        await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
      }
    }
  } catch (error) {
    console.error('Error fetching latest updates:', error);
    ctx.reply('⚠️ Failed to load latest releases.');
  }
});

// ==========================================
// 📸 AI VISUAL MOVIE SEARCH HANDLER (FIXED MODEL)
// ==========================================
bot.on('photo', async (ctx) => {
  try {
    await ctx.replyWithChatAction('typing');
    await ctx.reply('🔍 *Analyzing your image with AI...*', { parse_mode: 'Markdown' });

    const photoArray = ctx.message.photo;
    const fileId = photoArray[photoArray.length - 1].file_id;
    
    const file = await ctx.telegram.getFile(fileId);
    const photoUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    const imageResponse = await axios.get(photoUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(imageResponse.data);

    const prompt = 'Identify the main movie or TV series shown in this image. Return ONLY a JSON object formatted as: {"query": "Name of Movie"}. If unidentifiable, return {"query": null}.';

    // Using stable gemini-2.0-flash model
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        prompt,
        {
          inlineData: {
            data: imageBuffer.toString('base64'),
            mimeType: 'image/jpeg'
          }
        }
      ]
    });

    const aiOutput = response.text.trim().replace(/```json|```/g, '');
    let result = { query: null };

    try {
      result = JSON.parse(aiOutput);
    } catch (e) {
      result.query = response.text.trim();
    }

    const searchQuery = result.query;

    if (!searchQuery || searchQuery.toLowerCase() === 'null') {
      return ctx.reply('⚠️ Sorry, I could not identify any movie or series in this photo.');
    }

    await ctx.reply(`✨ Identified: *${searchQuery}*! Searching TMDB...`, { parse_mode: 'Markdown' });

    const tmdbUrl = `https://api.themoviedb.org/3/search/multi?api_key=${process.env.TMDB_API_KEY}&query=${encodeURIComponent(searchQuery)}`;
    const tmdbRes = await axios.get(tmdbUrl);
    const results = (tmdbRes.data.results || []).slice(0, 3);

    if (results.length === 0) {
      return ctx.reply(`⚠️ Identified *${searchQuery}*, but couldn't find records.`);
    }

    for (const item of results) {
      const title = item.title || item.name || 'Unknown Title';
      const releaseDate = item.release_date || item.first_air_date || '';
      const year = releaseDate ? ` (${releaseDate.split('-')[0]})` : '';
      const rating = item.vote_average ? `⭐ ${item.vote_average.toFixed(1)}/10` : '⭐ N/A';
      const overview = item.overview ? item.overview.slice(0, 180) + '...' : 'No description available.';

      const queryEncoded = encodeURIComponent(title);
      const actionButtons = Markup.inlineKeyboard([
        [Markup.button.url('📥 Download Server (9jaRocks)', `https://9jarocks.net/latest?s=${queryEncoded}`)],
        [Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/${item.media_type === 'tv' ? 'tv' : 'movie'}/${item.id}`)]
      ]);

      const caption = `🎬 *${title}*${year}\n${rating}\n\n📝 *Overview:*\n${overview}`;

      if (item.poster_path) {
        await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${item.poster_path}`, {
          caption,
          parse_mode: 'Markdown',
          ...actionButtons
        });
      } else {
        await ctx.reply(caption, { parse_mode: 'Markdown', ...actionButtons });
      }
    }

  } catch (error) {
    console.error('SDK Visual search error:', error);
    ctx.reply('⚠️ Failed to process the image. Please try again.');
  }
});

module.exports = bot;
