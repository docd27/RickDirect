const {
  frameGeneratorStream,
  jsonStr,
  json2,
  frameSync,
  FrameEmitterMulti,
  introGenerator,
  gunzipFileStream,
  twitchConnect,
  twitchUI,
  getMicroTickCount,
  compositeFrameFast,
  loadSubtitleData,
  COMPOSITE_TRANSPARENT,
} = require('./libbaka');

const
  URL = require('url').URL,
  express = require('express'),
  useragent = require('express-useragent'),
  compression = require('compression'),
  zlib = require('zlib');


const app = express();
const port = 6003; // Listening port

const ANSI_CLEAR = '\x1B[0;0f\x1B[2J\x1B[0;0f';
const ANSI_ORIGIN = '\x1B[0;0f';
const ANSI_RESET = '\x1B[0m';
const ANSI_BOLD = '\x1B[1m';
const ANSI_CURSOROFF = '\x1b[?25l';
const ANSI_CURSORON = '\x1b[?25h';

const OUTPUT_START = ANSI_CLEAR;
const FRAME_START = ANSI_RESET + ANSI_CURSOROFF + ANSI_ORIGIN;
// const FRAME_START = ANSI_RESET + ANSI_ORIGIN;
const FRAME_END = ANSI_CURSORON;
// const FRAME_END = '';
const OUTPUT_END = ANSI_CLEAR;

// const int64Digits = 19;
const int64Digits = 10;
const formatInt64 = (x) => x < 0 ?
  '-'+(-x).toString().padStart(int64Digits, '0') :
  '+'+x.toString().padStart(int64Digits, '0');

const estBlockSize = (width, height) =>
  width * height * (2 + 19 + 19) + // each pixel
  height * 1 + // newlines
  FRAME_START.length +
  FRAME_END.length +
  180; // Stats length

// const DO_INTRO = false;
// const RICKROLL_DELAY = 2000000n;

const DO_INTRO = true;
const RICKROLL_DELAY = 15000000n;


const RICKROLL_PATH = './data/rickroll.6523.etb.gz';
const RICKROLL_SKIP_PTS = 1200000n;
const RICKROLL_MAIN = RICKROLL_DELAY + 5000000n;

const program = require('commander');
// program.option('-v, --verbose', 'Verbose output');
// program.option('-d, --debug', 'Debug mode');
program.usage("[options] channel")
program.parse(process.argv);
if (program.args.length !== 1) {
  program.outputHelp();
  return;
}
const channelName = program.args[0];

const inputWidth = 65;
const inputHeight = 23;


const ANSIRGB24_FG = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const ANSIRGB24_BG = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;
const LYRIC_START = `${ANSIRGB24_FG(239, 239, 241)}${ANSIRGB24_BG(119, 44, 232)}`;

const MSG_START = `${ANSIRGB24_FG(255, 255, 255)}${ANSIRGB24_BG(166, 11, 0)}`;


