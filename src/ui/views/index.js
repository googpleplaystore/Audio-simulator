// View registry: route name → view factory (app, params, query, disposer) → {el, title, mounted?, destroy?}

import {
  homeView, songsView, albumsView, albumView, artistsView, artistView, genresView, genreView, likedView, playlistsView, playlistView, searchView,
} from './library.js';
import { roomView } from './room.js';
import { hardwareView, hardwareDetailView } from './hardware.js';
import { receiverView } from './receiver.js';
import { crossoverView } from './crossover.js';
import { eqView } from './eq.js';
import { analyzersView, bakeView, settingsView, nowPlayingView } from './studio.js';
import { measureView } from './measure.js';

export const VIEWS = {
  home: homeView,
  search: searchView,
  songs: songsView,
  albums: albumsView,
  album: albumView,
  artists: artistsView,
  artist: artistView,
  genres: genresView,
  genre: genreView,
  liked: likedView,
  playlists: playlistsView,
  playlist: playlistView,
  nowPlaying: nowPlayingView,
  room: roomView,
  hardware: hardwareView,
  hardwareDetail: hardwareDetailView,
  receiver: receiverView,
  crossover: crossoverView,
  eq: eqView,
  analyzers: analyzersView,
  measure: measureView,
  bake: bakeView,
  settings: settingsView,
};
