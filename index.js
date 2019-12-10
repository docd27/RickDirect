const {loadFrameData, loadSubtitleData} = require('./frame.js');
const express = require('express'), useragent = require('express-useragent');
const app = express();
const port = 6001;

const delayPromise = (duration) => new Promise((resolve) => setTimeout(resolve, duration));




(async () => {
  const subData = loadSubtitleData();
  const [frameInterval, frameData] = loadFrameData();
  const FRAME_INC = 4,
    FRAME_START = 30,
    FRAME_WIDTH = 120, MIN_WAIT = 10;
  console.log('Loaded frame data');
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
        if (subIndex < subData.length && i >= subData[subIndex].frameIndex) {
          lyric = subData[subIndex].text;
          subIndex++;
        }
        const lastIndex = (subIndex > 0 ? subData[subIndex-1].frameIndex : 0);
        const lyricPerc = subIndex < subData.length ? (i - lastIndex) / (subData[subIndex].frameIndex - lastIndex) : 0.5;
        console.log(`${lyric} + ${lyricPerc.toFixed(2)}`);
        response.write('\n\n' + ' '.repeat((FRAME_WIDTH - lyric.length)/2|0) + lyric + '\n\n' + frameData[i].data + '\n\n');
        const drift = (i - FRAME_START) * frameInterval - (Date.now() - startTime);
        const timeToWait = frameInterval * FRAME_INC + drift;
        if (timeToWait > MIN_WAIT) await delayPromise(timeToWait);
      }

      response.end();
    } else {
      console.log(`Request from ${request.useragent}`);
      response.send(`Nothing to see here, please move along.`);
    }
  });

  app.listen(port, 'localhost', () => console.log(`Example app listening on port ${port}!`));
})();




