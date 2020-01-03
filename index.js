const {loadFrameData, loadSubtitleData} = require('./frame.js');
const chalk = require('chalk');
const URL = require('url').URL;
const express = require('express'), useragent = require('express-useragent');
const app = express();
const port = 6001; // Listening port

const delayPromise = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

(async () => {
  const subData = loadSubtitleData();
  const [frameRate, frameInterval, frameWidth, frameData] = loadFrameData();
  const FRAME_INC = 1, // Jump this many frames at a time, so 25/4 = 6.25 fps. 1 would be full 25fps
    FRAME_START = 30, // Skip 30 frames of black at start of video
    MIN_WAIT = 10; // Smallest sleep/timeout is ~10ms on node
  const escClear = '\x1B[0;0f\x1B[2J\x1B[0;0f'; // Full clear and cursor to 0,0
  const escOrigin = '\x1B[0;0f'; // Cursor to 0,0
  console.log(`Loaded frame data, width: ${frameWidth} framerate: ${frameRate}`);
  app.use(useragent.express());
  app.get('*', async (request, response) => {
    if (request.useragent.isCurl) {
      response.setHeader('Connection', 'Transfer-Encoding');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Transfer-Encoding', 'chunked');
      response.status(200);
      let abortFlag = false;
      request.on('end', () => {
        abortFlag = true;
        console.log('Request Terminated');
      });
      request.on('close', () => {
        abortFlag = true;
        console.log('Request Closed');
      });
      response.on('end', () => {
        abortFlag = true;
        console.log('Response Terminated');
      });
      response.on('close', () => {
        abortFlag = true;
        console.log('Response Closed');
      });
      let subIndex = 0, lyric = '';
      const startTime = Date.now();
      for (let i = FRAME_START; i < frameData.length; i+=FRAME_INC) {
        if (abortFlag) {
          console.log('Aborted playback loop');
          break;
        }
        const clrEscape = (i === FRAME_START) ? escClear : escOrigin;
        if (subIndex < subData.length && i >= subData[subIndex].frameIndex) {
          lyric = ' ' + subData[subIndex].text + ' ';
          subIndex++;
        }
        const lastIndex = (subIndex > 0 ? subData[subIndex-1].frameIndex : 0);
        // Scrolling lyrics:
        const lyricPerc = subIndex < subData.length ?
          (i - lastIndex) / (subData[subIndex].frameIndex - lastIndex) : 0.5;
        const padLeft = (frameWidth - lyric.length)*(0.1 + 0.8 * (1 - lyricPerc))|0;
        const padRight = frameWidth - (lyric.length + padLeft);
        response.write(clrEscape + '\n\n' + ' '.repeat(padLeft) +
          chalk.reset.bold.black.bgWhiteBright(lyric) + ' '.repeat(padRight) +
          '\n\n' + frameData[i].data + '\n\n');
        // Wait between frames, correcting for drift:
        const drift = (i - FRAME_START) * frameInterval - (Date.now() - startTime);
        const timeToWait = frameInterval * FRAME_INC + drift;
        if (timeToWait > MIN_WAIT) await delayPromise(timeToWait);
      }
      if (!abortFlag) {
        response.write(escClear);
      }
      
      response.end();
      return;
    }
    if ((request.headers.referer && new URL(request.headers.referer).hostname.endsWith('twitch.tv')) ||
    // !(request.useragent.isDesktop && request.useragent.isChrome)
       !(request.useragent.isDesktop)
    ) {
      // FFZ, discord, bot request:
      console.log(`Bot Request from`);
      console.log(request.useragent);
      console.log(request.headers);
      response.redirect(302, 'https://twitter.com/coding_garden');
    } else {
      // Direct request from real browser:
      console.log(`Direct Request from`);
      console.log(request.useragent);
      console.log(request.headers);
      response.redirect(302, 'https://youtu.be/dQw4w9WgXcQ');
    }
  });

  app.listen(port, 'localhost', () => console.log(`App listening on port ${port}!`));
})();
