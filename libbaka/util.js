const
  process = require('process'),
  fs = require('fs'),
  zlib = require('zlib'),
  {once, EventEmitter} = require('events'),
  util = require('util'),
  stream = require('stream');

/**
 * Resolve after delay
 * @param {Number} duration timeout in ms
 * @return {Promise} that resolves after given @param duration
 */
const delayPromise = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

/**
 * Resolves a promise with a timeout
 * @param {Promise} promise promise to resolve
 * @param {Number} duration timeout in ms
 * @param {*} valueOnTimeout value to resolve if timeout occured
 * @return {Promise} That resolves @param promise or @param valueOnTimeout
 */
const timeoutPromise = (promise, duration, valueOnTimeout) => {
  let timerID = 0;
  return Promise.race([
    new Promise((resolve) => timerID = setTimeout(() => resolve(valueOnTimeout), duration)),
    promise.then((result) => {
      clearTimeout(timerID); return result;
    })]);
};

/**
 * Attach multiple consumers to one frame source
 */
class FrameEmitterMulti extends EventEmitter {
  /**
   * Create new FrameEmitterMulti
   */
  constructor() {
    super();
    this._run = false;
    this._curFrame = null;
    this._frameGenTimer = 0;
  }
  /**
   * Run and start consuming frames
   * @param {AsyncGenerator} frameSource frame source
   */
  async run(frameSource) {
    for await (const frame of frameSource) {
      if (this._frameGenTimer) {
        clearTimeout(this._frameGenTimer);
        this._frameGenTimer = 0;
      }
      this._curFrame = frame;
      this._run = true;
      this._frameGenTimer = setTimeout(() => {
        this._frameGenTimer = 0;
        this.emit('frame');
      });
      // await delayPromise(0);
    }
    this._run = false;
    this._frameGenTimer = setTimeout(() => {
      this._frameGenTimer = 0;
      this.emit('frame');
    });
  }
  /**
   * @return {AsyncGeneratorFunction} yielding current frames
   */
  async* output() {
    if (!this._run) { // Attached before run()
      await once(this, 'frame');
    }
    while (this._run) {
      yield this._curFrame;
      await once(this, 'frame');
    }
  }
}


const SLEEP_MIN_USEC = 1000;
/**
 * Synchronises to frame source, skipping frames to maintain framerate and optionally delaying when too fast
 * @param {AsyncGenerator} frameGenerator frame source
 * @param {Boolean} syncWait whether to wait until frame timestamps (delay)
 * @return {AsyncGeneratorFunction} synchronised frame generator
 */
const frameSync = (frameGenerator, syncWait = true, skipPts = null) => async function* () {
  /**
   * ffmpeg-libbaka gives us the following guarantees
   *    - presentation timestamps will be monotonic,
   *    - pts0 + d0 = pts1 for all frames, since we reclock VFR frames
   */

  // c->pts_rel, c->duration, c->buffer_ticks, c->canonical_pts_rel, c->canonical_duration, c->stats_delay, c->lag_skipahead, c->count_reclock, c->reclock_drift, c->count_backwards, c->count_guess, c->count_skip
  let firstFrameTicks = 0n, firstFramePts = 0n;
  let lastPresentTime = 0n;
  let lagSkipAhead = 0n;
  let countSkipped = 0n;
  let statDelay = 0n;

  let ticksDts, ticksPtsStart, ticksPtsEnd;

  for await (const frame of frameGenerator) {
    const [[framePts, frameDuration, bufferDuration]] = frame;
    if (skipPts && framePts < skipPts) continue;

    ticksDts = getMicroTickCount();
    const [frameStats, frameData] = frame;
    const framePtsRel = framePts - firstFramePts;


    if (firstFrameTicks && (lagSkipAhead >= frameDuration) && (
      (ticksDts - firstFrameTicks) + lastPresentTime > framePtsRel + frameDuration
    )) { // Skip this frame
      countSkipped++;
      lagSkipAhead -= frameDuration;
      statDelay = (ticksDts - firstFrameTicks) - framePtsRel;
    } else {
      // Can present
      if (syncWait && firstFrameTicks) {
        const ticksSleep = (framePtsRel + frameDuration) - (ticksDts - firstFrameTicks + lastPresentTime);
        if (ticksSleep >= SLEEP_MIN_USEC) {
          await delayPromise(Number(ticksSleep / 1000n));
        }
      }

      ticksPtsStart = getMicroTickCount();
      yield [[...frameStats, statDelay, countSkipped], frameData];
      ticksPtsEnd = getMicroTickCount();

      lastPresentTime = ticksPtsEnd - ticksPtsStart;

      if (!firstFrameTicks) {
        firstFrameTicks = ticksPtsEnd;
        firstFramePts = framePts;
      }

      const frameLag = lastPresentTime;
      if (frameLag > frameDuration) { // This frame took too long to present, add to skipahead
        lagSkipAhead += frameLag - frameDuration;
      }

      statDelay = (ticksPtsEnd - firstFrameTicks) - (framePtsRel + frameDuration);
    }
  }
};


