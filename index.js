const {loadFrameData} = require('./frame.js');
const express = require('express'), useragent = require('express-useragent');
const app = express();
const port = 6001;

const delayPromise = (duration) => new Promise((resolve) => setTimeout(resolve, duration));




(async () => {
  const [frameInterval, frameData] = loadFrameData();
  const FRAME_INC = 4;
  const FRAME_START = 30;
  const FRAME_GAP = 4;
  const clearTop = Array(FRAME_GAP).fill('\n').join('');
  const clearBot = Array(2).fill('\n').join('');
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

      for (let i = FRAME_START; i < frameData.length; i+=FRAME_INC) {
        if (abortFlag) {
          console.log('Aborted playback loop');
          break;
        }
        response.write(clearTop + frameData[i].data + clearBot);
        await delayPromise(frameInterval * FRAME_INC);
      }

      response.end();
    } else {
      response.send(`Hello World!\n${JSON.stringify(request.useragent)}`);
    }
  });

  app.listen(port, 'localhost', () => console.log(`Example app listening on port ${port}!`));
})();




