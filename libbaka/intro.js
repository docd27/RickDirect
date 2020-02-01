const
  denque = require('denque'),
  stringWidth = require('string-width');

const ANSI_RESET = '\x1B[0m';
const ANSIRGB24_FG = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const ANSIRGB24_BG = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

const FB_DEFAULT = ANSIRGB24_BG(0, 0, 0) + ANSIRGB24_FG(255, 255, 255);

const FB_LOGO = ANSIRGB24_BG(119, 44, 232) + ANSIRGB24_FG(239, 239, 241);

const FB_CURSOR_ON = '_';
const FB_CURSOR_OFF = ' ';
const FB_CURSOR_ON_LENGTH = stringWidth(FB_CURSOR_ON);
const FB_CURSOR_OFF_LENGTH = stringWidth(FB_CURSOR_OFF);
const FB_CURSOR_INTERVAL = 200000n;

/**
 *
 * @return {AsyncGeneratorFunction}
 * @param {Number} frameInterval usecs
 * @param {Number} screenWidth
 * @param {Number} screenHeight
 */
const introGenerator = (channelName, frameInterval = 33333n, screenWidth=80, screenHeight = 24) => async function* () {
  const frameBuffer = new denque();
  let frameBufferHeight = 0;
  let lineBufferWidth = 0;
  let lineBuffer = FB_DEFAULT; // length must be less than screenWidth - cursorWidth
  const FB_BLANK_LINE = FB_DEFAULT + ' '.repeat(screenWidth);
  const LOGO_BLANK_LINE = FB_LOGO + ' '.repeat(screenWidth);

  const drawFrameBuffer = (cursorOn = true) => {
    const result = [...frameBuffer.toArray(),
      lineBuffer + FB_DEFAULT + (cursorOn ? FB_CURSOR_ON : FB_CURSOR_OFF) +
      ' '.repeat(screenWidth - lineBufferWidth - (cursorOn ? FB_CURSOR_ON_LENGTH : FB_CURSOR_OFF_LENGTH))];
    while (result.length < screenHeight) result.push(FB_BLANK_LINE);
    return result.join('\n') + '\n';
  };
  const drawType = (msg) => {
    lineBuffer += msg;
    lineBufferWidth += stringWidth(msg);
  };
  const drawLineFeed = () => {
    frameBuffer.push(lineBuffer + FB_DEFAULT + ' '.repeat(screenWidth - lineBufferWidth));
    frameBufferHeight++;
    if (frameBufferHeight === screenHeight) {
      frameBuffer.shift();
      frameBufferHeight--;
    }
    lineBuffer = FB_DEFAULT;
    lineBufferWidth = 0;
  };
  const drawClear = () => {
    frameBuffer.clear();
    frameBufferHeight = 0;
    lineBuffer = FB_DEFAULT;
    lineBufferWidth = 0;
  };

  let pts = 0n;
  const renderIdle = async function* (timeMS) {
    const time = timeMS * 1000n;
    const endPts = pts + time;
    while (pts < endPts) {
      yield [[pts, frameInterval, 0n], drawFrameBuffer((pts / FB_CURSOR_INTERVAL) % 2n === 0n)];
      pts += frameInterval;
    }
  };
  const renderType = async function* (timeMS, msg) {
    // Animation completes on the frame after
    const time = timeMS * 1000n;
    const endPts = pts + time;
    const msgParts = [...msg];
    const frameCount = Number(time / frameInterval) | 0;
    if (frameCount > 0) {
      const chunkSize = (msgParts.length / frameCount);
      let chunkIndex = 0;
      while (pts < endPts) {
        drawType(msgParts.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize).join(''));
        yield [[pts, frameInterval, 0n], drawFrameBuffer((pts / FB_CURSOR_INTERVAL) % 2n === 0n)];
        chunkIndex++;
        pts += frameInterval;
      }
      drawType(msgParts.slice(frameCount * chunkSize).join(''));
    } else {
      drawType(msg);
    }
  };
  const drawSlice = (slices, sliceWidth, padTop, shift) => {
    const result = [...Array(padTop).fill(LOGO_BLANK_LINE)];
    const centerPadLeft = ((screenWidth - sliceWidth) / 2) | 0;
    const centerPadRight = (screenWidth - sliceWidth - centerPadLeft);
    const padL = ' '.repeat(centerPadLeft);
    const padR = ' '.repeat(centerPadRight);
    let i = 0;
    for (const slice of slices) {
      const sliceStr = (i%2 === 0) ?
        (padL + ' '.repeat(shift) + slice.padEnd(sliceWidth, ' ') + padR).slice(0, screenWidth) :
        (padL + slice.padEnd(sliceWidth, ' ') + ' '.repeat(shift) + padR).slice(-screenWidth);
      result.push(FB_LOGO + sliceStr);
      i++;
    }
    while (result.length < screenHeight) result.push(LOGO_BLANK_LINE);
    return result.join('\n') + '\n';
  };
  const renderSlice = async function* (timeMS, idleTimeMS, slices, sliceWidth, padTop = 4, shiftFrom = 80) {
    const time = timeMS * 1000n;
    const endPts = pts + time;
    const frameCount = Number(time / frameInterval) | 0;
    let shiftCurrent = shiftFrom;
    if (frameCount > 0) {
      const shiftSize = (shiftFrom / frameCount);
      while (pts < endPts) {
        yield [[pts, frameInterval, 0n], drawSlice(slices, sliceWidth, padTop, shiftCurrent | 0)];
        shiftCurrent -= shiftSize;
        pts += frameInterval;
      }
    }
    const idleEndPts = pts + (idleTimeMS * 1000n);
    while (pts < idleEndPts) {
      yield [[pts, frameInterval, 0n], drawSlice(slices, sliceWidth, padTop, 0)];
      pts += frameInterval;
    }
  };
  yield* renderType(100n, 'Award Modular BIOS 1.04, An Energy Star Ally');
  drawLineFeed();
  yield* renderType(100n, 'Copyright (C) 1984, 1985 Award Software, Inc.');
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, '#401A0-0207');
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, 'Intel (R) 80386 AT/386 System');
  drawLineFeed();
  drawLineFeed();
  yield* renderIdle(500n);
  yield* renderType(100n, '07808 KB OK');
  yield* renderIdle(500n);
  drawLineFeed();
  yield* renderType(100n, '128KB BIOS SHADOW RAM ENABLED');
  drawLineFeed();
  drawLineFeed();
  drawLineFeed();
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, '       (C) 1984 American Megatrends Inc.,');
  drawLineFeed();
  yield* renderIdle(500n);
  drawClear();
  const infoBox = `╔═════════════════════════════════════════════════════════════════════════╗
║ System Configuration (C) Copyright 1984, 1985 American Megatrends Inc.  ║
╠════════════════════════════════════╤════════════════════════════════════╣
║ Main Processor     : 80386         │ Base Memory Size   : 640 KB        ║
║ Numeric Processor  : Present       │ Ext. Memory Size   : 7168 KB       ║
║ Floppy Drive A:    : 1.44 MB, 3½"  │ Hard Disk C: Type  : None          ║
║ Floppy Drive B:    : None          │ Hard Disk D: Type  : None          ║
║ Display Type       : VGA or EGA    │ Serial Port(s)     : 3F8,2F8       ║
║ ROM-BIOS Date      : 08/30/85      │ Parallel Port(s)   : 378           ║
╚════════════════════════════════════╧════════════════════════════════════╝
`.split('\n');
  for (const infoLine of infoBox) {
    yield* renderType(50n, infoLine);
    drawLineFeed();
  }
  yield* renderType(100n, 'Starting MS-DOS...');
  drawLineFeed();
  drawLineFeed();
  yield* renderIdle(500n);
  drawType('MS-DOS 1.0');
  drawLineFeed();
  drawLineFeed();
  drawType('A>');
  yield* renderIdle(500n);
  yield* renderType(1000n, 'TWITCH.EXE');
  yield* renderIdle(500n);
  yield* renderType(1000n, ' /C ' + channelName);
  yield* renderIdle(500n);
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, 'Twitch for DOS v1.2');
  drawLineFeed();
  yield* renderType(100n, 'Copyright Twitch Software Ltd.');
  drawLineFeed();
  yield* renderIdle(500n);
  drawLineFeed();
  yield* renderType(100n, 'Detecting devices... ');
  yield* renderType(100n, 'Done');
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, 'Connection provided by America Online (c) Inc.');
  drawLineFeed();
  yield* renderType(100n, 'Phone billed at your local rate. Proceed (Y/N)? ');
  yield* renderIdle(500n);
  yield* renderType(100n, 'Y');
  yield* renderIdle(500n);
  drawLineFeed();
  drawLineFeed();
  yield* renderType(100n, 'Dialling... ');
  const number = '012452931023';
  for (const num of number) {
    yield* renderType(50n, num);
  }
  drawLineFeed();
  drawLineFeed();
  yield* renderIdle(500n);
  yield* renderType(100n, 'Establishing Connection... ');
  drawLineFeed();
  drawLineFeed();
  yield* renderIdle(500n);
  const twitchStatus = `Loading ${channelName}`;
  const twitchLogoWidth = 60;
  const twitchLogo=
`███████                ████████████          ████████      ™
█    ████▄▄▄▄▄▄▄▄▄▄▄▄▄▄██   ██   ██▄▄▄▄▄▄▄▄████    ██▄▄▄
█       █    █    █    ██   ██       ███      █         █▄▄
█       █    █    █    ██   ██       █        █           █
█    ████    █    █    ██   ██   █████    █████    ███    █
█    ████    █    █    ██   ██   █████    █████    ███    █
█       █              ██   ██       █        █    ███    █
 ██     █            ████   ████     ███      █    ███    █
   ████████████████████████████████████████████████████████

                     Twitch for MS-DOS
                       Copyright 1984

` + ' '.repeat((twitchLogoWidth - twitchStatus.length)/2) + twitchStatus;
  const twitchSlices = twitchLogo.split('\n');
  yield* renderSlice(1500n, 2000n, twitchSlices, twitchLogoWidth, 4, 40);
  drawClear();
};


module.exports = {
  introGenerator,
};
