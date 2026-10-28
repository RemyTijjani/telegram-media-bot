const { Telegraf, Markup } = require('telegraf');
const dotenv = require('dotenv');
const { downloadMedia } = require('./services/socialDownloader');
const { searchMovies, getMovieDetails, searchPerson, getPersonCredits } = require('./services/tmdb');
const { identifyActor } = require('./services/actorMatcher');

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const SOCIAL_URL_PATTERN = /https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|twitter\.com|x\.com)\/[^\s<]+/i;

const startMessage = [
  '🎬 Welcome to ReelGrab.',
  '',
  'Paste a YouTube, TikTok, Instagram, Facebook, or X link and I will prepare the video.',
  'Type a movie or TV title for a cinematic info card.',
  'Send an actor photo for recognition and a filmography lookup.',
  '',
  'Please only download and share content you have permission to use.'
].join('\n');

function cleanUrl(value) {
  return value.replace(/[),.!?]+$/, '');
}

function movieButtons(movieId, movieTitle) {
  // Format the movie title safely for the web search URL
  const query = encodeURIComponent(movieTitle);

  return Markup.inlineKeyboard([
    [
      // Button 1: Takes user straight to videodownloader.site with the movie title pre-filled
      Markup.button.url('📥 Download Movie', `https://videodownloader.site/?s=${query}`)
    ],
    [
      // Button 2: Stream button for instant playback
      Markup.button.url('▶️ Stream Online', `https://vidsrc.to/embed/movie/${movieId}`)
    ]
  ]);
}

function movieCaption(movie) {
  const year = movie.release_date ? movie.release_date.slice(0, 4) : '—';
  const rating = typeof movie.vote_average === 'number' ? movie.vote_average.toFixed(1) : '—';
  const genres = movie.genres?.length ? movie.genres.join(', ') : 'Genre unavailable';
  const overview = movie.overview || 'No overview is available for this title.';
  return [
    `🎬 ${movie.title} (${year})`,
    `⭐ ${rating} / 10`,
    `${genres}`,
    '',
    overview
  ].join('\n');
}

bot.start((ctx) => ctx.reply(startMessage));

bot.command('help', (ctx) => ctx.reply(startMessage));

bot.on('photo', async (ctx) => {
  await ctx.reply('🔎 Looking at the photo and checking the film database…');
  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const fileUrl = await ctx.telegram.getFileLink(photo.file_id);
    const actorName = await identifyActor(fileUrl.toString());
    if (!actorName) {
      await ctx.reply('I could not recognize an actor in that image. Try a clearer, front-facing photo.');
      return;
    }

    const person = await searchPerson(actorName);
    if (!person) {
      await ctx.reply(`I recognized ${actorName}, but could not find a matching film profile.`);
      return;
    }

    const credits = await getPersonCredits(person.id);
    const lines = credits.length
      ? credits.map((credit) => {
          const year = credit.release_date ? credit.release_date.slice(0, 4) : '—';
          return `• ${credit.title}${year !== '—' ? ` (${year})` : ''}`;
        })
      : ['No movie credits were found.'];
    const caption = [`🎭 ${person.name}`, '', ...lines].join('\n');
    const profileUrl = person.profile_path ? `https://image.tmdb.org/t/p/w500${person.profile_path}` : null;
    if (profileUrl) {
      await ctx.replyWithPhoto(profileUrl, { caption });
    } else {
      await ctx.reply(caption);
    }
  } catch (error) {
    console.error('Actor lookup failed:', error.message);
    await ctx.reply('I could not complete the actor lookup right now. Please try again with another image.');
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const urlMatch = text.match(SOCIAL_URL_PATTERN);
  if (urlMatch) {
    const url = cleanUrl(urlMatch[0]);
    await ctx.reply('⬇️ Preparing your video…');
    try {
      const mediaUrl = await downloadMedia(url);
      try {
        await ctx.replyWithVideo({ url: mediaUrl }, { caption: 'Ready to watch.' });
      } catch (sendError) {
        console.error('Telegram video send failed:', sendError.message);
        await ctx.reply('The file is ready, but Telegram could not send it directly.', Markup.inlineKeyboard([
          [Markup.button.url('Download video', mediaUrl)]
        ]));
      }
    } catch (error) {
      console.error('Social download failed:', error.message);
      await ctx.reply('I could not process that link. Check that it is public and try again.');
    }
    return;
  }

  await ctx.replyWithChatAction('typing');
  try {
    const results = await searchMovies(text);
    if (!results.length) {
      await ctx.reply('I could not find that movie or show. Try the full title or a different spelling.');
      return;
    }
    const movie = await getMovieDetails(results[0].id, results[0].media_type);
    const options = movieButtons(movie.id);
    if (movie.poster_path) {
      await ctx.replyWithPhoto(`https://image.tmdb.org/t/p/w500${movie.poster_path}`, {
        caption: movieCaption(movie),
        ...options
      });
    } else {
      await ctx.reply(movieCaption(movie), options);
    }
  } catch (error) {
    console.error('Movie search failed:', error.message);
    await ctx.reply('Movie search is temporarily unavailable. Please try again shortly.');
  }
});

bot.action(/^quality:(\d+):(480|720|1080)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Movie streaming links are not configured. Use a licensed service to watch this title.');
});

bot.catch((error) => console.error('Unhandled bot error:', error));

module.exports = bot;
