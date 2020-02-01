const
  tmi = require('tmi.js'),
  axios = require('axios'),
  denque = require('denque'),
  stringWidth = require('string-width');

const {COMPOSITE_TRANSPARENT, compositeFrameFast} = require('./util.js');


const ANSI_RESET = '\x1B[0m';
const ANSIRGB24_FG = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const ANSIRGB24_BG = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;


const CHAT_FG_WHITE = `${ANSIRGB24_FG(239, 239, 241)}`;
const CHAT_BG_PURPLE = `${ANSIRGB24_BG(119, 44, 232)}`;
const CHAT_BG_BLACK = `${ANSIRGB24_BG(24, 24, 27)}`;

const SUB_FG = `${ANSIRGB24_FG(255, 255, 255)}`;
const SUB_BG = `${ANSIRGB24_BG(0, 0, 0)}`;

/**
 *
 * @return {AsyncGeneratorFunction}
 * @param {AsyncGenerator} frameGenerator
 * @param {AsyncGenerator} subtitleSource
 * @param {TwitchConnection} twitchConnection
 * @param {Number} innerWidth
 * @param {Number} innerHeight
 * @param {Number} chatWidth
 */
const twitchUI = (frameGenerator, subtitleSource, twitchConnection,
    innerWidth=80, innerHeight = 24, chatWidth = 20, subtitleHoldUS = 5000000n) => async function* () {
  const subtitleShiftVert = (innerHeight + 1) - 2;
  const subtitleHorzPadding = 2;
  const subtitleInnerWidth = innerWidth - 2 * subtitleHorzPadding;

  let subtitleSyncPts = 0n;
  let subtitleSyncDelay = 0n;
  let subtitleShiftRight = 0;
  const subtitleQueue = new denque();
  const consumeSubtitleStream = async () => {
    for await (const data of subtitleSource) {
      if (data.length) {
        processDatums: for (let i = 0; i < data.length; i++) {
          const datum = data[i];
          if (!datum.type) {
            console.error('Bad datum:', datum);
            continue processDatums;
          }
          switch (datum.type) {
            case 'delete':
              if (!subtitleQueue.isEmpty()) subtitleQueue.pop();
              break;
            case 'word': {
              const wordObj = {
                timestamp: BigInt(datum.value.timestamp) * 1000n,
                word: datum.value.word,
              };
              subtitleSyncDelay = subtitleSyncPts - wordObj.timestamp;
              subtitleQueue.push(wordObj); // Push the new word
              break;
            }
            default:
              console.error('Bad datum:', datum);
              continue processDatums;
          }
        }
      }
    }
    console.log('Subtitle reader exit');
  };
  const renderSubtitles = () => {
    // Discard old words from front of queue
    while (!subtitleQueue.isEmpty() &&
      subtitleQueue.peekFront().timestamp + subtitleSyncDelay + subtitleHoldUS < subtitleSyncPts) {
      // subtitleShiftRight += subtitleQueue.peekFront().word.length + 1; // plus spacer
      subtitleQueue.shift();
    }
    // if (subtitleQueue.isEmpty()) subtitleShiftRight = 0;
    const subtitleFull = COMPOSITE_TRANSPARENT.repeat(Math.min(subtitleShiftRight, subtitleInnerWidth)) +
      subtitleQueue.toArray().map((wordObj) => wordObj.word).join(' ');

    let outBuf = COMPOSITE_TRANSPARENT.repeat(subtitleHorzPadding);
    let i = Math.max(0, subtitleFull.length - subtitleInnerWidth);
    while (i < subtitleFull.length) {
      const subChar = subtitleFull[i];
      if (subChar === COMPOSITE_TRANSPARENT) {
        outBuf += COMPOSITE_TRANSPARENT;
      } else {
        outBuf += SUB_FG + SUB_BG + subChar;
      }
      ++i;
    }
    return outBuf;
  };
  const tmiMessageQueue = new denque();
  const tmiMessageHandler = (channel, userstate, message, self) => {
    if (self || channel !== twitchConnection.streamInfo.ircName) return;
    switch (userstate['message-type']) {
      case 'action':
      case 'chat':
        tmiMessageQueue.push({userstate: {...userstate}, message});
        // console.log(`${userstate['display-name']}: ${message}`);
        break;
    }
  };
  // const CHAT_LEFT = CHAT_BG_PURPLE + ' ' + CHAT_BG_BLACK;
  // const CHAT_LEFT_SIZE = 1;
  const CHAT_LEFT = CHAT_BG_BLACK;
  const CHAT_LEFT_SIZE = 0;
  const formatChatMessage = (userstate, message) => {
    const outLines = [];
    let outLineBuffer = CHAT_LEFT;
    let outLineIndex = CHAT_LEFT_SIZE;

    const wrapHard = (msg, color=CHAT_FG_WHITE) => {
      outLineBuffer += color;
      for (const msgChar of msg) {
        const msgCharWidth = stringWidth(msgChar);
        if ((outLineIndex + msgCharWidth) > chatWidth) {
          outLineBuffer += ' '.repeat(chatWidth - outLineIndex);
          outLines.push(outLineBuffer);
          outLineBuffer = CHAT_LEFT + color;
          outLineIndex = CHAT_LEFT_SIZE;
        }
        outLineBuffer += msgChar;
        outLineIndex+= msgCharWidth;
      }
    };
    const finishMessage = () => {
      if (outLineIndex > CHAT_LEFT_SIZE) {
        outLineBuffer += ' '.repeat(chatWidth - outLineIndex);
        outLines.push(outLineBuffer);
      }
    };
    const userColorsRandom = new Map();
    const getUserColor = () => {
      if (userstate['color'] && userstate['color'].match(/^#[0-9a-f]{6}$/i)) {
        return ANSIRGB24_FG(
            Number.parseInt(userstate['color'].substr(1, 2), 16),
            Number.parseInt(userstate['color'].substr(3, 2), 16),
            Number.parseInt(userstate['color'].substr(5, 2), 16),
        );
      } else {
        if (!userColorsRandom.has(userstate['name'])) {
          userColorsRandom.set(userstate['name'], ANSIRGB24_FG(
              (Math.random() * 256)|0,
              (Math.random() * 256)|0,
              (Math.random() * 256)|0,
          ));
        }
        return userColorsRandom.get(userstate['name']);
      }
    };
    const getUserBadges = () => {
      const result = [];
      if (userstate['badges']) {
        if (userstate['badges']['broadcaster']) result.push(['📽', `${ANSIRGB24_BG(233, 25, 22)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['moderator']) result.push(['⚔', `${ANSIRGB24_BG(0, 173, 3)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['vip']) result.push(['♦', `${ANSIRGB24_BG(224, 5, 185)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['subscriber']) result.push(['★', `${ANSIRGB24_BG(89, 57, 154)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['partner']) result.push(['✓', `${ANSIRGB24_BG(145, 70, 255)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['premium']) result.push(['♛', `${ANSIRGB24_BG(0, 160, 214)}${ANSIRGB24_FG(255, 255, 255)}`]);
        if (userstate['badges']['turbo']) result.push(['↯', `${ANSIRGB24_BG(89, 57, 154)}${ANSIRGB24_FG(255, 255, 255)}`]);
      }
      return result;
    };

    const userColor = getUserColor();
    const userBadges = getUserBadges();

    for (const [sym, color] of userBadges) wrapHard(sym, color);
    if (userBadges.length > 0) wrapHard('', CHAT_BG_BLACK);

    wrapHard(userstate['display-name'] || userstate['name'], userColor);
    wrapHard(': ');
    wrapHard(message);
    finishMessage();

    return outLines;
  };
  twitchConnection.tmiClient.on('message', tmiMessageHandler);
  const channelName = `${twitchConnection.streamInfo.display_name}`;
  const titleWidth = innerWidth - stringWidth(channelName);
  const title = ` ${twitchConnection.streamInfo.status}`.slice(0, titleWidth);
  const titleRow = `${CHAT_BG_PURPLE}${CHAT_FG_WHITE}${channelName}${CHAT_BG_BLACK}${title}${' '.repeat(titleWidth - title.length)}`;

  const sideRowsShiftIn = new denque();
  let sideRowsShiftInCount = 0;

  const sideRows = new denque(Array(innerHeight).fill(CHAT_LEFT + ' '.repeat(chatWidth - CHAT_LEFT_SIZE)));
  const sideTitle = `${CHAT_BG_PURPLE}${CHAT_FG_WHITE}${`Twitch for DOS`.padStart(chatWidth, ' ')}`;

  consumeSubtitleStream();
  for await (const [frameStats, frameData] of frameGenerator) {
    // c->pts_rel, c->duration, c->buffer_ticks, c->canonical_pts_rel, c->canonical_duration, c->stats_delay, c->lag_skipahead, c->count_reclock, c->reclock_drift, c->count_backwards, c->count_guess, c->count_skip
    const [framePts, frameDuration, bufferTicks, canonicalFramePts, canonicalFrameDuration] = frameStats;
    subtitleSyncPts = canonicalFramePts;
    const frameDataInner = frameData.split('\n').slice(0, innerHeight);

    if (sideRowsShiftIn.isEmpty()) {
      if (!tmiMessageQueue.isEmpty()) {
        const {userstate, message} = tmiMessageQueue.peekFront();
        tmiMessageQueue.shift();
        const messageLines = formatChatMessage(userstate, message);
        for (const messageLine of messageLines) {
          sideRowsShiftIn.push(messageLine);
        }
      }
      // else do nothing
    } else {
      // TODO: sync to frame rate
      sideRows.push(sideRowsShiftIn.peekFront());
      sideRowsShiftIn.shift();
      sideRows.shift();
    }
    const frameDataOut = [titleRow + sideTitle,
      ...frameDataInner.map((row, i) => row + sideRows.peekAt(i)),
      '',
    ].join('\n');
    const subData = renderSubtitles();
    const frameWithSubs = compositeFrameFast(subData, frameDataOut, subtitleShiftVert);
    yield [[...frameStats, subtitleSyncDelay], frameWithSubs];
  }
  twitchConnection.tmiClient.removeListener('message', tmiMessageHandler);
};

/**
 * @typedef {Object} TwitchConnection
 * @property {Object} tmiClient
 * @property {StreamInfo} streamInfo
 */
/**
 * Connect to given twitch stream
 * @return {TwitchConnection}
 * @param {String} channelName
 */
const twitchConnect = async (channelName) => {
  const streamInfo = await twitchGetChannelInfo(channelName);
  const tmiClient = new tmi.Client({
    connection: {
      secure: true,
      reconnect: true,
    },
    channels: [streamInfo.ircName],
  });
  await tmiClient.connect();
  return {
    tmiClient,
    streamInfo,
  };
};

/**
 * @typedef {Object} StreamInfo
 * @property {String} name
 * @property {String} display_name
 * @property {String} status
 */
/**
 * Get stream info
 * @return {StreamInfo} stream info
 * @param {String} channelName
 */
const twitchGetChannelInfo = async (channelName) => {
  const usersResponse = await twitchAPIRequest('users', {login: channelName});
  if (usersResponse._total && usersResponse._total === 1 && usersResponse.users &&
      usersResponse.users[0] && usersResponse.users[0]._id) {
    const userInfo = usersResponse.users[0];
    const streamInfo = await twitchAPIRequest(`streams/${userInfo._id}`);
    if (streamInfo.stream && streamInfo.stream.channel && streamInfo.stream.channel.status &&
      streamInfo.stream.channel.name && streamInfo.stream.channel.display_name) {
      return {
        name: streamInfo.stream.channel.name,
        ircName: `#${streamInfo.stream.channel.name.toLowerCase()}`,
        display_name: streamInfo.stream.channel.display_name,
        status: streamInfo.stream.channel.status,
      };
    } else {
      throw new Error(`Streams for ${channelName} not found`);
    }
  } else {
    throw new Error(`User ${channelName} not found`);
  }

};

const twitchAPIRequest = async (endpoint, params = {}) => {
  const response = await axios({
    method: 'get',
    url: `https://api.twitch.tv/kraken/${endpoint}`,
    params,
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Accept': 'application/vnd.twitchtv.v5+json',
    },
  });
  return response.data;
};

module.exports = {
  twitchConnect,
  twitchUI,
};
