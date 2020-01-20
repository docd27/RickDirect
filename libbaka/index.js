require('dotenv').config();

module.exports = {
  ...module.exports,
  ...require('./util.js'),
  ...require('./twitch.js'),
  ...require('./intro.js'),
};