(async () => {
  const subData = loadSubtitleData();

  const twitchConnection = await twitchConnect(channelName);

  const streamName = twitchConnection.streamInfo.display_name;

  const frameSource = frameSync(frameGeneratorStream(process.stdin)(), false)();

  const twitchUISource = twitchUI(frameSource, twitchConnection, inputWidth, inputHeight, 15)();

  const frameMulti = new FrameEmitterMulti();
  frameMulti.run(twitchUISource);

  app.use(useragent.express());
  app.use(compression({
    level: 4,
    chunkSize: estBlockSize(inputWidth, inputHeight),
    // strategy: zlib.Z_FILTERED,
  }));
  app.get('*', async (request, response) => {
    if (request.useragent.isCurl) {
      response.setHeader('Connection', 'Transfer-Encoding');
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Transfer-Encoding', 'chunked');
      response.status(200);
      let abortFlag = false;
      let rickFlag = 0;
      request.on('end', () => {
        abortFlag = true;
        // console.log('Request Terminated');
      });
      request.on('close', () => {
        abortFlag = true;
        // console.log('Request Closed');
      });
      response.on('end', () => {
        abortFlag = true;
        // console.log('Response Terminated');
      });
      response.on('close', () => {
        abortFlag = true;
        // console.log('Response Closed');
      });

      response.write(OUTPUT_START); // full clear
      const rickStream = frameGeneratorStream(gunzipFileStream(RICKROLL_PATH))();
      if (DO_INTRO) {
        const introOutput = frameSync(introGenerator(streamName)())();
        for await (const [, frameData] of introOutput) {
          if (abortFlag) break;
          response.write(FRAME_START + frameData + FRAME_END);
          response.flush();
        }
      }
      if (!abortFlag) {
        const frameOutput = frameSync(frameMulti.output(), false)();
        let rickOutput = null;
        let rickNext = null;

        const hsv2rgb = (h, s=0.5, v=1.0) => {
          const f = (n, k=(n+h/60)%6) => v - v*s*Math.max( Math.min(k, 4-k, 1), 0);
          return [f(5) * 255 | 0, f(3) * 255 | 0, f(1) * 255 | 0];
        };
        const hsvcol = (h, s=0.5, v=1.0) => {
          const [r1, g1, b1] = hsv2rgb(h, 0.75, 1.0);
          const [r2, g2, b2] = hsv2rgb((h + 180) % 360, 1.0, 1.0);
          return ANSIRGB24_BG(r1, g1, b1) + ANSIRGB24_FG(r2, g2, b2);
        };

        let subIndex = 0, lyric = '';
        const rainbowSpeed = 3 * 360; // Hue per second
        const rainbowWidth = 20;
        const rainbowPtsScale = rainbowSpeed / 1000000;
        const rainbowXScale = 360 / rainbowWidth;
        const renderSubtitle = (pts, frameWidth = 65) => {
          if (subIndex < subData.length && pts >= subData[subIndex].pts) {
            if (subData[subIndex].text) {
              lyric = ' ' + subData[subIndex].text + ' ';
            } else {
              lyric = '';
            }
            subIndex++;
          }
          if (lyric) {
            const lastPts = (subIndex > 0 ? subData[subIndex-1].pts : 0n);
            // Scrolling lyrics:
            const lyricPerc = subIndex < subData.length ?
              (Number(pts - lastPts) / Number(subData[subIndex].pts - lastPts)) : 0.5;
            const padLeft = (frameWidth - lyric.length)*(0.1 + 0.8 * (1 - lyricPerc))|0;
            // const padRight = frameWidth - (lyric.length + padLeft);
            // return COMPOSITE_TRANSPARENT.repeat(padLeft) + LYRIC_START + lyric + COMPOSITE_TRANSPARENT.repeat(padRight);
            let outBuf = COMPOSITE_TRANSPARENT.repeat(padLeft);
            let j = padLeft;
            outBuf += ANSI_BOLD;
            for (let i = 0; i < lyric.length; i++, j++) {
              const hPts = (Number(pts) * rainbowPtsScale) % 360;
              if (i === lyric.length - 1) outBuf += ANSI_RESET; // Reset to non bold, hack depends on last character being a space
              outBuf += hsvcol((hPts + (frameWidth - j) * rainbowXScale) % 360) + lyric[i];
            }
            return outBuf;
          } else {
            return '';
          }
        };

        const renderRickBox = (padLeft, padTop) => {
          const rickBoxTemplate = `╔══════════════════════════════════════╗
║ * * *    You have new mail!    * * * ║
╠══════════════════════════════════════╣
║ From    : Rick Astley                ║
║ Subject : Never Gonna Give You Up    ║
╟──────────────────────────────────────╢
║                   Opening Message... ║
╚══════════════════════════════════════╝`.split('\n');
          const outLines = Array(padTop).fill('');
          for (const line of rickBoxTemplate) {
            outLines.push(COMPOSITE_TRANSPARENT.repeat(padLeft) + MSG_START + line);
          }
          return outLines.join('\n');
        };
        const rickBox = renderRickBox(16, 8);

        const startTime = getMicroTickCount();

        for await (const [frameHeader, frameData] of frameOutput) {
          if (abortFlag) break;
          if (!rickFlag && getMicroTickCount() - startTime >= RICKROLL_DELAY) rickFlag = 1;
          switch (rickFlag) {
            case 1:
              if (getMicroTickCount() - startTime >= RICKROLL_MAIN) rickFlag = 2;
              rickNext = {value: [[0n], rickBox], done: false};
              break;
            case 2:
              if (!rickOutput) rickOutput = frameSync(rickStream, true, RICKROLL_SKIP_PTS)();
              if (!rickNext || !rickNext.done) rickNext = await rickOutput.next();
          }
          if (rickNext && !rickNext.done) {
            const [[rickPts], rickDataIn] = rickNext.value;
            const subData = renderSubtitle(rickPts);
            const rickData = compositeFrameFast(subData, rickDataIn, 21);
            const compData = compositeFrameFast(rickData, frameData, 1);
            response.write(
                FRAME_START +
                compData +
                FRAME_END);
          } else {
            response.write(
                FRAME_START +
                // frameHeader.map(formatInt64).join(', ') +
                // '\n\n' +
                frameData +
                FRAME_END);
          }
          response.flush();
        }
      }
      if (!abortFlag) {
        response.write(OUTPUT_END);
      } else {
        console.log('Aborted playback loop');
      }
      response.end();
      return;
    }
    if ((request.headers.referer && new URL(request.headers.referer).hostname.endsWith('twitch.tv')) ||
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
})().catch((err) => console.error(err));