const streamFinished = util.promisify(stream.finished);
const FRAME_END_ETB = '\x17';

/**
 * Emits frames terminated by ETB chars
 * @param {ReadableStream} inputStream Stream of frames
 * @return {AsyncGeneratorFunction} Frame data
 */
const frameGeneratorStream = (inputStream) => async function* () {
  let inputBuffer = '';
  // if (inputStream.isTTY) {
  //   inputStream.setRawMode(true);
  //   inputStream.resume();
  // }
  inputStream.setEncoding('utf8');
  for await (let inputChunk of inputStream) {
    while (true) {
      let i = 0;
      for (; i < inputChunk.length && inputChunk[i] !== FRAME_END_ETB; i++);
      if (i < inputChunk.length) { // ETB at inputChunk[i]
        inputBuffer += inputChunk.slice(0, i);

        let j = 0;
        for (; j < inputBuffer.length && inputBuffer[j] !== '\n'; j++);
        if (j < inputBuffer.length) {
          // First \n at inputBuffer[j]
          const frameHeader = inputBuffer.slice(0, j).split(',').map(BigInt);
          const frameData = inputBuffer.slice(j+1);
          yield [frameHeader, frameData];
        } else {
          // Malformed frame;
        }
        inputBuffer = '';

        // inputChunk may have further ETBs, continue
        inputChunk = inputChunk.slice(i+1);
      } else {
        inputBuffer += inputChunk;
        break; // exit while and await next chunk
      }
    }
  }
};

const chunkTermString = (strInput) => function* () {
  const iterator = strInput[Symbol.iterator]();
  let inEscape = false;
  let chunk = '';
  while (true) {
    const next = iterator.next();
    if (next.done) break;
    const char = next.value;
    chunk += char;
    if (inEscape) {
      switch (char) {
        case 'm': case 'f': case 'l': case 'h':
          inEscape = false;
      }
    } else {
      if (char === '\x1B') {
        inEscape = true;
      } else {
        yield chunk;
        chunk = '';
      }
    }
  }
  if (chunk !== '') yield chunk;
};

const COMPOSITE_TRANSPARENT = '\x1C';
const compositeFrame = (foreground, background) => {
  const foregroundRows = foreground.split('\n');
  const backgroundRows = background.split('\n');
  const outputRows = [];
  for (let y = 0; y < backgroundRows.length; y++) {
    if (y >= foregroundRows.length) {
      outputRows.push(backgroundRows[y]);
    } else {
      const bIt = chunkTermString(backgroundRows[y])();
      const fIt = chunkTermString(foregroundRows[y])();
      let fNext = null;
      let oRow = '';
      while (true) {
        const bNext = bIt.next();
        if (bNext.done) break;
        if (!fNext || !fNext.done) fNext = fIt.next();
        if (!fNext.done && fNext.value !== COMPOSITE_TRANSPARENT) {
          oRow += fNext.value;
        } else {
          oRow += bNext.value;
        }
      }
      outputRows.push(oRow);
    }
  }
  return outputRows.join('\n');
};

/**
 * Faster version of compositeFrame() that
 * @return {String} composited
 * @param {String} foreground
 * @param {String} background
 * @param {Number} shiftY
 */
