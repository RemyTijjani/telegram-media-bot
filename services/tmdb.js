const axios = require('axios');

function tmdbClient() {
  if (!process.env.TMDB_API_KEY) throw new Error('TMDB_API_KEY is not configured');
  return axios.create({
    baseURL: 'https://api.themoviedb.org/3',
    timeout: 15000,
    params: { api_key: process.env.TMDB_API_KEY, language: 'en-US' }
  });
}

async function searchMovies(query) {
  if (!query) return [];
  const { data } = await tmdbClient().get('/search/multi', { params: { query, include_adult: false } });
  return (data.results || []).filter((item) => item.media_type === 'movie' || item.media_type === 'tv').slice(0, 5).map((item) => ({
    ...item,
    title: item.title || item.name,
    release_date: item.release_date || item.first_air_date
  }));
}

async function getMovieDetails(id, mediaType = 'movie') {
  const endpoint = mediaType === 'tv' ? `/tv/${encodeURIComponent(id)}` : `/movie/${encodeURIComponent(id)}`;
  const { data } = await tmdbClient().get(endpoint);
  return {
    ...data,
    title: data.title || data.name,
    release_date: data.release_date || data.first_air_date,
    genres: (data.genres || []).map((genre) => genre.name)
  };
}

async function searchPerson(name) {
  const { data } = await tmdbClient().get('/search/person', { params: { query: name, include_adult: false } });
  return data.results?.[0] || null;
}

async function getPersonCredits(id) {
  const { data } = await tmdbClient().get(`/person/${encodeURIComponent(id)}/movie_credits`);
  return (data.cast || []).sort((a, b) => (b.release_date || '').localeCompare(a.release_date || '')).filter((credit, index, all) => (
    all.findIndex((item) => item.id === credit.id) === index
  ));
}

module.exports = { searchMovies, getMovieDetails, searchPerson, getPersonCredits };