const compositeFrameFast = (foreground, background, shiftY = 0) => {
  const foregroundRows = foreground.split('\n');
  const backgroundRows = background.split('\n');
  const outputRows = [];
  for (let y = 0; y < backgroundRows.length; y++) {
    if (y < shiftY || y >= (shiftY + foregroundRows.length)) {
      outputRows.push(backgroundRows[y]);
    } else {
      const bRow = backgroundRows[y];
      const fRow = foregroundRows[y - shiftY];
      let bPos = 0;
      let fPos = 0;
      let bInEscape = false;
      let fInEscape = false;
      let bChunk = '';
      let fChunk = '';
      let oRow = '';
      while (bPos < bRow.length) {
        if (fPos < fRow.length) {
          while (bPos < bRow.length) {
            const bChar = bRow[bPos];
            bChunk += bChar;
            bPos++;
            if (bInEscape) {
              switch (bChar) {
                case 'm': case 'f': case 'l': case 'h':
                  bInEscape = false;
              }
            } else {
              if (bChar === '\x1B') {
                bInEscape = true;
              } else {
                break;
              }
            }
          } // POST: bChunk is next chunk

          while (fPos < fRow.length) {
            const fChar = fRow[fPos];
            fChunk += fChar;
            fPos++;
            if (fInEscape) {
              switch (fChar) {
                case 'm': case 'f': case 'l': case 'h':
                  fInEscape = false;
              }
            } else {
              if (fChar === '\x1B') {
                fInEscape = true;
              } else {
                break;
              }
            }
          } // POST: fChunk is next chunk

          if (fChunk !== COMPOSITE_TRANSPARENT) {
            oRow += fChunk;
          } else {
            oRow += bChunk;
          }
          bChunk = '';
          fChunk = '';
        } else {
          if (bChunk !== '') {
            oRow += bChunk;
            bChunk = '';
          }
          while (bPos < bRow.length) {
            oRow += bRow[bPos];
            bPos++;
          }
        }
      }
      outputRows.push(oRow);
    }
  }
  return outputRows.join('\n');
};

/**
 * Faster version of compositeFrame() that
 * @return {String} composited
 * @param {String} foreground
 * @param {String} background
 */
const compositeFrameUnrolled = (foreground, background) => {
  const foregroundRows = foreground.split('\n');
  const backgroundRows = background.split('\n');
  const outputRows = [];
  for (let y = 0; y < backgroundRows.length; y++) {
    if (y >= foregroundRows.length) {
      outputRows.push(backgroundRows[y]);
    } else {
      const bIterator = backgroundRows[y][Symbol.iterator]();
      const fIterator = foregroundRows[y][Symbol.iterator]();

      let bInEscape = false;
      let fInEscape = false;
      let bChunk = '';
      let fChunk = '';
      let oRow = '';

      let bNext = bIterator.next();
      let fNext = fIterator.next();

      while (!bNext.done) {
        if (!fNext.done) {
          while (!bNext.done) {
            const bChar = bNext.value;
            bChunk += bChar;
            bNext = bIterator.next();
            if (bInEscape) {
              switch (bChar) {
                case 'm': case 'f': case 'l': case 'h':
                  bInEscape = false;
              }
            } else {
              if (bChar === '\x1B') {
                bInEscape = true;
              } else {
                break;
              }
            }
          } // POST: bChunk is next chunk

          while (!fNext.done) {
            const fChar = fNext.value;
            fChunk += fChar;
            fNext = fIterator.next();
            if (fInEscape) {
              switch (fChar) {
                case 'm': case 'f': case 'l': case 'h':
                  fInEscape = false;
              }
            } else {
              if (fChar === '\x1B') {
                fInEscape = true;
              } else {
                break;
              }
            }
          } // POST: fChunk is next chunk

          if (fChunk !== COMPOSITE_TRANSPARENT) {
            oRow += fChunk;
          } else {
            oRow += bChunk;
          }
          bChunk = '';
          fChunk = '';
        } else {
          if (bChunk !== '') {
            oRow += bChunk;
            bChunk = '';
          }
          while (!bNext.done) {
            oRow += bNext.value;
            bNext = bIterator.next();
          }
        }
      }
      outputRows.push(oRow);
    }
  }
  return outputRows.join('\n');
};


const ANSI_CLEAR = '\x1B[0;0f\x1B[2J\x1B[0;0f';
const ANSI_ORIGIN = '\x1B[0;0f';
const ANSI_RESET = '\x1B[0m';
const ANSI_CURSOROFF = '\x1b[?25l';
const ANSI_CURSORON = '\x1b[?25h';
const FRAME_START = ANSI_RESET + ANSI_CURSOROFF + ANSI_ORIGIN;
const FRAME_END = ANSI_CURSORON + ANSI_RESET;


const formatInt64 = (digits, x) => x < 0 ?
  '-'+(-x).toString().padStart(digits, '0') :
  '+'+x.toString().padStart(digits, '0');

/**
 *
 * @return {void}
 * @param {AsyncGenerator} frameGenerator
 * @param {WritableStream} outputStream
 * @param {Boolean} debugHeader
 */
const terminalFrameWriter = async (frameGenerator, outputStream, debugHeader = false) => {
  const debugInt64 = formatInt64.bind(null, 10);
  outputStream.setDefaultEncoding('utf8');
  outputStream.write(ANSI_CLEAR); // full clear
  for await (const [frameHeader, frameData] of frameGenerator) {
    outputStream.write(FRAME_START);
    if (debugHeader) {
      outputStream.write(frameHeader.map(debugInt64).join(', '));
      outputStream.write('\n\n');
    }
    outputStream.write(frameData);
    outputStream.write(FRAME_END);
  }
  outputStream.done();
};



/**
 *
 * @return {void}
 * @param {AsyncGenerator} frameGenerator
 * @param {BufferedFrameWriter} outputWriter
 */
const frameWriter = async (frameGenerator, outputWriter) => {
  for await (const [frameHeader, frameData] of frameGenerator) {
    await outputWriter.writeFrame(frameHeader, frameData);
  }
  await outputWriter.done();
};

/**
 * @typedef {Object} AsyncFrameWriter
 * @property {Function} writeFrame async (frameData): write framedata
 * @property {Function} done async (): close the file
 */
/**
 * Returns a FrameWriter bound to the given output stream
 * @param {WritableStream} outputStream stream to write to
 * @return {AsyncFrameWriter} for writing frame data
 */
const frameWriterStreamAsync = (outputStream) => {
  outputStream.setDefaultEncoding('utf8');
  return {
    writeFrame: async (frameHeader, frameData) => {
      if (!outputStream.write(frameHeader.map(writeInt64).join(',') +
      '\n' + frameData + FRAME_END_ETB, 'utf8')) {
        // Wait for output buffer to drain
        await once(outputStream, 'drain');
      }
    },
    done: async () => {
      outputStream.end();
      // Wait until flushed
      await streamFinished(outputStream);
    },
  };
};


const writeInt64 = (x) => x < 0 ?
  '-'+(-x).toString().padStart(19, '0') :
  '+'+x.toString().padStart(19, '0');

/**
 * @typedef {Object} BufferedFrameWriter
 * @property {Function} write (frameData): write framedata
 * @property {Function} done (): close the file
 */
/**
 * Returns a FrameWriter bound to the given output stream
 * @param {WritableStream} outputStream stream to write to
 * @return {BufferedFrameWriter} for writing frame data
 */
const frameWriterStream = (outputStream) => {
  outputStream.setDefaultEncoding('utf8');
  return {
    writeFrame: (frameHeader, frameData) => outputStream.write(frameHeader.map(writeInt64).join(',') +
      '\n' + frameData + FRAME_END_ETB, 'utf8'),
    done: () => outputStream.end(),
  };
};

/**
 * Read gz file
 * @param {String} filepath path to .gz file
 * @return {ReadableStream} with no encoding set (binary)
 */
const gunzipFileStream = (filepath) => {
  if (!fs.existsSync(filepath)) throw new Error(`File ${filepath} not found`);
  const inFile = fs.createReadStream(filepath, {autoClose: true, emitClose: true});
  return inFile.pipe(zlib.createGunzip(), {end: true});
};

/**
 * Write gz file
 * @param {String} filepath path to .gz file
 * @return {WriteableStream} filepath with no encoding set (binary)
 */
const gzipFileStream = (filepath) => {
  const outFile = fs.createWriteStream(filepath, {flags: 'w', autoClose: true, emitClose: true});
  const gzipStream = zlib.createGzip();
  gzipStream.pipe(outFile, {end: true});
  return gzipStream;
};

/**
 * Read file
 * @param {String} filepath path to .gz file
 * @return {ReadableStream} with no encoding set (binary)
 */
const inFileStream = (filepath) => {
  if (!fs.existsSync(filepath)) throw new Error(`File ${filepath} not found`);
  return fs.createReadStream(filepath, {autoClose: true, emitClose: true});
};

/**
 * Write file
 * @param {String} filepath path to .gz file
 * @return {WriteableStream} filepath with no encoding set (binary)
 */
const outFileStream = (filepath) => {
  return fs.createWriteStream(filepath, {flags: 'w', autoClose: true, emitClose: true});
};

const loadSubtitleData = (SUBTITLE_FILE = './subtitles.json') => {
  const parseTimecode = (timecode) => {
    const [minStr, secStr] = timecode.split(':');
    const secs = Number.parseFloat(secStr);
    const mins = Number.parseInt(minStr);
    const timeSecs = mins * 60 + secs;
    if (!Number.isFinite(timeSecs)) throw new Error('Invalid timecode');
    const frameIndex = BigInt(Math.trunc(timeSecs * 1000000));
    return frameIndex;
  };
  if (!fs.existsSync(SUBTITLE_FILE)) throw new Error('Subtitle data missing');
  const subtitleData = JSON.parse(fs.readFileSync(SUBTITLE_FILE, 'utf8'));
  for (let i = 0; i < subtitleData.length; i++) {
    subtitleData[i].pts = parseTimecode(subtitleData[i].time);
  }
  subtitleData.sort(({pts: a}, {pts: b}) => Number(a - b));
  return subtitleData;
};


const OBJECT_END_ETB = '\x17';

/**
 * Emits objects terminated by ETB chars
 * @param {ReadableStream} inputStream Stream of objects
 * @return {AsyncGeneratorFunction} Object data
 */
const objectReaderStream = (inputStream) => async function* () {
  let inputBuffer = '';
  // if (inputStream.isTTY) {
  //   inputStream.setRawMode(true);
  //   inputStream.resume();
  // }
  inputStream.setEncoding('utf8');
  for await (let inputChunk of inputStream) {
    while (true) {
      let i = 0;
      for (; i < inputChunk.length && inputChunk[i] !== FRAME_END_ETB; i++);
      if (i < inputChunk.length) { // ETB at inputChunk[i]
        inputBuffer += inputChunk.slice(0, i);

        let data = null;
        try {
          data = JSON.parse(inputBuffer);
        } catch {
          console.error(`objectReaderStream() : Malformed JSON: '${inputBuffer}'`);
          data = null;
        }
        if (data !== null) yield data;
        inputBuffer = '';

        // inputChunk may have further ETBs, continue
        inputChunk = inputChunk.slice(i+1);
      } else {
        inputBuffer += inputChunk;
        break; // exit while and await next chunk
      }
    }
  }
};


/**
 * @typedef {Object} BufferedObjectWriter
 * @property {Function} writeObject (object): write object
 * @property {Function} done (): close the stream
 */
/**
 * Returns a BufferedObjectWriter bound to the given output stream
 * @param {WritableStream} outputStream stream to write to
 * @return {BufferedObjectWriter} for writing objects
 */
const objectWriterStream = (outputStream) => {
  outputStream.setDefaultEncoding('utf8');
  return {
    writeObject: (data) => outputStream.write(JSON.stringify(data) + OBJECT_END_ETB, 'utf8'),
    done: () => outputStream.end(),
  };
};

/**
 * @typedef {Object} AsyncObjectWriter
 * @property {Function} writeObject async (frameData): write framedata
 * @property {Function} done async (): close the file
 */
/**
 * Returns a FrameWriter bound to the given output stream
 * @param {WritableStream} outputStream stream to write to
 * @return {AsyncObjectWriter} for writing frame data
 */
const objectWriterStreamAsync = (outputStream) => {
  outputStream.setDefaultEncoding('utf8');
  return {
    writeObject: async (data) => {
      if (!outputStream.write(JSON.stringify(data) + OBJECT_END_ETB, 'utf8')) {
        // Wait for output buffer to drain
        await once(outputStream, 'drain');
      }
    },
    done: async () => {
      outputStream.end();
      // Wait until flushed
      await streamFinished(outputStream);
    },
  };
};


const getMicroTickCount = () => process.hrtime.bigint() / 1000n;

const jsonStr = (obj, depth=6) => util.inspect(obj, {depth: depth, colors: true, compact: 3});

const json2 = (obj, depth=6) => {
  console.log(util.inspect(obj, {depth: depth, colors: true, compact: 3}));
};

module.exports = {
  FrameEmitterMulti,
  frameSync,
  frameGeneratorStream,
  terminalFrameWriter,
  frameWriter,
  frameWriterStream,
  frameWriterStreamAsync,
  gunzipFileStream,
  gzipFileStream,
  inFileStream,
  outFileStream,
  timeoutPromise,
  delayPromise,
  jsonStr,
  json2,
  getMicroTickCount,
  compositeFrame,
  compositeFrameFast,
  loadSubtitleData,
  COMPOSITE_TRANSPARENT,
  objectReaderStream,
  objectWriterStream,
  objectWriterStreamAsync,
};
